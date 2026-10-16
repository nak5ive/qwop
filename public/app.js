/* global planck, createRunner */
(() => {
  const $ = (s) => document.querySelector(s);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const api = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  };
  const fmtM = (d) => (d == null ? '—' : `${d.toFixed(1)} m`);
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  // ---------------- routing ----------------
  const m = location.pathname.match(/^\/r\/([A-Za-z]{4})/);
  if (!m) homeScreen();
  else roomScreen(m[1].toUpperCase());

  function homeScreen() {
    show($('#home'));
    $('#host-name').value = store.get('qwop:name') || '';
    $('#host-form').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('#host-name').value.trim();
      try {
        const r = await api('POST', '/api/rooms', { name });
        store.set('qwop:name', name);
        store.set(`qwop:${r.code}`, { playerId: r.playerId });
        store.set(`qwop-admin:${r.code}`, r.adminToken);
        location.href = `/r/${r.code}?admin=${r.adminToken}`;
      } catch (err) { $('#home-err').textContent = err.message; }
    };
    $('#code-form').onsubmit = (e) => {
      e.preventDefault();
      const code = $('#code-input').value.trim().toUpperCase();
      if (/^[A-Z]{4}$/.test(code)) location.href = `/r/${code}`;
      else $('#home-err').textContent = 'Room codes are 4 letters';
    };
  }

  async function roomScreen(code) {
    const params = new URLSearchParams(location.search);
    if (params.get('admin')) {
      store.set(`qwop-admin:${code}`, params.get('admin'));
      history.replaceState(null, '', `/r/${code}`); // keep the token out of screen shares
    }
    const adminToken = store.get(`qwop-admin:${code}`);
    let room;
    try { room = await api('GET', `/api/rooms/${code}`); } catch { return show($('#missing')); }

    const saved = store.get(`qwop:${code}`);
    if (saved && room.players.some((p) => p.id === saved.playerId)) return startGame(code, saved.playerId, adminToken);

    show($('#join'));
    $('#join-code').textContent = code;
    $('#join-name').value = store.get('qwop:name') || '';
    $('#join-name').focus();
    $('#join-form').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('#join-name').value.trim();
      try {
        const r = await api('POST', `/api/rooms/${code}/join`, { name, adminToken });
        store.set('qwop:name', name);
        store.set(`qwop:${code}`, { playerId: r.playerId });
        show($('#join'), false);
        startGame(code, r.playerId, adminToken);
      } catch (err) { $('#join-err').textContent = err.message; }
    };
  }

  // ---------------- game ----------------
  function startGame(code, playerId, adminToken) {
    show($('#game'));
    const canvas = $('#c');
    const ctx = canvas.getContext('2d');
    const isAdmin = !!adminToken;
    const inviteLink = `${location.origin}/r/${code}`;
    $('#room-code').textContent = code;

    let room = null;
    let clockOffset = 0; // serverNow - Date.now()
    const now = () => Date.now() + clockOffset;

    // Round bookkeeping (what we report to the server).
    let round = { id: -1, best: 0, attempts: 0 };
    let lastSent = '';
    let mode = 'practice';
    let goFlashUntil = 0;
    let resultsDismissedRound = -1;

    let runner = createRunner(planck);
    const keys = { q: false, w: false, o: false, p: false };

    function newRunner() {
      runner = createRunner(planck);
      camX = 0;
    }

    // ---------- server stream ----------
    const es = new EventSource(`/api/rooms/${code}/events?playerId=${playerId}`);
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data);
      clockOffset = s.serverNow - Date.now();
      const me = s.players.find((p) => p.id === playerId);
      if (!me) {
        // Kicked, or the room forgot us: go back to the join screen.
        es.close();
        store.set(`qwop:${code}`, null);
        location.reload();
        return;
      }
      if (s.phase === 'running' && s.round !== round.id) {
        // A new round, or we (re)loaded mid-round: carry over what the server has.
        round = { id: s.round, best: me.best || 0, attempts: me.attempts || 0 };
        if (now() < s.startsAt) newRunner();
      }
      const prevPhase = room && room.phase;
      room = s;
      if (s.phase === 'finished' && prevPhase !== 'finished' && prevPhase) resultsDismissedRound = -1;
      renderBoard();
      renderAdmin();
      renderResults();
    };

    // ---------- reporting ----------
    async function report(force) {
      if (!room || room.phase !== 'running' || round.id !== room.round) return;
      const t = now();
      if (t < room.startsAt || t > room.endsAt + 1000) return;
      const st = runner.state;
      const body = {
        playerId, round: round.id, best: round.best, attempts: round.attempts,
        cur: st.fallen ? null : Math.max(0, st.distance), fallen: st.fallen || st.finished,
      };
      const key = JSON.stringify([body.best.toFixed(2), body.cur == null ? null : body.cur.toFixed(1), body.attempts, body.fallen]);
      if (!force && key === lastSent) return;
      lastSent = key;
      try { await api('POST', `/api/rooms/${code}/score`, body); } catch { /* round ended; ignore */ }
    }
    setInterval(report, 350);

    // ---------- input ----------
    const keyEls = {};
    document.querySelectorAll('#keys button').forEach((b) => {
      const k = b.dataset.key;
      keyEls[k] = b;
      const set = (v) => (e) => { e.preventDefault(); keys[k] = v; };
      b.addEventListener('pointerdown', set(true));
      b.addEventListener('pointerup', set(false));
      b.addEventListener('pointerleave', set(false));
      b.addEventListener('pointercancel', set(false));
    });
    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k in keys) { keys[k] = true; e.preventDefault(); }
      if ((k === ' ' || k === 'r') && !e.repeat) { e.preventDefault(); restart(); }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = false;
    });
    window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

    function restart() {
      if (mode === 'countdown' || mode === 'timeup') return;
      if (mode === 'live' && !runner.state.fallen && !runner.state.finished) {
        round.attempts++; // bailing out of a run still counts as an attempt
      }
      newRunner();
    }

    // ---------- admin ----------
    if (isAdmin) {
      show($('#admin'));
      show(document.querySelector('#results .admin-only'));
      const admin = (action, extra) => api('POST', `/api/rooms/${code}/admin`, { token: adminToken, action, ...extra })
        .catch((e) => toast(e.message));
      // Two-click confirm for destructive buttons (no blocking dialogs mid-game).
      const confirmClick = (btn, fn, when) => {
        let armedAt = 0;
        const label = btn.textContent;
        btn.onclick = () => {
          if (when && !when()) return fn();
          if (Date.now() - armedAt < 3000) { armedAt = 0; btn.classList.remove('armed'); btn.textContent = label; return fn(); }
          armedAt = Date.now();
          btn.classList.add('armed');
          btn.textContent = 'Sure?';
          setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3000);
        };
      };
      const running = () => room && room.phase === 'running';
      const start = () => admin('start', { durationSec: Number($('#duration').value) });
      confirmClick($('#btn-start'), start, running);
      confirmClick($('#btn-end'), () => admin('end'));
      confirmClick($('#btn-reset'), () => admin('reset'), () => room && room.phase !== 'lobby');
      $('#again').onclick = () => { start(); };
      $('#duration').onchange = () => admin('duration', { durationSec: Number($('#duration').value) });
      $('#copy-admin').onclick = () => copy(`${inviteLink}?admin=${adminToken}`, 'Admin link copied — keep it to yourself');
      window.qwopKick = (id, name) => { if (window.confirm(`Remove ${name} from the room?`)) admin('kick', { playerId: id }); };
    }
    function renderAdmin() {
      if (!isAdmin || !room) return;
      const sel = $('#duration');
      if (document.activeElement !== sel) {
        if (![...sel.options].some((o) => Number(o.value) === room.durationSec)) {
          sel.add(new Option(`${Math.round(room.durationSec / 60 * 10) / 10} min`, room.durationSec));
        }
        sel.value = String(room.durationSec);
      }
      $('#btn-start').textContent = room.phase === 'running' ? 'Restart clock' : 'Start clock';
      show($('#btn-end'), room.phase === 'running');
      show($('#btn-reset'), room.phase !== 'lobby');
    }

    $('#copy-link').onclick = () => copy(inviteLink, 'Invite link copied');
    function copy(text, msg) {
      navigator.clipboard?.writeText(text).then(() => toast(msg), () => window.prompt('Copy this:', text));
    }
    let toastTimer;
    function toast(msg) {
      $('#toast').textContent = msg;
      show($('#toast'));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => show($('#toast'), false), 2200);
    }

    // ---------- leaderboard & results ----------
    function renderBoard() {
      const running = room.phase === 'running';
      const players = [...room.players].sort((a, b) => (b.best ?? -1) - (a.best ?? -1) || a.joinedAt - b.joinedAt);
      $('#board-list').innerHTML = players.map((p, i) => `
        <li class="${p.id === playerId ? 'me' : ''}">
          <span class="rank">${i + 1}</span>
          <span class="name"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}${p.admin ? ' ★' : ''}${running && p.cur != null ? `<span class="live">▶ ${p.cur.toFixed(1)}</span>` : ''}</span>
          <span class="score">${room.phase === 'lobby' ? '' : fmtM(p.best)}</span>
          ${isAdmin && p.id !== playerId ? `<button class="kick" title="Remove" onclick="qwopKick('${p.id}', '${esc(p.name).replace(/'/g, '')}')">×</button>` : '<span></span>'}
        </li>`).join('');
    }

    function resultsText() {
      const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
      return room.order.filter((id) => byId[id]).map((id, i) => `${i + 1}. ${byId[id].name} — ${fmtM(byId[id].best ?? 0)}`).join('\n');
    }
    function renderResults() {
      const finished = room.phase === 'finished' && room.order;
      const open = finished && resultsDismissedRound !== room.round;
      show($('#results'), open);
      show($('#show-results'), finished && !open);
      if (!finished) return;
      const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
      const order = room.order.filter((id) => byId[id]);
      $('#results-list').innerHTML = order.map((id, i) => {
        const p = byId[id];
        const cls = [i === 0 ? 'first' : '', i === order.length - 1 && order.length > 1 ? 'last' : '', id === playerId ? 'me' : ''].join(' ');
        const tag = i === 0 ? 'presents first' : i === order.length - 1 ? '🏆 longest run · presents last' : '';
        return `<li class="${cls}"><span class="n">${i + 1}</span><span>${esc(p.name)}<span class="tag">${tag}</span></span><span class="d">${fmtM(p.best ?? 0)}</span></li>`;
      }).join('');
    }
    $('#close-results').onclick = () => { resultsDismissedRound = room.round; renderResults(); };
    $('#show-results').onclick = () => { resultsDismissedRound = -1; renderResults(); };
    $('#copy-results').onclick = () => copy(`QWOP presentation order:\n${resultsText()}`, 'Order copied — paste it in the Meet chat');

    // ---------- main loop ----------
    let last = performance.now();
    let camX = 0;
    function frame(t) {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      updateMode();
      const controls = mode === 'practice' || mode === 'live' ? keys : {};
      const wasDown = runner.state.fallen || runner.state.finished;
      runner.step(dt, controls);
      if (mode === 'live') {
        round.best = Math.max(round.best, runner.state.best);
        if (!wasDown && (runner.state.fallen || runner.state.finished)) {
          round.attempts++;
          report(true);
        }
      }
      for (const k in keyEls) keyEls[k].classList.toggle('on', !!controls[k]);
      draw();
      updateHud();
      requestAnimationFrame(frame);
    }

    function updateMode() {
      const prev = mode;
      if (!room || room.phase !== 'running') mode = 'practice';
      else if (now() < room.startsAt) mode = 'countdown';
      else if (now() < room.endsAt) mode = 'live';
      else mode = 'timeup';
      if (prev === mode) return;
      if (mode === 'countdown') newRunner();
      if (mode === 'live' && prev === 'countdown') { newRunner(); goFlashUntil = performance.now() + 900; }
      if (mode === 'timeup') report(true);
    }

    function updateHud() {
      const st = runner.state;
      const t = now();
      let clock = room ? room.durationSec * 1000 : 300000;
      let label = '';
      if (mode === 'countdown') { clock = room.endsAt - room.startsAt; label = 'Get ready'; }
      else if (mode === 'live') { clock = room.endsAt - t; label = 'Clock running'; }
      else if (mode === 'timeup') { clock = 0; label = 'Time!'; }
      else if (room && room.phase === 'finished') { clock = 0; label = 'Round over · practice'; }
      else label = 'Practice · waiting for host';
      $('#timer').textContent = fmtClock(clock);
      $('#timer').classList.toggle('urgent', mode === 'live' && clock < 30000);
      $('#phase-label').textContent = label;
      $('#dist').textContent = `${Math.max(0, st.distance).toFixed(1)} m`;
      $('#me-attempts').textContent = mode === 'live' || mode === 'timeup' ? `best ${fmtM(round.best)} · ${round.attempts} tries` : '';

      // Countdown numbers / GO!
      const cd = $('#countdown');
      if (mode === 'countdown') { cd.textContent = Math.ceil((room.startsAt - t) / 1000); show(cd); }
      else if (performance.now() < goFlashUntil) { cd.textContent = 'GO!'; show(cd); }
      else show(cd, false);

      // Status banner.
      let banner = '';
      if (mode === 'timeup') banner = 'TIME! <small>Tallying results…</small>';
      else if (st.finished) banner = '100 METRES! 🏁 <small>Press SPACE to run again</small>';
      else if (st.fallen) banner = `You fell at ${Math.max(0, st.best).toFixed(1)} m <small>Press SPACE to go again${mode === 'practice' ? ' · practice, not counted' : ''}</small>`;
      else if (mode === 'practice' && room && room.phase === 'lobby' && runner.state.time < 4) {
        banner = isAdmin ? 'Practice away <small>Hit “Start clock” when everyone has joined</small>' : 'Practice away <small>The clock starts when the host says go</small>';
      }
      $('#banner').innerHTML = banner;
      show($('#banner'), !!banner);
    }

    // ---------- rendering ----------
    let W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    window.addEventListener('resize', resize);
    resize();

    const COLORS = {
      thigh: ['#24479a', '#1a3470'], calf: ['#e7b089', '#c38f6b'], foot: ['#f5f5f5', '#c9c9c9'],
      arm: ['#e7b089', '#c38f6b'], forearm: ['#e7b089', '#c38f6b'], torso: ['#fafafa'], head: ['#e7b089'],
    };

    function draw() {
      const torso = runner.parts.torso.getPosition();
      camX += (torso.x + 0.6 - camX) * 0.12;
      const s = Math.max(60, Math.min(H / 3.4, W / 6));
      const gy = H * 0.74;
      const ox = W * 0.42;
      const sx = (x) => (x - camX) * s + ox;
      const worldLeft = camX - ox / s, worldRight = camX + (W - ox) / s;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Sky
      const sky = ctx.createLinearGradient(0, 0, 0, gy);
      sky.addColorStop(0, '#5aa9f0'); sky.addColorStop(1, '#cfeaff');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, gy);

      // Grandstand crowd (parallax)
      const standTop = gy - 2.7 * s, standBot = gy - 0.55 * s;
      ctx.fillStyle = '#3a4252'; ctx.fillRect(0, standTop, W, standBot - standTop);
      const par = 0.5, cell = 0.14 * s;
      const shift = camX * s * par;
      const c0 = Math.floor(shift / cell) - 1;
      for (let row = 0; row * cell < standBot - standTop - cell * 0.5; row++) {
        for (let c = c0; (c - c0 - 1) * cell < W + cell; c++) {
          const h = (Math.sin(c * 12.9898 + row * 78.233) * 43758.5453) % 1;
          ctx.fillStyle = `hsl(${Math.abs(h) * 360 | 0}, 28%, ${46 + (row % 2) * 6}%)`;
          ctx.beginPath();
          ctx.arc(c * cell - shift + cell / 2, standTop + row * cell + cell * 0.6, cell * 0.26, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Ad boards
      ctx.fillStyle = '#1d2b53'; ctx.fillRect(0, standBot, W, gy - standBot);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `900 ${Math.round(0.24 * s)}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      const boardW = 4 * s, bshift = camX * s * 0.85;
      for (let b = Math.floor(bshift / boardW) - 1; (b * boardW - bshift) < W; b++) {
        ctx.fillText(b % 2 ? 'Q W O P' : 'PARTY', b * boardW - bshift + 0.4 * s, (standBot + gy) / 2);
      }

      // Track
      ctx.fillStyle = '#c4553a'; ctx.fillRect(0, gy, W, H - gy);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (const ly of [0.22, 0.55, 0.9]) ctx.fillRect(0, gy + ly * (H - gy), W, 2);
      ctx.fillStyle = '#a8432b'; ctx.fillRect(0, gy, W, 4);

      // Metre markers
      ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      ctx.font = `800 ${Math.round(Math.max(12, 0.16 * s))}px system-ui, sans-serif`;
      for (let mm = Math.max(0, Math.floor(worldLeft)); mm <= Math.min(100, Math.ceil(worldRight)); mm++) {
        const x = sx(mm);
        if (mm === 0 || mm === 100) {
          // start / finish line
          const sq = 10;
          for (let i = 0; i * sq < H - gy; i++) {
            ctx.fillStyle = i % 2 ? '#fff' : '#111'; ctx.fillRect(x - sq / 2, gy + i * sq, sq / 2, sq);
            ctx.fillStyle = i % 2 ? '#111' : '#fff'; ctx.fillRect(x, gy + i * sq, sq / 2, sq);
          }
          ctx.fillStyle = '#fff';
          ctx.fillText(mm === 0 ? 'START' : 'FINISH', x, gy + (H - gy) * 0.6);
          continue;
        }
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(x - 1, gy, 2, mm % 5 === 0 ? (H - gy) * 0.22 : 8);
        if (mm % 5 === 0) ctx.fillText(`${mm}m`, x, gy + (H - gy) * 0.26);
      }
      ctx.textAlign = 'left';

      // Markers: your round best, the leader, and other runners live.
      const marker = (d, color, label, dashed, height) => {
        const x = sx(d);
        if (x < -100 || x > W + 100) return;
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy - height * s); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '700 13px system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = color;
        ctx.fillRect(x - tw / 2, gy - height * s - 20, tw, 20);
        ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x, gy - height * s - 10);
        ctx.restore();
      };
      if (room) {
        if (room.phase === 'running') {
          for (const p of room.players) {
            if (p.id === playerId || p.cur == null) continue;
            marker(p.cur, `hsla(${hue(p.name)}, 80%, 70%, 0.85)`, p.name, false, 2.1);
          }
        }
        const leader = [...room.players].filter((p) => p.best != null && p.best > 0).sort((a, b) => b.best - a.best)[0];
        if (leader && room.phase !== 'lobby' && leader.id !== playerId) marker(leader.best, '#ffd84d', `🏆 ${leader.name} ${leader.best.toFixed(1)}`, true, 2.5);
      }
      if ((mode === 'live' || mode === 'timeup') && round.best > 0.2) marker(round.best, '#7CFFB2', `Your best ${round.best.toFixed(1)}`, true, 2.3);

      // Runner
      ctx.save();
      ctx.translate(ox - camX * s, gy);
      ctx.scale(s, -s);
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(torso.x, 0, 0.45, 0.04, 0, 0, Math.PI * 2); ctx.fill();
      for (const name of runner.drawOrder) {
        const b = runner.parts[name];
        const u = b.getUserData();
        const p = b.getPosition();
        const kind = name.replace(/[LR]$/, '');
        const back = name.endsWith('R') ? 1 : 0;
        const pal = COLORS[kind];
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(b.getAngle());
        ctx.fillStyle = pal[Math.min(back, pal.length - 1)];
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.012;
        if (u.r) {
          ctx.beginPath(); ctx.arc(0, 0, u.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#3b2616'; // hair
          ctx.beginPath(); ctx.arc(0, 0, u.r, Math.PI * 0.35, Math.PI * 1.05); ctx.lineTo(0, 0); ctx.fill();
          ctx.fillStyle = '#111';
          ctx.beginPath(); ctx.arc(u.r * 0.5, u.r * 0.2, 0.014, 0, Math.PI * 2); ctx.fill();
        } else {
          const r = kind === 'torso' ? 0.07 : kind === 'foot' ? 0.035 : Math.min(u.w, u.h) / 2;
          roundRect(-u.w / 2, -u.h / 2, u.w, u.h, r); ctx.fill(); ctx.stroke();
          if (kind === 'torso') {
            // race bib
            ctx.fillStyle = '#ffcc33';
            ctx.fillRect(-0.09, -0.02, 0.18, 0.14);
            ctx.fillStyle = '#c4553a';
            ctx.fillRect(-u.w / 2, -u.h / 2, u.w, 0.08);
          }
          if (kind === 'foot') { ctx.fillStyle = '#e04b3a'; ctx.fillRect(-u.w / 2, -u.h / 2, u.w, 0.025); }
        }
        ctx.restore();
      }
      ctx.restore();
    }
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    requestAnimationFrame(frame);
  }
})();

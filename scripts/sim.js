// Headless physics checks for tuning the runner.
//   node scripts/sim.js            -> idle stability + random-search over key patterns
const planck = require('planck');
const createRunner = require('../public/runner.js');

const tuning = process.env.TUNING ? JSON.parse(process.env.TUNING) : {};

function run(pattern, seconds) {
  const r = createRunner(planck, { tuning });
  let t = 0, i = 0, phaseT = 0;
  while (t < seconds && !r.state.fallen && !r.state.finished) {
    const ph = pattern ? pattern[i % pattern.length] : { keys: {}, d: 1 };
    r.step(1 / 60, ph.keys);
    t += 1 / 60; phaseT += 1 / 60;
    if (phaseT >= ph.d) { phaseT = 0; i++; }
  }
  const torso = r.parts.torso;
  return { best: r.state.best, fallen: r.state.fallen, t, h: torso.getPosition().y, a: torso.getAngle() };
}

const idle = run(null, 6);
console.log('idle 6s:', JSON.stringify(idle));

const combos = [{}, { q: 1 }, { w: 1 }, { o: 1 }, { p: 1 }, { q: 1, o: 1 }, { q: 1, p: 1 }, { w: 1, o: 1 }, { w: 1, p: 1 }];
let seed = Number(process.env.SEED || 1);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const N = Number(process.env.N || 3000);
const results = [];
for (let n = 0; n < N; n++) {
  const len = 2 + Math.floor(rnd() * 4);
  const pattern = [];
  for (let j = 0; j < len; j++) pattern.push({ keys: combos[Math.floor(rnd() * combos.length)], d: 0.1 + rnd() * 0.6 });
  const res = run(pattern, 20);
  results.push({ ...res, pattern });
}
results.sort((a, b) => b.best - a.best);
const bests = results.map((r) => r.best);
const pct = (p) => bests[Math.floor(bests.length * p)].toFixed(2);
console.log(`random patterns (${N}, 20s): top=${pct(0)} p1=${pct(0.01)} p10=${pct(0.1)} p50=${pct(0.5)} survived20s=${results.filter((r) => !r.fallen).length}`);
for (const r of results.slice(0, 3)) {
  console.log(r.best.toFixed(2), r.fallen ? 'fell@' + r.t.toFixed(1) : 'alive', r.pattern.map((p) => Object.keys(p.keys).join('') + ':' + p.d.toFixed(2)).join(' '));
}

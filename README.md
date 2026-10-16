# QWOP Party

Multiplayer QWOP for deciding who presents first. Everyone plays in their own browser, the host
starts a timed round, and each person's furthest distance is their score. When the clock runs out,
the **shortest distance presents first and the longest presents last**.

## Run it

```sh
docker compose up -d --build     # http://<pi-ip>:8080
```

One container, no external services. Rooms are kept in memory and snapshotted to the `qwop-data`
volume, so a restart mid-meeting doesn't lose anything. Change the port in `docker-compose.yml`.

Without Docker: `npm install && npm start` (Node 18+).

## How a session goes

1. **Host** opens `http://<pi>:8080`, enters a name, and clicks **Create room**. You land in the
   room as a player with host controls. **Copy my admin link** if you want to host from another
   browser. Anyone holding that link is the admin, so keep it to yourself.
2. Click **Copy invite link** and paste it in the Meet chat. People open it, type a name, and they're in.
3. Everyone can practise while they wait. Practice runs don't count.
4. Pick the clock length (5 min by default) and hit **Start clock**. Everyone gets a 3-2-1, then the
   round is live. You get unlimited attempts, and your score is the furthest your torso got in any run.
5. At zero, everyone sees the **presentation order**. **Copy order** gives you text to paste into chat.
   Ties are broken randomly, and anyone who never moved counts as 0 m.

Host controls: start/restart the clock, end early, go back to the lobby (clears scores), remove
a player (× on the leaderboard).

## Controls

| Key | Does |
| --- | --- |
| Q / W | thighs (Q: left forward / right back, W: the reverse) |
| O / P | calves (O: left straightens / right bends, P: the reverse) |
| Space or R | restart |

Upper body touching the track ends a run. Knees are fine, so knee-scooting is legal.

## Layout

- `server.js`: zero-dependency Node HTTP server. JSON POSTs in, Server-Sent Events out.
- `public/runner.js`: the ragdoll (planck.js / Box2D). Tuning constants are at the top.
- `public/app.js`: UI, rendering, input, round logic.
- `scripts/sim.js`: headless physics check (`npm run sim`). It confirms the runner stands when idle
  and random-searches key patterns to see how hard the game is. Override tuning with
  `TUNING='{"hipTorque":60}' npm run sim`.

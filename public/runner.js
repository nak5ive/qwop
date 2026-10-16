// QWOP-style ragdoll built on planck.js (Box2D).
// Works in the browser (window.createRunner) and in Node (module.exports) so the
// physics can be tuned headlessly with scripts/sim.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.createRunner = factory;
})(typeof self !== 'undefined' ? self : this, function createRunner(planck, opts) {
  opts = opts || {};
  const { Vec2 } = planck;

  const T = Object.assign({
    gravity: 10,
    density: 10,
    torsoDensity: 12,
    footFriction: 1.1,
    bodyFriction: 0.5,
    hipSpeed: 3.2, hipTorque: 50, hipIdleTorque: 24,
    kneeSpeed: 3.2, kneeTorque: 34, kneeIdleTorque: 14,
    shoulderSpeed: 2.5, shoulderTorque: 14, shoulderIdleTorque: 5,
    elbowIdleTorque: 1.5,
    ankleIdleTorque: 4,
    neckIdleTorque: 3,
    finish: 100,
  }, opts.tuning || {});

  const world = new planck.World({ gravity: Vec2(0, -T.gravity) });

  // Ground: one long static edge. Starting line is at x = 0.
  const ground = world.createBody({ type: 'static' });
  ground.createFixture(planck.Edge(Vec2(-50, 0), Vec2(T.finish + 60, 0)), { friction: 1.0 });
  ground.setUserData({ name: 'ground' });

  const parts = {};
  const order = []; // draw order

  function dyn(name, x, y, angle) {
    const b = world.createBody({ type: 'dynamic', position: Vec2(x, y), angle: angle || 0, angularDamping: 0.6, linearDamping: 0.02 });
    b.setUserData({ name });
    parts[name] = b;
    order.push(name);
    return b;
  }
  function boxPart(name, cx, cy, w, h, opt) {
    opt = opt || {};
    const b = dyn(name, cx, cy, opt.angle);
    b.createFixture(planck.Box(w / 2, h / 2), {
      density: opt.density || T.density,
      friction: opt.friction != null ? opt.friction : T.bodyFriction,
      filterGroupIndex: -1, // body parts never collide with each other
    });
    b.getUserData().w = w;
    b.getUserData().h = h;
    b.getUserData().upper = !!opt.upper;
    return b;
  }

  // Geometry (metres). Ground y=0, runner faces +x.
  const ANKLE = 0.08, KNEE = 0.53, HIP = 0.98, SHOULDER = 1.52, NECK = 1.62, ELBOW = 1.22;

  // Back (right) side first so it is drawn behind.
  for (const side of ['R', 'L']) {
    boxPart('arm' + side, 0, (SHOULDER + ELBOW) / 2, 0.09, SHOULDER - ELBOW + 0.04, { upper: true });
    boxPart('forearm' + side, 0, ELBOW - 0.14, 0.08, 0.30, { upper: true });
    boxPart('foot' + side, 0.06, ANKLE / 2, 0.28, ANKLE, { friction: T.footFriction });
    boxPart('calf' + side, 0, (ANKLE + KNEE) / 2, 0.11, KNEE - ANKLE + 0.02);
    boxPart('thigh' + side, 0, (KNEE + HIP) / 2, 0.15, HIP - KNEE + 0.03);
    if (side === 'R') {
      boxPart('torso', 0, (HIP + NECK) / 2 - 0.02, 0.28, NECK - HIP + 0.02, { upper: true, density: T.torsoDensity });
      const head = dyn('head', 0.02, NECK + 0.12);
      head.createFixture(planck.Circle(0.12), { density: T.density, friction: T.bodyFriction, filterGroupIndex: -1 });
      head.getUserData().r = 0.12;
      head.getUserData().upper = true;
    }
  }
  // Draw order: back limbs, torso, head, front leg, front arm.
  const drawOrder = ['armR', 'forearmR', 'footR', 'calfR', 'thighR', 'torso', 'head', 'footL', 'calfL', 'thighL', 'armL', 'forearmL'];

  const joints = {};
  function revolute(name, a, b, x, y, lower, upper, idleTorque) {
    joints[name] = world.createJoint(planck.RevoluteJoint({
      enableLimit: true, lowerAngle: lower, upperAngle: upper,
      enableMotor: true, motorSpeed: 0, maxMotorTorque: idleTorque,
    }, parts[a], parts[b], Vec2(x, y)));
    joints[name].idleTorque = idleTorque;
  }
  for (const s of ['L', 'R']) {
    revolute('hip' + s, 'torso', 'thigh' + s, 0, HIP, -0.6, 1.6, T.hipIdleTorque);
    revolute('knee' + s, 'thigh' + s, 'calf' + s, 0, KNEE, -2.3, 0.05, T.kneeIdleTorque);
    revolute('ankle' + s, 'calf' + s, 'foot' + s, 0, ANKLE, -0.5, 0.7, T.ankleIdleTorque);
    revolute('shoulder' + s, 'torso', 'arm' + s, 0, SHOULDER, -2.2, 2.4, T.shoulderIdleTorque);
    revolute('elbow' + s, 'arm' + s, 'forearm' + s, 0, ELBOW, 0, 2.2, T.elbowIdleTorque);
  }
  revolute('neck', 'torso', 'head', 0, NECK, -0.4, 0.4, T.neckIdleTorque);

  // Fall detection: any upper-body part touching the ground ends the run.
  const state = { fallen: false, finished: false, distance: 0, best: 0, time: 0 };
  world.on('begin-contact', (c) => {
    const a = c.getFixtureA().getBody().getUserData();
    const b = c.getFixtureB().getBody().getUserData();
    const other = a.name === 'ground' ? b : b.name === 'ground' ? a : null;
    if (other && other.upper && !state.finished) state.fallen = true;
  });

  // Tiny initial stance offset so the runner isn't perfectly balanced.
  const startX = parts.torso.getPosition().x;

  function drive(joint, speed, active, torque) {
    joint.setMotorSpeed(active ? speed : 0);
    joint.setMaxMotorTorque(active ? torque : joint.idleTorque);
  }

  function applyKeys(k) {
    // Q / W: thighs (Q = left thigh forward, right back; W = opposite)
    const hip = (k.q ? 1 : 0) - (k.w ? 1 : 0);
    drive(joints.hipL, hip * T.hipSpeed, hip !== 0, T.hipTorque);
    drive(joints.hipR, -hip * T.hipSpeed, hip !== 0, T.hipTorque);
    // Arms counter-swing with the thighs.
    drive(joints.shoulderL, -hip * T.shoulderSpeed, hip !== 0, T.shoulderTorque);
    drive(joints.shoulderR, hip * T.shoulderSpeed, hip !== 0, T.shoulderTorque);
    // O / P: calves (O = left knee straightens, right bends; P = opposite)
    const knee = (k.o ? 1 : 0) - (k.p ? 1 : 0);
    drive(joints.kneeL, knee * T.kneeSpeed, knee !== 0, T.kneeTorque);
    drive(joints.kneeR, -knee * T.kneeSpeed, knee !== 0, T.kneeTorque);
  }

  const DT = 1 / 120;
  let acc = 0;
  function step(dt, keys) {
    if (state.fallen || state.finished) keys = {};
    applyKeys(keys || {});
    acc += Math.min(dt, 0.1);
    while (acc >= DT) {
      world.step(DT, 8, 3);
      acc -= DT;
      state.time += DT;
    }
    state.distance = parts.torso.getPosition().x - startX;
    if (!state.fallen && !state.finished) {
      if (state.distance > state.best) state.best = state.distance;
      if (state.distance >= T.finish) { state.finished = true; state.best = T.finish; }
    }
    return state;
  }

  return { world, parts, joints, drawOrder, state, step, tuning: T };
});

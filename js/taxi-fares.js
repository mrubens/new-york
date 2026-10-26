// Taxi fares against the clock: while the player drives the cab, a fare waits under a yellow light at a street corner.
// Stop there to pick them up, then drop them at their corner or landmark (a green light) before the meter's clock runs
// out: the faster, the bigger the tip. Earnings and fares are kept with save('taxi').
import * as THREE from 'three/webgpu';
import { random, save, load, sound, rumble, log, BUTTON } from '../lamp-game.js';
import { getLocationLabel, NYC_LANDMARKS } from './city-config.js';
import { groundHeight } from './terrain.js';

const PICKUP_COLOR = 0xffc21a;   // taxi yellow
const DROPOFF_COLOR = 0x3ee88a;  // go green
const ARRIVE_RADIUS = 16;        // m from the light's centre
const ARRIVE_SPEED = 7;          // m/s (about 15 mph): slow down to let them in or out
const AVERAGE_SPEED = 9;         // m/s along the grid, what the clock allows for
const SPARE_SECONDS = 18;

function money(v) {
  return `$${v.toFixed(2)}`;
}
function distanceText(m) {
  const miles = m / 1609.34;
  return miles >= 0.2 ? `${miles.toFixed(1)} mi` : `${Math.round(m * 3.281 / 10) * 10} ft`;
}

// A tall glowing column with a ring on the street, seen from blocks away
function makeBeacon(color) {
  const group = new THREE.Group();
  const columnMat = new THREE.MeshBasicNodeMaterial({
    color, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide
  });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 140, 32, 1, true), columnMat);
  column.position.y = 70;
  const ringMat = new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(ARRIVE_RADIUS * 0.6, ARRIVE_RADIUS * 0.6 + 1.1, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.35;
  group.add(column, ring);
  return { group, column, ring };
}

// A solid 3D arrow over the cab pointing at where to go, readable from the low chase camera
function makeArrow() {
  const material = new THREE.MeshBasicNodeMaterial({ color: PICKUP_COLOR, fog: false });
  const head = new THREE.ConeGeometry(0.75, 1.5, 20);
  head.rotateX(Math.PI / 2); // tip along +z
  head.translate(0, 0, 0.75);
  const shaft = new THREE.CylinderGeometry(0.28, 0.28, 1.4, 16);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, -0.7);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(head, material), new THREE.Mesh(shaft, material));
  group.userData.material = material;
  group.scale.setScalar(0.6);
  return group;
}

export function createTaxiFares(scene, { network, controllerManager, mapSystem, audioSystem }) {
  // Where fares wait and go: the street grid's intersections, which every cab can reach
  const corners = network.nodes.filter((n) => n.avenue && !n.shape && Number.isFinite(n.x) && Number.isFinite(n.z));
  const landmarkStops = NYC_LANDMARKS
    .filter((l) => !/bridge/i.test(l.name))
    .map((l) => {
      let best = null, bestD = 160;
      for (const n of corners) {
        const d = Math.hypot(n.x - l.x, n.z - l.z);
        if (d < bestD) { best = n; bestD = d; }
      }
      return best && { x: best.x, z: best.z, name: l.short };
    })
    .filter(Boolean);

  const group = new THREE.Group();
  group.name = 'TaxiFares';
  const pickupBeacon = makeBeacon(PICKUP_COLOR);
  const dropBeacon = makeBeacon(DROPOFF_COLOR);
  const arrow = makeArrow();
  group.add(pickupBeacon.group, dropBeacon.group, arrow);
  scene.add(group);

  const sounds = {
    pickup: sound.tone({ wave: 'triangle', from: 520, to: 1040, attack: 0.005, hold: 0.12, release: 0.15, volume: 0.7, name: 'fare picked up' }),
    paid: sound.tone({ wave: 'square', from: 1200, to: 1800, attack: 0.003, hold: 0.06, release: 0.25, volume: 0.45, name: 'fare paid' }),
    late: sound.tone({ wave: 'square', from: 420, to: 140, attack: 0.005, hold: 0.25, release: 0.3, volume: 0.5, name: 'out of time' }),
    tick: sound.tone({ wave: 'sine', from: 1500, to: 1500, attack: 0.002, hold: 0.02, release: 0.05, volume: 0.4, name: 'clock tick' }),
    newFare: sound.tone({ wave: 'triangle', from: 880, to: 660, attack: 0.005, hold: 0.06, release: 0.12, volume: 0.45, name: 'new fare' })
  };
  const play = (s, opts) => { if (audioSystem.enabled) sound.play(s, opts); };

  const kept = load('taxi');
  const shift = { earned: kept?.earned || 0, fares: kept?.fares || 0, best: kept?.best || 0 };

  // HUD
  const el = {
    panel: document.getElementById('fare-panel'),
    tag: document.getElementById('fare-tag'),
    where: document.getElementById('fare-where'),
    distance: document.getElementById('fare-distance'),
    clock: document.getElementById('fare-clock'),
    meter: document.getElementById('fare-meter'),
    earned: document.getElementById('fare-earned'),
    toast: document.getElementById('fare-toast')
  };

  // Lamp's preview draws no frames on a screen, so a fade would never finish there: the panel and toast show at once.
  if (window.lampPreview) for (const e of [el.panel, el.toast]) if (e) e.style.transition = 'none';

  let state = 'waiting';  // waiting: next fare comes in a moment; pickup; ride
  let wait = 1.5;
  let pickup = null, drop = null;
  let timeLeft = 0, timeGiven = 0, fareValue = 0;
  let lastTick = 0;
  let toastTime = 0;
  let shown = null;
  let hudTimer = 0;

  function toast(text, kind) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.className = `fare-toast show ${kind}`;
    toastTime = 3.2;
  }

  function placeBeacon(beacon, spot) {
    beacon.group.position.set(spot.x, groundHeight(spot.x, spot.z), spot.z);
    beacon.group.visible = true;
    beacon.group.updateMatrixWorld(true);
  }

  function pick(from, min, max) {
    for (let tries = 0; tries < 60; tries++) {
      const n = corners[Math.floor(random() * corners.length)];
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d >= min && d <= max) return n;
    }
    // Nearest one past the minimum, whatever it is
    let best = corners[0], bestD = Infinity;
    for (const n of corners) {
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d >= min && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function newFare() {
    const car = controllerManager.entities.car.position;
    const n = pick(car, 140, 480);
    pickup = { x: n.x, z: n.z, name: getLocationLabel(n.x, n.z) };
    drop = null;
    state = 'pickup';
    placeBeacon(pickupBeacon, pickup);
    dropBeacon.group.visible = false;
    mapSystem.waypoint = { ...pickup };
    play(sounds.newFare);
    log(`taxi: fare waiting at ${pickup.name}`);
  }

  function startRide() {
    const options = landmarkStops.filter((s) => {
      const d = Math.hypot(s.x - pickup.x, s.z - pickup.z);
      return d > 600 && d < 2600;
    });
    if (options.length && random() < 0.4) {
      drop = options[Math.floor(random() * options.length)];
    } else {
      const n = pick(pickup, 650, 2200);
      drop = { x: n.x, z: n.z, name: getLocationLabel(n.x, n.z) };
    }
    const along = Math.abs(drop.x - pickup.x) + Math.abs(drop.z - pickup.z);
    timeGiven = timeLeft = Math.round(along / AVERAGE_SPEED + SPARE_SECONDS);
    // NYC meter: $3 to start, 70¢ a fifth of a mile
    fareValue = 3 + 0.7 * Math.ceil(along / 321.9);
    state = 'ride';
    pickupBeacon.group.visible = false;
    placeBeacon(dropBeacon, drop);
    mapSystem.waypoint = { ...drop };
    play(sounds.pickup);
    rumble(0, 0.2, 0.3, 0.15);
    toast(`Passenger in. ${drop.name}, ${timeGiven} s on the clock!`, 'go');
    log(`taxi: picked up, to ${drop.name} (${Math.round(along)} m, ${timeGiven} s)`);
  }

  function endRide(paid) {
    if (paid) {
      const tip = Math.round(fareValue * 0.35 * (timeLeft / timeGiven) * 4) / 4;
      const total = fareValue + tip;
      shift.earned += total;
      shift.fares += 1;
      shift.best = Math.max(shift.best, total);
      play(sounds.paid);
      play(sounds.paid, { pitch: 1.5, volume: 0.7 });
      rumble(0, 0.3, 0.5, 0.2);
      toast(tip > 0 ? `Paid ${money(fareValue)} + ${money(tip)} tip` : `Paid ${money(fareValue)}`, 'paid');
      log(`taxi: dropped off, paid ${money(fareValue)} + ${money(tip)} tip with ${Math.ceil(timeLeft)} s left`);
    } else {
      play(sounds.late);
      rumble(0, 0.6, 0.2, 0.4);
      toast('Out of time. Your passenger walked off without paying.', 'late');
      log('taxi: out of time, fare lost');
    }
    save('taxi', shift);
    dropBeacon.group.visible = false;
    state = 'waiting';
    wait = 2.5;
  }

  function skip() {
    if (state === 'ride') {
      endRide(false);
    } else {
      state = 'waiting';
      wait = 0.4;
      pickupBeacon.group.visible = false;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && !e.repeat && !e.metaKey && !e.ctrlKey && controllerManager.activeMode === 'car') skip();
  });

  function renderHud(driving) {
    if (!el.panel) return;
    const visible = driving && state !== 'waiting';
    el.panel.classList.toggle('show', driving);
    if (!driving) return;
    const car = controllerManager.entities.car.position;
    const target = state === 'ride' ? drop : pickup;
    const kind = state === 'ride' ? 'ride' : state === 'pickup' ? 'pickup' : 'waiting';
    if (shown !== kind) {
      shown = kind;
      el.panel.dataset.state = kind;
      el.tag.textContent = kind === 'ride' ? 'Drop off' : kind === 'pickup' ? 'Pick up' : 'Radio';
    }
    if (visible && target) {
      el.where.textContent = target.name;
      el.distance.textContent = `${distanceText(Math.hypot(target.x - car.x, target.z - car.z))} · ${state === 'ride' ? `meter ${money(fareValue)}` : 'stop at the yellow light'}`;
    } else {
      el.where.textContent = 'Looking for a fare…';
      el.distance.textContent = 'T or X skips a fare';
    }
    if (state === 'ride') {
      const s = Math.max(0, Math.ceil(timeLeft));
      el.clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      el.clock.classList.toggle('hurry', timeLeft < 10);
      el.meter.style.transform = `scaleX(${Math.max(0, timeLeft / timeGiven)})`;
    } else {
      el.clock.textContent = '—';
      el.clock.classList.remove('hurry');
      el.meter.style.transform = 'scaleX(1)';
    }
    el.earned.textContent = `${money(shift.earned)} · ${shift.fares} fare${shift.fares === 1 ? '' : 's'}`;
  }

  const arrowColor = new THREE.Color();
  // Everything starts shown, out of sight under the cab, for the game's first frame: that frame compiles what's on screen behind
  // the loading screen, so the lights and the arrow are ready to draw the moment they're needed.
  let firstFrame = true;
  function update(dt, elapsed, pad) {
    if (firstFrame) {
      firstFrame = false;
      const p = controllerManager.getActiveEntity().position;
      for (const o of [pickupBeacon.group, dropBeacon.group, arrow]) o.position.set(p.x, p.y - 400, p.z);
      group.updateMatrixWorld(true);
      return;
    }
    if (state === 'waiting') pickupBeacon.group.visible = dropBeacon.group.visible = false;
    const driving = controllerManager.activeMode === 'car';
    if (toastTime > 0) {
      toastTime -= dt;
      if (toastTime <= 0 && el.toast) el.toast.classList.remove('show');
    }
    group.visible = driving;
    hudTimer -= dt;
    if (hudTimer <= 0) { renderHud(driving); hudTimer = 0.1; }
    if (!driving) { arrow.visible = false; return; }

    if (pad && (pad.pressed & BUTTON.X)) skip();

    const car = controllerManager.entities.car;
    const p = car.position;
    if (state === 'waiting') {
      wait -= dt;
      if (wait <= 0) newFare();
    } else {
      const target = state === 'ride' ? drop : pickup;
      const d = Math.hypot(target.x - p.x, target.z - p.z);
      if (d < ARRIVE_RADIUS && Math.abs(car.speed) < ARRIVE_SPEED) {
        if (state === 'pickup') startRide(); else endRide(true);
      } else if (state === 'ride') {
        timeLeft -= dt;
        const whole = Math.ceil(timeLeft);
        if (timeLeft < 10 && whole !== lastTick && timeLeft > 0) play(sounds.tick, { pitch: timeLeft < 4 ? 1.25 : 1 });
        lastTick = whole;
        if (timeLeft <= 0) endRide(false);
      }
    }

    // Beacons pulse; the arrow points the way
    const pulse = 0.22 + 0.1 * Math.sin(elapsed * 4);
    pickupBeacon.column.material.opacity = pulse;
    dropBeacon.column.material.opacity = pulse;
    const s = 1 + 0.08 * Math.sin(elapsed * 5);
    pickupBeacon.ring.scale.set(s, s, 1);
    dropBeacon.ring.scale.set(s, s, 1);

    const target = state === 'ride' ? drop : state === 'pickup' ? pickup : null;
    if (target) {
      const dx = target.x - p.x, dz = target.z - p.z;
      arrow.visible = Math.hypot(dx, dz) > ARRIVE_RADIUS;
      arrow.position.set(p.x, p.y + 2.6 + 0.08 * Math.sin(elapsed * 3), p.z);
      arrow.rotation.set(0, Math.atan2(dx, dz), 0);
      arrowColor.setHex(state === 'ride' ? DROPOFF_COLOR : PICKUP_COLOR);
      arrow.userData.material.color.copy(arrowColor);
    } else {
      arrow.visible = false;
    }
    group.updateMatrixWorld(true);
  }

  return { update, group };
}

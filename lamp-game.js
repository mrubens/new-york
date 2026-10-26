// Lamp's game runtime for a game drawn with three.js. Lamp writes this file before every build; don't edit it.
//
// The game is two functions, init and frame, given to game(): the runtime runs them about 60 times a second wherever
// the game is played (on the Mac and on an iPhone or iPad in Lamp's app around the page, on the Xbox in its web host),
// draws at 1920x1080 scaled to the screen, and hands each frame the controllers as pads: a controller connected to the
// device, the keyboard as the first pad, and on a touch screen the touch controls it draws. Lamp's preview runs the same
// page out of sight from a script of the controller's moves, at exactly 1/60 s a frame with the same random numbers
// every play, so use frame.dt, random() and save()/load() from here, never requestAnimationFrame, Math.random, the
// clock or localStorage yourself.
//
//   import * as THREE from 'three';
//   import { game, BUTTON, random, sound, log } from './lamp-game.js';
//   const renderer = new THREE.WebGLRenderer({ antialias: true });
//   game({ renderer, async init() { … }, frame(f) { … renderer.render(scene, camera); } });

export const WIDTH = 1920, HEIGHT = 1080;

// The controller's buttons, as bits of a pad's down, pressed and released.
export const BUTTON = { A: 1, B: 2, X: 4, Y: 8, LB: 16, RB: 32, MENU: 64, VIEW: 128, UP: 256, DOWN: 512, LEFT: 1024, RIGHT: 2048,
                        LSTICK: 4096, RSTICK: 8192 };

const preview = window.lampPreview || null;   // set by Lamp's preview before the page runs
const logs = [];

// MARK: Random numbers, the same each preview play (xorshift64*, as the C++ kit has it)

let seed = preview ? 1n : BigInt(Date.now()) | 1n;
const mask = (1n << 64n) - 1n;
export function random() {
    seed ^= seed >> 12n; seed ^= (seed << 25n) & mask; seed ^= seed >> 27n;
    return Number(((seed * 0x2545F4914F6CDD1Dn) & mask) >> 40n) / 16777216;
}
if (preview) {
    // three.js and the game's own code may reach for these: in the preview they're the game's clock and seed too.
    Math.random = random;
    let clock = 0;
    performance.now = () => clock;
    Date.now = () => 1700000000000 + clock;
    window.__lampAdvance = ms => { clock += ms; };
}

// MARK: The log, saves and files

export function log(...parts) {
    const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    const said = `[${time.toFixed(2)} s] ${line}`;
    if (preview) { if (logs.length < 400) logs.push(said); return; }
    // The app around the page puts its console into the app's log.
    console.log(said);
}
window.addEventListener('error', e => log(`Error: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => log(`Error: ${e.reason && e.reason.message || e.reason}`));

const saved = preview ? new Map() : null;
export function save(name, value) {
    const text = JSON.stringify(value);
    if (saved) saved.set(name, text); else try { localStorage.setItem('lamp.save.' + name, text); } catch (e) { return false; }
    return true;
}
export function load(name) {
    const text = saved ? saved.get(name) : (() => { try { return localStorage.getItem('lamp.save.' + name); } catch (e) { return null; } })();
    try { return text == null ? null : JSON.parse(text); } catch (e) { return null; }
}

// A file beside the page (assets/ship.glb), as bytes.
export async function asset(path) {
    const answer = await fetch(path);
    if (!answer.ok) { log(`asset: no ${path}`); return null; }
    return answer.arrayBuffer();
}

// MARK: Sound, mixed by the browser's Web Audio; the preview plays nothing and says what was played

const sounds = [];
let audio = null, effectsVolume = 1, musicVolume = 1, musicVoice = null, music = { gain: 0 };
const played = new Map();
// The effects playing now, so a change of the effects volume reaches them too.
const voices = new Set();
function context() {
    if (preview) return null;
    if (!audio) { try { audio = new AudioContext({ sampleRate: 48000 }); } catch (e) { return null; } }
    if (audio.state === 'suspended') audio.resume();
    return audio;
}
// Played as soon as the page is touched, clicked or a key pressed, for a browser that holds sound back until then.
for (const kind of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(kind, () => context(), { passive: true });

function made(samples, name) {
    const s = { id: sounds.length + 1, name, samples, buffer: null };
    sounds.push(s);
    return s;
}
function bufferOf(s) {
    const ctx = context();
    if (!ctx || !s || !s.samples) return null;
    if (!s.buffer) {
        s.buffer = ctx.createBuffer(1, s.samples.length, 48000);
        s.buffer.copyToChannel(s.samples, 0);
    }
    return s.buffer;
}

export const sound = {
    // An effect made in code: a wave ('sine', 'square', 'triangle', 'saw', 'noise') from one pitch to another under a
    // simple envelope, in seconds.
    tone({ wave = 'square', from = 440, to = from, attack = 0.005, hold = 0.08, release = 0.1, volume = 0.6, name } = {}) {
        const n = Math.max(1, Math.round((attack + hold + release) * 48000));
        const out = new Float32Array(n);
        let phase = 0, noise = 0x2545F491;
        for (let i = 0; i < n; i++) {
            const t = i / 48000, at = t / Math.max(1e-6, attack + hold + release);
            const hz = from + (to - from) * at;
            phase = (phase + hz / 48000) % 1;
            let v;
            if (wave === 'sine') v = Math.sin(phase * 2 * Math.PI);
            else if (wave === 'triangle') v = 1 - 4 * Math.abs(phase - 0.5);
            else if (wave === 'saw') v = 2 * phase - 1;
            else if (wave === 'noise') { noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5; v = ((noise >>> 0) / 4294967296) * 2 - 1; }
            else v = phase < 0.5 ? 1 : -1;
            const env = t < attack ? t / attack : t < attack + hold ? 1 : Math.max(0, 1 - (t - attack - hold) / Math.max(1e-6, release));
            out[i] = v * env * volume * 0.5;
        }
        return made(out, name || `${wave} ${Math.round(from)}→${Math.round(to)} Hz`);
    },
    // An effect from samples worked out in code: mono, -1 to 1, at `rate` a second.
    samples(values, rate = 48000, name = 'samples') {
        const n = Math.round(values.length * 48000 / rate), out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = values[Math.min(values.length - 1, Math.floor(i * rate / 48000))] || 0;
        return made(out, name);
    },
    // A sound file beside the page (.wav, .ogg, .mp3, .m4a), decoded whole: load each in init, never per frame.
    async load(path) {
        const s = made(null, path);
        const ctx = context();
        if (!ctx) return s;
        try { s.buffer = await ctx.decodeAudioData(await (await fetch(path)).arrayBuffer()); } catch (e) { log(`sound: couldn't load ${path}`); }
        return s;
    },
    // Plays an effect, and gives the voice playing it (null when it didn't): volume 0 to 1, pan -1 to 1, pitch 1 as
    // made (2 an octave up). loop plays it over and over until stopped.
    play(s, { volume = 1, pan = 0, pitch = 1, loop = false } = {}) {
        if (!s) return null;
        played.set(s.name, (played.get(s.name) || 0) + 1);
        const ctx = context(), buffer = bufferOf(s) || s.buffer;
        if (!ctx || !buffer) return null;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = loop; source.playbackRate.value = pitch;
        gain.gain.value = volume * effectsVolume; panner.pan.value = pan;
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        const voice = { source, gain, panner, volume };
        voices.add(voice);
        source.onended = () => voices.delete(voice);
        return voice;
    },
    set(voice, { volume, pan, pitch } = {}) {
        if (!voice) return;
        if (volume != null) { voice.volume = volume; voice.gain.gain.value = volume * effectsVolume; }
        if (pan != null) voice.panner.pan.value = pan;
        if (pitch != null) voice.source.playbackRate.value = pitch;
    },
    stop(voice) { try { voice && voice.source.stop(); } catch (e) {} },
    // Music: a sound played over and over under the effects (keep it quiet, 0.3 to 0.5); null fades it out.
    music(s, volume = 0.4) {
        const ctx = context();
        if (s) played.set('music: ' + s.name, 1);
        if (musicVoice && ctx) { const old = musicVoice; old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); setTimeout(() => sound.stop(old), 1500); }
        musicVoice = null;
        music.gain = volume;
        if (!s || !ctx) return;
        const buffer = bufferOf(s) || s.buffer;
        if (!buffer) return;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = true;
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(volume * musicVolume, ctx.currentTime, 0.3);
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        musicVoice = { source, gain, panner };
    },
    // The person's own volumes for effects and for music, 0 to 1: what the game's settings change, kept with save().
    volume(effects, musicLevel) {
        effectsVolume = effects; musicVolume = musicLevel;
        for (const voice of voices) voice.gain.gain.value = voice.volume * effectsVolume;
        if (musicVoice) musicVoice.gain.gain.value = music.gain * musicVolume;
    },
};

// MARK: The controllers

const keys = new Set();
// Only the keyboard's own keys: the Xbox's lamp.js sends the controller as key events too (which aren't trusted, being
// made by a script), and the controller is read whole through the Gamepad API.
window.addEventListener('keydown', e => { if (!e.isTrusted) return; keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault(); });
window.addEventListener('keyup', e => { if (e.isTrusted) keys.delete(e.code); });
window.addEventListener('blur', () => keys.clear());

function keyboardPad() {
    const k = c => keys.has(c);
    const pad = { lx: (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0),
                  ly: (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0),
                  rx: (k('KeyL') ? 1 : 0) - (k('KeyJ') ? 1 : 0), ry: (k('KeyI') ? 1 : 0) - (k('KeyK') ? 1 : 0),
                  lt: k('KeyZ') ? 1 : 0, rt: k('KeyC') ? 1 : 0, down: 0 };
    const map = { Space: BUTTON.A, Enter: BUTTON.A, Escape: BUTTON.B, Backspace: BUTTON.B, KeyF: BUTTON.X, KeyR: BUTTON.Y,
                  KeyQ: BUTTON.LB, KeyE: BUTTON.RB, KeyP: BUTTON.MENU, Tab: BUTTON.VIEW,
                  ArrowUp: BUTTON.UP, ArrowDown: BUTTON.DOWN, ArrowLeft: BUTTON.LEFT, ArrowRight: BUTTON.RIGHT };
    for (const code in map) if (keys.has(code)) pad.down |= map[code];
    return pad;
}

const dead = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
function gamepadPad(g) {
    const b = i => g.buttons[i] && g.buttons[i].pressed;
    const pad = { connected: true, lx: dead(g.axes[0] || 0), ly: -dead(g.axes[1] || 0), rx: dead(g.axes[2] || 0), ry: -dead(g.axes[3] || 0),
                  lt: g.buttons[6] ? g.buttons[6].value : 0, rt: g.buttons[7] ? g.buttons[7].value : 0, down: 0 };
    const bits = [BUTTON.A, BUTTON.B, BUTTON.X, BUTTON.Y, BUTTON.LB, BUTTON.RB, 0, 0, BUTTON.VIEW, BUTTON.MENU, BUTTON.LSTICK, BUTTON.RSTICK,
                  BUTTON.UP, BUTTON.DOWN, BUTTON.LEFT, BUTTON.RIGHT];
    bits.forEach((bit, i) => { if (bit && b(i)) pad.down |= bit; });
    pad.gamepad = g;
    return pad;
}

// The first controller as an app around the page reads it itself (Lamp's Android app, whose WebView doesn't promise
// the Gamepad API): sticks -1 to 1 with up positive, triggers 0 to 1, buttons as BUTTON bits.
let nativePad = null;
// All at rest is no controller in hand (one that went away sends that), so the touch controls can come back.
window.lampNativePad = (lx, ly, rx, ry, lt, rt, down) => {
    nativePad = down || lx || ly || rx || ry || lt || rt ? { connected: true, lx, ly, rx, ry, lt, rt, down } : null;
};

function merge(pad, more) {
    pad.down |= more.down;
    for (const axis of ['lx', 'ly', 'rx', 'ry', 'lt', 'rt']) if (Math.abs(more[axis]) > Math.abs(pad[axis])) pad[axis] = more[axis];
}

// The controller's rumble, 0 to 1 for its two motors, for `seconds` (a short shake by default).
export function rumble(pad, low, high, seconds = 0.2) {
    const g = (pads[pad] || {}).gamepad;
    if (preview) { if (low || high) log(`rumble: controller ${pad + 1} ${low.toFixed(2)} ${high.toFixed(2)}`); return; }
    g && g.vibrationActuator && g.vibrationActuator.playEffect('dual-rumble', { duration: seconds * 1000, strongMagnitude: low, weakMagnitude: high }).catch(() => {});
}

// MARK: Touch controls, on a touch screen while no controller is connected, or once the screen is touched

let touchButtons = BUTTON.A | BUTTON.B | BUTTON.MENU;
// A page with touch controls of its own, or one that reads the keyboard itself, turns Lamp's off (`game`).
let drawsTouch = true, readsKeyboard = true;
const touch = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
// A tap shorter than a frame still reaches the game: held for the next frame it reads.
let tapped = 0;
let touchShown = false, touchLayer = null;
const touchScreen = !preview && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function buildTouch() {
    touchLayer = document.createElement('div');
    touchLayer.style.cssText = 'position:fixed;inset:0;z-index:10;touch-action:none;user-select:none;-webkit-user-select:none;font:700 22px -apple-system,system-ui,sans-serif;color:#fff';
    const stick = (side, axes) => {
        const zone = document.createElement('div');
        zone.style.cssText = `position:absolute;top:0;bottom:0;${side}:0;width:50%`;
        const ring = document.createElement('div'), knob = document.createElement('div');
        ring.style.cssText = 'position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;background:rgba(255,255,255,.18);display:none';
        knob.style.cssText = 'position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(255,255,255,.45);display:none';
        zone.append(ring, knob);
        // Where the left stick is, before a thumb is on it.
        const rest = document.createElement('div');
        if (side === 'left') {
            rest.style.cssText = 'position:absolute;left:calc(40px + env(safe-area-inset-left));bottom:calc(32px + env(safe-area-inset-bottom));width:120px;height:120px;border-radius:50%;border:2px solid rgba(255,255,255,.25)';
            zone.append(rest);
        }
        let id = null, sx = 0, sy = 0;
        zone.addEventListener('pointerdown', e => { id = e.pointerId; sx = e.clientX; sy = e.clientY; zone.setPointerCapture(id); move(e); });
        const move = e => {
            if (e.pointerId !== id) return;
            let dx = e.clientX - sx, dy = e.clientY - sy;
            const length = Math.hypot(dx, dy), scale = Math.min(1, 60 / Math.max(1, length));
            dx *= scale; dy *= scale;
            touch[axes[0]] = dx / 60; touch[axes[1]] = -dy / 60;
            const r = zone.getBoundingClientRect();
            ring.style.left = (sx - r.left) + 'px'; ring.style.top = (sy - r.top) + 'px';
            knob.style.left = (sx - r.left + dx) + 'px'; knob.style.top = (sy - r.top + dy) + 'px';
            ring.style.display = knob.style.display = 'block';
            rest.style.display = 'none';
        };
        zone.addEventListener('pointermove', move);
        const end = e => {
            if (e.pointerId !== id) return;
            id = null; touch[axes[0]] = touch[axes[1]] = 0;
            ring.style.display = knob.style.display = 'none';
            rest.style.display = '';
        };
        zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
        return zone;
    };
    touchLayer.append(stick('left', ['lx', 'ly']));
    if (touchButtons & BUTTON.RSTICK) touchLayer.append(stick('right', ['rx', 'ry']));
    const button = (bit, title, css, small) => {
        if (!(touchButtons & bit)) return;
        const size = small ? 44 : 64;
        const b = document.createElement('div');
        b.textContent = title;
        b.style.cssText = `position:absolute;${css};width:${size}px;height:${size}px;line-height:${size}px;text-align:center;border-radius:50%;background:rgba(255,255,255,.22);font-size:${small ? 15 : 22}px`;
        const on = e => { e.stopPropagation(); touch.down |= bit; tapped |= bit; b.style.background = 'rgba(255,255,255,.5)'; b.setPointerCapture(e.pointerId); };
        const off = () => { touch.down &= ~bit; b.style.background = 'rgba(255,255,255,.22)'; };
        b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off);
        touchLayer.append(b);
    };
    // Kept clear of a phone's rounded corners and its camera (the safe area).
    const at = (x, side, y, edge) => `${side}:calc(${x}px + env(safe-area-inset-${side}));${edge}:calc(${y}px + env(safe-area-inset-${edge}))`;
    button(BUTTON.A, 'A', at(110, 'right', 40, 'bottom'));
    button(BUTTON.B, 'B', at(40, 'right', 110, 'bottom'));
    button(BUTTON.X, 'X', at(180, 'right', 110, 'bottom'));
    button(BUTTON.Y, 'Y', at(110, 'right', 180, 'bottom'));
    button(BUTTON.LB, 'LB', at(30, 'left', 20, 'top'), true);
    button(BUTTON.VIEW, '⧉', at(90, 'left', 20, 'top'), true);
    button(BUTTON.MENU, '≡', at(90, 'right', 20, 'top'), true);
    button(BUTTON.RB, 'RB', at(30, 'right', 20, 'top'), true);
    document.body.append(touchLayer);
}
if (touchScreen) window.addEventListener('pointerdown', () => { if (!touchShown) { touchShown = true; showTouch(); } }, { capture: true });
function showTouch() { if (!drawsTouch) return; if (!touchLayer) buildTouch(); touchLayer.style.display = 'block'; touchShown = true; }
function hideTouch() { if (touchLayer) touchLayer.style.display = 'none'; touchShown = false; }

// MARK: The frame

let time = 0, number = 0;
const pads = [0, 1, 2, 3].map(() => ({ connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0, pressed: 0, released: 0 }));
let renderer = null, frameFunction = null, scripted = null, before = [0, 0, 0, 0], seenControllers = -1;

// Whether a controller is being played with now: a button down or a stick off its centre.
const inUse = g => g.buttons.some(b => b && b.pressed) || g.axes.some(a => Math.abs(a) > 0.3);

function readPads() {
    const found = scripted ? [] : Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(g => g && g.connected);
    // The touch controls are there from the start, step aside once a controller is played with (a connected one alone
    // may only be the simulator passing the Mac's through), and come back when the screen is touched.
    if (touchScreen && !scripted) {
        if (seenControllers === -1) showTouch();
        const nativeInUse = nativePad && (nativePad.down || [nativePad.lx, nativePad.ly, nativePad.rx, nativePad.ry].some(a => Math.abs(a) > 0.3));
        if (touchShown && (found.some(inUse) || nativeInUse)) hideTouch();
    }
    if (!scripted && found.length !== seenControllers) { seenControllers = found.length; log(`Lamp: ${found.length} controller${found.length === 1 ? '' : 's'} connected.`); }
    for (let i = 0; i < 4; i++) {
        let pad = found[i] ? gamepadPad(found[i]) : { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
        if (i === 0) {
            if (scripted) pad = Object.assign({}, scripted);
            else {
                if (nativePad) merge(pad, nativePad);
                if (readsKeyboard) merge(pad, keyboardPad());
                merge(pad, Object.assign({}, touch, { down: touch.down | tapped }));
                tapped = 0;
            }
            pad.connected = true;
        }
        pad.pressed = pad.down & ~before[i];
        pad.released = before[i] & ~pad.down;
        before[i] = pad.down;
        pads[i] = pad;
    }
}

function step(dt) {
    readPads();
    time += dt;
    frameFunction({ dt, time, number, width: WIDTH, height: HEIGHT, pads });
    number++;
}

// Fits the canvas to the window at the console's shape, black around it.
function fit() {
    const canvas = renderer.domElement, scale = Math.min(innerWidth / WIDTH, innerHeight / HEIGHT);
    canvas.style.cssText = `position:fixed;left:${(innerWidth - WIDTH * scale) / 2}px;top:${(innerHeight - HEIGHT * scale) / 2}px;width:${WIDTH * scale}px;height:${HEIGHT * scale}px`;
}

// The game: `renderer` a three.js WebGLRenderer the runtime sizes and places, `init` run once (and waited for, so it may
// load files), `frame(f)` each frame with f.dt, f.time, f.number and f.pads (pads[0] the first controller: lx, ly, rx,
// ry -1 to 1 with up positive, lt and rt 0 to 1, buttons as BUTTON bits in down, pressed and released). `touch` names
// the buttons the touch controls show (BUTTON.A | BUTTON.B | BUTTON.MENU unless given; BUTTON.RSTICK adds a right stick),
// or `false` for a page that draws touch controls of its own. `keyboard: false` is for a page that reads the keys itself:
// the keyboard then isn't the first pad as well, so a key isn't heard twice. The preview's script is the first pad either way.
// The renderer may be a WebGLRenderer or, from 'three/webgpu', a WebGPURenderer (initialised before game() is called).
export async function game({ renderer: given, init, frame, touch: buttons, keyboard = true }) {
    renderer = given;
    frameFunction = frame;
    if (buttons === false) drawsTouch = false;
    else if (buttons != null) touchButtons = buttons;
    readsKeyboard = keyboard !== false;
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    document.documentElement.style.background = document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    // A game's page is played, not read: nothing on it is selected, magnified or called up by a long press.
    document.body.style.webkitUserSelect = document.body.style.userSelect = 'none';
    document.body.style.webkitTouchCallout = 'none';
    document.body.style.touchAction = 'none';
    document.body.append(renderer.domElement);
    fit();
    window.addEventListener('resize', fit);
    // In the preview a start-up that fails ends the play with what it said, rather than leaving Lamp waiting for frames.
    if (init) {
        try { await init({ width: WIDTH, height: HEIGHT }); } catch (e) {
            log(`Error: ${e && e.message || e}`);
            if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, failed: String(e && e.message || e), logs }); return; }
            throw e;
        }
    }
    if (preview) return runPreview();
    let last = 0;
    const loop = now => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        step(dt);
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

// MARK: Lamp's preview: the script played out of sight, a picture where it says

async function runPreview() {
    // Lamp answers each picture once it has taken it, of the whole page as drawn (the canvas and anything over it).
    const post = message => window.webkit.messageHandlers.lampPreview.postMessage(message);
    let mostCalls = 0, mostTriangles = 0, triangles = 0, frames = 0;
    const limit = 60 * 600;
    for (const line of preview.script) {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'shot') {
            await post({ shot: words[1] });
            continue;
        }
        if (words[0] !== 'hold') continue;
        const [n, lx, ly, rx, ry, lt, rt, down] = words.slice(1).map(Number);
        scripted = { lx, ly, rx, ry, lt, rt, down: down | 0 };
        for (let i = 0; i < n && frames < limit; i++) {
            window.__lampAdvance(1000 / 60);
            renderer.info.reset();
            renderer.info.autoReset = false;
            try { step(1 / 60); } catch (e) { log(`Error: ${e.message}`); post({ done: true, failed: e.message, logs }); return; }
            const info = renderer.info.render;
            mostCalls = Math.max(mostCalls, info.calls);
            mostTriangles = Math.max(mostTriangles, info.triangles);
            triangles += info.triangles;
            frames++;
        }
    }
    const said = [...played.entries()].map(([name, count]) => count > 1 ? `${name} ${count} times` : name);
    post({ done: true, logs,
           stats: `${frames} frames (${(frames / 60).toFixed(1)} s of play); at most ${mostCalls} draws and ${mostTriangles} triangles in a frame, ${Math.round(frames ? triangles / frames : 0)} triangles a frame on average.`,
           sound: said.length ? 'played ' + said.join(', ') : 'nothing played' });
}

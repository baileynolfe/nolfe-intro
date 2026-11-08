/* Nolfe — entrance sound.
   The intro's sounds are laid on its timeline as stems (door, steps, Asher's growls, Mango's long growl). The scroll position is the playhead: an
   AudioWorklet reads every stem at the playhead, so sliding forward plays them forward, sliding back plays them
   backward, sliding faster raises their pitch and stopping goes quiet. Each sound lives where its source is in the
   scene (the door, the stair light's buzz, Asher's and Mango's heads; footsteps under your feet) and the listener rides the
   camera's path through HRTF panners, so sounds pan and fall away as you move past them. From the first glow of
   golden light everything vibrates slower and slower: the growls slow like a tape losing power until their pulses are
   single throbs and then sub-sound, the hum sinks with them, and the sinker (a bass synth that is the growls' own pulse
   made solid) rises out of them and sinks along. Everything decrescendos together along the curve of the owner's
   reference recording and is silent before the threshold.
   Browsers only allow sound after a tap, click or key press: it starts with the first one (a phone swipe counts, a
   scroll wheel doesn't) and the speaker button mutes it. ?sound=off disables it. Off with reduced motion.
   The same graph also renders offline (NolfeIntroAudio.renderOffline) for previews. */
(function () {
'use strict';
const Q = new URLSearchParams(location.search);
const CFG = Object.assign({ base: 'intro/' }, window.NOLFE_INTRO_CONFIG || {});
const AC = window.AudioContext || window.webkitAudioContext;
const REDUCED = Q.get('motion') === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const OFF = Q.get('sound') === 'off' || REDUCED || !AC || !window.AudioWorkletNode;
const STEMS = ['door', 'steps', 'growl', 'mango', 'sinker'];
const LEVEL = { door: 0.55, steps: 0.3, growl: 0.24, mango: 0.24, sinker: 0.6, buzz: 0.06 };
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

const WORKLET = `
class NolfeScrub extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'playhead', defaultValue: 0, automationRate: 'a-rate' }]; }
  constructor() { super(); this.bufs = []; this.prev = null; this.env = 0; this.port.onmessage = (e) => { this.bufs = e.data; }; }
  process(_in, outs, params) {
    const ph = params.playhead, n = outs[0][0].length, k = 1 - Math.exp(-1 / (0.012 * sampleRate));
    for (let i = 0; i < n; i++) {
      const p = ph.length > 1 ? ph[i] : ph[0];
      if (this.prev === null) this.prev = p;
      const rate = (p - this.prev) * sampleRate; this.prev = p;            // 1 = real time, negative = backward
      this.env += (Math.min(1, Math.abs(rate) * 1.25) - this.env) * k;     // quiet when the playhead stops
      const pos = p * sampleRate, i0 = Math.floor(pos), fr = pos - i0;
      for (let s = 0; s < outs.length; s++) {
        const b = this.bufs[s]; let y = 0;
        if (b && i0 >= 0 && i0 + 1 < b.length) y = b[i0] + (b[i0 + 1] - b[i0]) * fr;
        outs[s][0][i] = y * this.env;
      }
    }
    return true;
  }
}
registerProcessor('nolfe-scrub', NolfeScrub);`;
function roomIR(ctx, seconds, predelay, decay = 4.2, darken = 0.55) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds), ir = ctx.createBuffer(2, n, sr), pd = Math.floor(sr * predelay);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c); let lp = 0;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / sr, damp = 0.12 + darken * Math.min(1, t / seconds);       // later reflections get darker
      lp += ((Math.random() * 2 - 1) - lp) * (1 - damp);
      d[i] = lp * Math.exp(-t * decay) * (i - pd < sr * 0.004 ? (i - pd) / (sr * 0.004) : 1);
    }
  }
  return ir;
}
let workletUrl = null;
const wurl = () => workletUrl || (workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));

// ---- the graph (live or offline) ------------------------------------------------------------------------------------
async function build(ctx, scene, bufs, lv = LEVEL) {
  await ctx.audioWorklet.addModule(wurl());
  const node = new AudioWorkletNode(ctx, 'nolfe-scrub', { numberOfInputs: 0, numberOfOutputs: STEMS.length, outputChannelCount: STEMS.map(() => 1) });
  node.port.postMessage(STEMS.map((s) => bufs[s].getChannelData(0)));
  const S = scene.sources;
  const pan = (pos, ref, roll) => new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: roll,
    maxDistance: 60, positionX: pos[0], positionY: pos[1], positionZ: pos[2] });
  const bus = new GainNode(ctx), dry = new GainNode(ctx), wet = new GainNode(ctx, { gain: 0 }), master = new GainNode(ctx, { gain: 0 });
  // distance falloff is gentle for Asher (a presence in the room, not louder as you get close)
  const pans = { door: pan(S.door, 1.2, 0.9), steps: pan([0, 0, 0], 0.8, 0.6), growl: pan(S.asher, 3.0, 0.45), mango: pan(S.mango, 3.0, 0.45) };
  pans.steps.panningModel = 'equalpower';            // HRTF straight below the listener sounded metallic
  // per-element cleanup: take the phone mic's boom out of the steps and growl, keep the wood and the throat
  const eq = (...fs) => { const nodes = fs.map(([type, frequency, Q, gain]) => new BiquadFilterNode(ctx, { type, frequency, Q, gain: gain || 0 }));
    nodes.reduce((a, b) => (a.connect(b), b)); return [nodes[0], nodes[nodes.length - 1]]; };
  const chains = { door: eq(['highpass', 70, 0.7]), steps: eq(['highpass', 95, 0.7], ['peaking', 300, 1.0, -3], ['lowpass', 6500, 0.5]),
    growl: eq(['highpass', 70, 0.7], ['peaking', 260, 0.9, -3], ['lowpass', 3400, 0.6]),
    mango: eq(['highpass', 80, 0.7], ['peaking', 260, 0.9, -3], ['lowpass', 3600, 0.6]) };
  // the sinker is the growls' own pulse made solid (tools/build_sinker.py): it starts where the dogs are and, as it sinks,
  // spreads out until it is all around you
  const sinkerOut = new GainNode(ctx, { gain: lv.sinker });
  const D = S.asher.map((v, i) => (v + S.mango[i]) / 2), sinkPlaced = new GainNode(ctx), sinkAround = new GainNode(ctx, { gain: 0 });
  const sinkMaster = new GainNode(ctx, { gain: 0 });
  sinkerOut.connect(pan(D, 3.0, 0.45)).connect(sinkPlaced).connect(sinkMaster); sinkerOut.connect(sinkAround).connect(sinkMaster);
  STEMS.forEach((s, i) => { if (s === 'sinker') { node.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 24, Q: 0.7 }), i).connect(sinkerOut); return; }
    const [a, b] = chains[s]; node.connect(a, i); b.connect(pans[s]);
    pans[s].connect(new GainNode(ctx, { gain: lv[s] })).connect(bus); });
  // the stair light's buzz: mains hum and its harmonics with a little crackle, muffled until the door opens
  const t0 = ctx.currentTime;
  const buzzMix = new GainNode(ctx), buzzTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 400, Q: 0.7 });
  const buzzGain = new GainNode(ctx, { gain: 0 }), buzzPan = pan(S.light, 0.7, 1.3);
  const oscs = [[60, 'sine', 0.3], [120, 'sine', 0.3], [180, 'sine', 0.16], [240, 'sine', 0.08], [360, 'sine', 0.04]].map(([f, type, g]) => {
    const o = new OscillatorNode(ctx, { frequency: f, type }); o.connect(new GainNode(ctx, { gain: g })).connect(buzzMix); o.start(t0); return o;
  });
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.25);   // hum with a little crackle
  const nsrc = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const crackle = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3200, Q: 1.2 });
  nsrc.connect(crackle).connect(new GainNode(ctx, { gain: 0.05 })).connect(buzzMix);
  nsrc.start(t0);
  buzzMix.connect(buzzTone).connect(buzzGain).connect(buzzPan).connect(bus);
  // the collapse: a narrowing band through a tuned resonance (a feedback comb); used by "Skip intro"'s half-second warp
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 900, Q: 0.6 });
  const comb = new DelayNode(ctx, { delayTime: 1 / 170, maxDelayTime: 0.05 }), fb = new GainNode(ctx, { gain: 0 });
  // warmth without mud: light tape-style saturation, sub rumble cleared, a dip in the 'mud' band, a gently rounded top
  const sat = new WaveShaperNode(ctx, { oversample: '2x' }), curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1; curve[i] = Math.tanh(1.15 * x) / Math.tanh(1.15); }
  sat.curve = curve;
  const sub = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 45, Q: 0.7 });
  const body = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 220, Q: 0.9, gain: -3 });
  const soft = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 6000, gain: -2.5 });
  const warm = new GainNode(ctx);
  bus.connect(new GainNode(ctx, { gain: 0.9 })).connect(sat).connect(sub).connect(body).connect(soft).connect(warm);
  warm.connect(dry).connect(master);
  warm.connect(band); band.connect(comb); comb.connect(fb).connect(comb); band.connect(wet); comb.connect(wet); wet.connect(master);
  const comp = new DynamicsCompressorNode(ctx, { threshold: -26, knee: 10, ratio: 2, attack: 0.03, release: 0.35 });   // glue, not grab
  // a little room: short, warm, wooden (a generated impulse response, damped highs, ~1.6 s)
  const verb = new ConvolverNode(ctx, { buffer: roomIR(ctx, 1.6, 0.018) }), verbSend = new GainNode(ctx, { gain: 0.22 });
  const verbHP = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 220, Q: 0.6 }), verbLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000, Q: 0.6 });
  const out = new GainNode(ctx, { gain: 1.0 });
  master.connect(out); master.connect(verbSend).connect(verbHP).connect(verbLP).connect(verb).connect(out);
  // the sinker skips the room's saturation and opens into a long, dark, slowly-dying space: the silent fourth dimension
  const voidVerb = new ConvolverNode(ctx, { buffer: roomIR(ctx, 5.0, 0.04, 1.3, 0.8) });
  sinkMaster.connect(out); sinkMaster.connect(new GainNode(ctx, { gain: 0.3 })).connect(voidVerb).connect(out);
  const mains = [master, sinkMaster];
  out.connect(comp).connect(ctx.destination);
  const L = ctx.listener;
  const lp = L.positionX ? [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ] : null;
  const fps = scene.fps, frames = scene.listener, n = frames.length;
  // the tail (tools/build_sinker.py): from the first golden glow everything vibrates slower and decrescendos together.
  // The stems carry it already; the live hum follows the same per-frame rate and fade.
  const T = scene.tail || null, tf = (arr, fx) => { if (!arr) return 1; const a = Math.max(0, Math.min(arr.length - 1, Math.floor(fx))), b = Math.min(arr.length - 1, a + 1); return arr[a] + (arr[b] - arr[a]) * Math.max(0, Math.min(1, fx - a)); };
  const glowF = T ? T.glow * fps : 180, endF = T ? T.end * fps : 347;
  const at = (fx) => { const a = Math.max(0, Math.min(n - 1, Math.floor(fx))), b = Math.min(n - 1, a + 1), t = Math.max(0, Math.min(1, fx - a));
    return frames[a].map((v, i) => v + (frames[b][i] - v) * t); };
  const playhead = node.parameters.get('playhead');
  let held = false, gainUser = 1;
  // set every parameter for scroll position x (frames) at time `when`; live = smooth toward it, offline = ramp to it
  function apply(x, when, live) {
    const set = (param, v) => { if (live) param.setTargetAtTime(v, when, 0.035); else param.linearRampToValueAtTime(v, when); };
    const l = at(x);
    if (lp) for (let i = 0; i < 9; i++) set(lp[i], l[i]);
    else { L.setPosition(l[0], l[1], l[2]); L.setOrientation(l[3], l[4], l[5], l[6], l[7], l[8]); }
    set(pans.steps.positionX, l[0] - l[6] * 1.1 + l[3] * 0.6); set(pans.steps.positionY, l[1] - l[7] * 1.1 + l[4] * 0.6);
    set(pans.steps.positionZ, l[2] - l[8] * 1.1 + l[5] * 0.6);
    if (!held) set(playhead, x / fps);
    const open = smooth(scene.door_swing[0], scene.door_swing[1], x);
    const rate = tf(T && T.rate, x), fade = tf(T && T.fade, x), end = 1 - smooth(352, 369, x);
    set(buzzGain.gain, lv.buzz * (0.25 + 0.75 * open) * fade); set(buzzTone.frequency, lerp(420, 1500, open) * Math.max(0.3, rate));
    oscs.forEach((o, i) => set(o.frequency, [60, 120, 180, 240, 360][i] * rate));   // the hum slows with everything else
    set(crackle.frequency, 3200 * rate);
    const around = smooth(glowF + 20, endF - 25, x);
    set(sinkPlaced.gain, 1 - around); set(sinkAround.gain, around);
    for (const m of mains) set(m.gain, gainUser * end);
  }
  return {
    ctx, apply,
    setUser(v, when) { gainUser = v; for (const m of mains) m.gain.setTargetAtTime(v, when, 0.06); },
    // skip: hold the stems, collapse everything into the resonance and fade out over the warp
    warp(ms) {
      held = true; const now = ctx.currentTime, d = ms / 1000;
      for (const [p, v] of [[dry.gain, 0], [band.Q, 16], [fb.gain, 0.86]]) { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, d * 0.25); }
      band.frequency.cancelScheduledValues(now); band.frequency.setValueAtTime(band.frequency.value, now); band.frequency.exponentialRampToValueAtTime(140, now + d);
      wet.gain.cancelScheduledValues(now); wet.gain.setValueAtTime(wet.gain.value, now); wet.gain.linearRampToValueAtTime(1.0, now + d * 0.5); wet.gain.linearRampToValueAtTime(0, now + d);
      oscs.forEach((o) => { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(o.frequency.value, now); o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.5, now + d); });
      for (const m of mains) { m.gain.cancelScheduledValues(now); m.gain.setValueAtTime(m.gain.value, now); m.gain.linearRampToValueAtTime(0, now + d + 0.1); }
    },
    fadeOut(s) { const now = ctx.currentTime; for (const m of mains) { m.gain.cancelScheduledValues(now); m.gain.setValueAtTime(m.gain.value, now); m.gain.linearRampToValueAtTime(0, now + s); } },
  };
}

// ---- loading ----------------------------------------------------------------------------------------------------------
let raw = null, loading = null;
function fetchAll() {
  if (loading) return loading;
  const base = CFG.base;
  loading = Promise.all([fetch(base + 'audio_scene.json').then((r) => r.json()),
    fetch(base + 'audio/tail.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ...STEMS.map((s) => fetch(base + 'audio/' + s + '.m4a').then((r) => { if (!r.ok) throw Error(s); return r.arrayBuffer(); }))])
    .then(([scene, tail, ...abs]) => (raw = { scene: Object.assign(scene, { tail }), abs })).catch((e) => { stats.error = String(e); raw = null; });
  return loading;
}
async function decode(ctx) { const out = {}; await Promise.all(STEMS.map(async (s, i) => { out[s] = await ctx.decodeAudioData(raw.abs[i].slice(0)); })); return out; }

// ---- live -----------------------------------------------------------------------------------------------------------
const stats = { enabled: !OFF, state: 'idle', error: null, muted: false };
let ctx = null, graph = null, starting = null, lastX = 0, muted = false, ended = false;
const btn = document.getElementById('sound-toggle');
async function start() {
  if (OFF || ended) return;
  if (starting) return starting;
  starting = (async () => {
    ctx = new AC({ latencyHint: 'interactive' });
    stats.state = 'loading';
    await fetchAll(); if (!raw) { stats.state = 'unavailable'; return; }
    const bufs = await decode(ctx);
    graph = await build(ctx, raw.scene, bufs);
    graph.apply(lastX, ctx.currentTime, true);
    graph.setUser(muted ? 0 : 1, ctx.currentTime);
    if (ctx.state !== 'running') await ctx.resume();
    stats.state = ctx.state;
  })().catch((e) => { stats.error = String(e); stats.state = 'failed'; });
  return starting;
}
function unlock() {
  if (ended) return;
  if (ctx && ctx.state !== 'running') ctx.resume().then(() => (stats.state = ctx.state));
  else if (!ctx && !muted) start();
}
function setMuted(m) {
  muted = stats.muted = m;
  if (btn) { btn.setAttribute('aria-pressed', String(!m)); btn.setAttribute('aria-label', m ? 'Sound off' : 'Sound on'); btn.classList.toggle('off', m); }
  if (graph) graph.setUser(m ? 0 : 1, ctx.currentTime);
  if (!m) unlock();
}
const gestureEvents = ['pointerdown', 'touchend', 'keydown'];
function onGesture(e) { if (e.target === btn || (btn && btn.contains(e.target))) return; if (!muted) unlock(); if (ctx && ctx.state === 'running') gestureEvents.forEach((t) => removeEventListener(t, onGesture, true)); }
let invited = false;
function onWheelInvite() { if (invited || ctx || muted || !btn) return; invited = true; btn.classList.add('invite'); setTimeout(() => btn.classList.remove('invite'), 2600); }

window.NolfeIntroAudio = {
  get stats() { return Object.assign({}, stats, { ctx: ctx ? ctx.state : null }); },
  load() { if (!OFF) fetchAll(); },
  frame(x) { lastX = x; if (graph && ctx.state === 'running') graph.apply(x, ctx.currentTime, true); },
  warp(ms) { if (graph) graph.warp(ms); this.end(ms + 250); },
  end(afterMs = 700) {
    if (ended) return; ended = true;
    gestureEvents.forEach((t) => removeEventListener(t, onGesture, true)); removeEventListener('wheel', onWheelInvite, true);
    if (graph && ctx.state === 'running') graph.fadeOut(Math.min(0.6, afterMs / 1000));
    setTimeout(() => { try { ctx && ctx.close(); } catch (e) {} if (btn) btn.remove(); }, afterMs + 100);
  },
  // offline render for previews: `path` is [[seconds, frame], ...] (default: a straight walk at real time)
  async renderOffline({ path = null, sampleRate = 48000, tail = 1.5, solo = null } = {}) {
    await fetchAll(); if (!raw) throw Error('no audio assets');
    const sc = raw.scene; path = path || [[0, 0], [(sc.count - 1) / sc.fps, sc.count - 1]];
    const end = path[path.length - 1][0], dur = end + tail;
    const off = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
    const lv = solo ? Object.fromEntries(Object.keys(LEVEL).map((k) => [k, solo.includes(k) ? LEVEL[k] : 0])) : LEVEL;
    const g = await build(off, sc, await decode(off), lv);
    g.setUser(1, 0);
    const fAt = (t) => { for (let i = 1; i < path.length; i++) if (t <= path[i][0]) { const [t0, f0] = path[i - 1], [t1, f1] = path[i]; return f0 + (f1 - f0) * (t - t0) / Math.max(1e-6, t1 - t0); } return path[path.length - 1][1]; };
    for (let t = 0; t <= end + 1e-9; t += 1 / 60) g.apply(fAt(t), t + 1e-4, false);
    return off.startRendering();
  },
};
if (!OFF) {
  if (btn) { btn.hidden = false; btn.addEventListener('click', (e) => { e.stopPropagation(); setMuted(!muted); if (!muted) start(); }); }
  gestureEvents.forEach((t) => addEventListener(t, onGesture, true));
  addEventListener('wheel', onWheelInvite, { capture: true, passive: true });
} else if (btn) btn.remove();
})();

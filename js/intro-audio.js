/* Nolfe — entrance sound.
   Each sound is driven the way it behaves in the space:
   * Events, tied to the swipe. The door and each footstep fire as one-shots at their natural speed when you slide
     forward past them, so going forward always sounds natural, however fast or jerky the scroll. Sliding backward
     scrubs the same sounds in reverse at the speed you slide: the DJ-scratch blend.
   * States, in real time. The stair light's buzz is synthesized live (muffled until the door opens). Each dog's growl
     loops at its natural speed while its head is up: it begins as the head rises and stops if you scroll back until it
     lowers. Sliding backward plays the growls backward too, at the speed you slide, from where they were; pause for a
     second and the growling fades out, and it comes back when you move.
   * The sinker. Once you pass Asher a live bass drone on the growls' own pulse rises, every sound starts to slow (the
     growls, the buzz, the footsteps) and the room blurs into a long dark wash: the further you swipe, the more
     everything blends together and fades, along the curve of the owner's reference recording, silent at the threshold.
   Sounds live where their sources are (HRTF panners; the listener rides the camera's path). Sound is off when the page
   loads: the speaker button turns it on (and off). Turning it on also switches an iPhone into media playback (the Audio
   Session API where there is one, plus a looping silent <audio> element), so it plays even with the ringer switch on
   silent. ?sound=off removes it; off with reduced motion.
   Test switches: ?verb=0.22 sets the room reverb send (default 0.11), ?sinker=off leaves out the sinker.
   The same graph renders offline (NolfeIntroAudio.renderOffline) for previews. Assets: tools/build_audio.py. */
(function () {
'use strict';
const Q = new URLSearchParams(location.search);
const CFG = Object.assign({ base: 'intro/' }, window.NOLFE_INTRO_CONFIG || {});
const AC = window.AudioContext || window.webkitAudioContext;
const REDUCED = Q.get('motion') === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const OFF = Q.get('sound') === 'off' || REDUCED || !AC || !window.AudioWorkletNode;
const STEMS = ['door', 'steps'];                                   // scrubbed: heard only while sliding backward
const LOOPS = { growl: 'asher_loop', mango: 'mango_loop' };        // real time, while each dog's head is up
const FILES = [...STEMS, 'kit', ...Object.values(LOOPS)];
const LEVEL = { door: 0.55, steps: 0.3, growl: 0.24, mango: 0.24, sinker: 0.022, buzz: 0.06 };
const ROOM_VERB = Q.has('verb') ? Math.max(0, +Q.get('verb') || 0) : 0.11;   // room reverb send (was 0.22)
const SINKER_ON = Q.get('sinker') !== 'off';
const SINK_SEMIS = 24, PULSE_HZ = 52;                              // how far everything slows; the growls' own pulse
const STEP_GAP = 0.14;                                             // footsteps never closer than this (a fast swipe)
const BUZZ_F = [60, 120, 180, 240, 360];
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
async function build(ctx, scene, ev, bufs, lv = LEVEL) {
  await ctx.audioWorklet.addModule(wurl());
  const node = new AudioWorkletNode(ctx, 'nolfe-scrub', { numberOfInputs: 0, numberOfOutputs: STEMS.length, outputChannelCount: STEMS.map(() => 1) });
  node.port.postMessage(STEMS.map((s) => bufs[s].getChannelData(0)));
  const S = scene.sources, t0 = ctx.currentTime;
  const pan = (pos, ref, roll) => new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: roll,
    maxDistance: 60, positionX: pos[0], positionY: pos[1], positionZ: pos[2] });
  const bus = new GainNode(ctx), dry = new GainNode(ctx), wet = new GainNode(ctx, { gain: 0 }), master = new GainNode(ctx, { gain: 0 });
  // where each sound lives; distance falloff is gentle for the dogs (a presence in the room, not louder as you get close)
  const pans = { door: pan(S.door, 1.2, 0.9), steps: pan([0, 0, 0], 0.8, 0.6), growl: pan(S.asher, 3.0, 0.45), mango: pan(S.mango, 3.0, 0.45) };
  pans.steps.panningModel = 'equalpower';            // HRTF straight below the listener sounded metallic
  // per-element cleanup: take the phone mic's boom out of the steps and growls, keep the wood and the throat
  const eq = (...fs) => { const nodes = fs.map(([type, frequency, Q, gain]) => new BiquadFilterNode(ctx, { type, frequency, Q, gain: gain || 0 }));
    nodes.reduce((a, b) => (a.connect(b), b)); return [nodes[0], nodes[nodes.length - 1]]; };
  const chains = { door: eq(['highpass', 70, 0.7]), steps: eq(['highpass', 95, 0.7], ['peaking', 300, 1.0, -3], ['lowpass', 6500, 0.5]),
    growl: eq(['highpass', 70, 0.7], ['peaking', 260, 0.9, -3], ['lowpass', 3400, 0.6]),
    mango: eq(['highpass', 80, 0.7], ['peaking', 260, 0.9, -3], ['lowpass', 3600, 0.6]) };
  for (const s in chains) { chains[s][1].connect(pans[s]); pans[s].connect(new GainNode(ctx, { gain: lv[s] })).connect(bus); }

  // events: one-shots at natural speed going forward; the reverse scrub of the same sounds, opened only going backward
  const scrub = {};
  STEMS.forEach((s, i) => { scrub[s] = new GainNode(ctx, { gain: 0 }); node.connect(scrub[s], i).connect(chains[s][0]); });
  let rate = 1;                                      // the sinker's slowing: 1 = natural speed
  const shot = (s, k, when) => {
    const [o, d] = ev.kit[k], src = new AudioBufferSourceNode(ctx, { buffer: bufs.kit, playbackRate: rate });
    src.connect(chains[s][0]); src.start(when, o, d); stats.shots++;
  };

  // states: each dog's growl loops at natural speed while its head is up
  // ... and backward (from the same point in the loop, at the speed you slide) when you slide backward
  const loopLevel = { growl: new GainNode(ctx), mango: new GainNode(ctx) }, voices = { growl: null, mango: null };
  for (const s in loopLevel) loopLevel[s].connect(chains[s][0]);
  const reversed = (b) => { const r = ctx.createBuffer(1, b.length, b.sampleRate), a = b.getChannelData(0), d = r.getChannelData(0);
    for (let i = 0, k = a.length - 1; k >= 0; i++, k--) d[i] = a[k]; return r; };
  const loopBuf = {}, pos = { growl: 0, mango: 0 };                // pos: seconds into the forward loop
  for (const s in LOOPS) { const f = bufs[LOOPS[s]]; loopBuf[s] = { f, r: reversed(f), L: f.duration }; }
  const voiceOn = (s, when, dir, pr, rise) => {
    const lb = loopBuf[s], off = ((dir > 0 ? pos[s] : lb.L - pos[s]) % lb.L + lb.L) % lb.L;
    const src = new AudioBufferSourceNode(ctx, { buffer: dir > 0 ? lb.f : lb.r, loop: true, playbackRate: pr }), g = new GainNode(ctx, { gain: 0 });
    src.connect(g).connect(loopLevel[s]); g.gain.setValueAtTime(0, when); g.gain.setTargetAtTime(1, when, rise / 3); src.start(when, off);
    voices[s] = { src, g, dir, pr };
  };
  const voiceOff = (s, when, tc = 0.15) => {
    const v = voices[s]; voices[s] = null;
    v.g.gain.cancelScheduledValues(when); v.g.gain.setTargetAtTime(0, when, tc); v.src.stop(when + tc * 8);
  };
  const gateOn = (s, when, rise, dir, pr) => { pos[s] = 0; voiceOn(s, when, dir, pr, rise); };   // the head rises: the growl begins
  const gateOff = (s, when) => voiceOff(s, when);
  // the stair light's buzz: mains hum and its harmonics with a little crackle, muffled until the door opens
  const buzzMix = new GainNode(ctx), buzzTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 400, Q: 0.7 });
  const buzzGain = new GainNode(ctx, { gain: 0 }), buzzPan = pan(S.light, 0.7, 1.3);
  const oscs = [0.3, 0.3, 0.16, 0.08, 0.04].map((g, i) => {
    const o = new OscillatorNode(ctx, { frequency: BUZZ_F[i], type: 'sine' }); o.connect(new GainNode(ctx, { gain: g })).connect(buzzMix); o.start(t0); return o;
  });
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.25);   // hum with a little crackle
  const nsrc = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  const crackle = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3200, Q: 1.2 });
  nsrc.connect(crackle).connect(new GainNode(ctx, { gain: 0.05 })).connect(buzzMix); nsrc.start(t0);
  buzzMix.connect(buzzTone).connect(buzzGain).connect(buzzPan).connect(bus);

  // the room: warmth without mud (light tape saturation, sub rumble cleared, a dip in the mud band, a rounded top)
  const sat = new WaveShaperNode(ctx, { oversample: '2x' }), curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1; curve[i] = Math.tanh(1.15 * x) / Math.tanh(1.15); }
  sat.curve = curve;
  const sub = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 45, Q: 0.7 });
  const body = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 220, Q: 0.9, gain: -3 });
  const soft = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 6000, gain: -2.5 });
  const warm = new GainNode(ctx);
  bus.connect(new GainNode(ctx, { gain: 0.9 })).connect(sat).connect(sub).connect(body).connect(soft).connect(warm);
  warm.connect(dry).connect(master);
  // "Skip intro"'s half-second warp: everything squeezed through a narrowing band and a tuned resonance (a feedback comb)
  const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 900, Q: 0.6 });
  const comb = new DelayNode(ctx, { delayTime: 1 / 170, maxDelayTime: 0.05 }), fb = new GainNode(ctx, { gain: 0 });
  warm.connect(band); band.connect(comb); comb.connect(fb).connect(comb); band.connect(wet); comb.connect(wet); wet.connect(master);

  // the sinker: a bass drone on the growls' own pulse (a clean sub that owns the fundamental, and an analog texture of
  // two detuned saws, harmonics only, through a resonant low-pass), slowing with everything else. It starts where the
  // dogs are and spreads out around you.
  const dSub = new OscillatorNode(ctx, { type: 'sine', frequency: PULSE_HZ });
  const sawA = new OscillatorNode(ctx, { type: 'sawtooth', frequency: PULSE_HZ, detune: -6 }), sawB = new OscillatorNode(ctx, { type: 'sawtooth', frequency: PULSE_HZ, detune: 6 });
  const texHP = new BiquadFilterNode(ctx, { type: 'highpass', frequency: PULSE_HZ * 1.5, Q: 0.7 });
  const texLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: PULSE_HZ * 8, Q: 4 });
  const droneMix = new GainNode(ctx), droneGain = new GainNode(ctx, { gain: 0 });
  dSub.connect(new GainNode(ctx, { gain: 0.6 })).connect(droneMix);
  sawA.connect(texHP); sawB.connect(texHP); texHP.connect(texLP).connect(new GainNode(ctx, { gain: 0.35 })).connect(droneMix);
  droneMix.connect(droneGain);
  [dSub, sawA, sawB].forEach((o) => o.start(t0));
  const dogs = S.asher.map((v, i) => (v + S.mango[i]) / 2), droneHere = new GainNode(ctx), droneAround = new GainNode(ctx, { gain: 0 });
  droneGain.connect(pan(dogs, 3.0, 0.45)).connect(droneHere).connect(master); droneGain.connect(droneAround).connect(master);
  // the blur: the room (and the drone) sent into a long, dark, diffuse wash through a slowly wavering smear, so the sounds
  // run into each other; the further past Asher, the more of it
  const blurSend = new GainNode(ctx, { gain: 0 }), smear = new GainNode(ctx);
  for (const [ms, hz] of [[23, 0.13], [37, 0.21]]) {
    const dl = new DelayNode(ctx, { delayTime: ms / 1000, maxDelayTime: 0.1 }), lfo = new OscillatorNode(ctx, { frequency: hz });
    lfo.connect(new GainNode(ctx, { gain: 0.006 })).connect(dl.delayTime); lfo.start(t0);
    blurSend.connect(dl).connect(smear); dl.connect(new GainNode(ctx, { gain: 0.35 })).connect(dl);
  }
  blurSend.connect(smear);
  const blur = new ConvolverNode(ctx, { buffer: roomIR(ctx, 6.0, 0.06, 1.1, 0.85) });
  const blurTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.5 });
  smear.connect(blur).connect(blurTone).connect(master);
  warm.connect(blurSend); droneGain.connect(blurSend);

  // a little room (lowered: send 0.11, was 0.22), then glue
  const comp = new DynamicsCompressorNode(ctx, { threshold: -26, knee: 10, ratio: 2, attack: 0.03, release: 0.35 });
  const verb = new ConvolverNode(ctx, { buffer: roomIR(ctx, 1.6, 0.018) }), verbSend = new GainNode(ctx, { gain: ROOM_VERB });
  const verbHP = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 220, Q: 0.6 }), verbLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000, Q: 0.6 });
  const out = new GainNode(ctx, { gain: 1.0 });
  master.connect(out); master.connect(verbSend).connect(verbHP).connect(verbLP).connect(verb).connect(out);
  out.connect(comp).connect(ctx.destination);

  const L = ctx.listener;
  const lp = L.positionX ? [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ] : null;
  const fps = scene.fps, frames = scene.listener, n = frames.length;
  const at = (fx) => { const a = Math.max(0, Math.min(n - 1, Math.floor(fx))), b = Math.min(n - 1, a + 1), t = Math.max(0, Math.min(1, fx - a));
    return frames[a].map((v, i) => v + (frames[b][i] - v) * t); };
  const fadeAt = (p) => { const f = ev.fade, i = Math.min(f.length - 2, Math.floor(p * (f.length - 1))), t = p * (f.length - 1) - i; return f[i] + (f[i + 1] - f[i]) * t; };
  const playhead = node.parameters.get('playhead');
  let held = false, gainUser = 1, lastX = null, lastT = 0, vel = 0, rev = false, lastStep = -1, lastMove = 0, idle = 1;
  // set every parameter for scroll position x (frames) at time `when`; live = smooth toward it, offline = ramp to it
  function apply(x, when, live) {
    const set = (param, v) => { if (live) param.setTargetAtTime(v, when, 0.035); else param.linearRampToValueAtTime(v, when); };
    const l = at(x);
    if (lp) for (let i = 0; i < 9; i++) set(lp[i], l[i]);
    else { L.setPosition(l[0], l[1], l[2]); L.setOrientation(l[3], l[4], l[5], l[6], l[7], l[8]); }
    set(pans.steps.positionX, l[0] - l[6] * 1.1 + l[3] * 0.6); set(pans.steps.positionY, l[1] - l[7] * 1.1 + l[4] * 0.6);
    set(pans.steps.positionZ, l[2] - l[8] * 1.1 + l[5] * 0.6);
    if (!held) set(playhead, x / fps);

    // which way the swipe is going (smoothed, with hysteresis so a jittery trackpad doesn't flip it)
    if (lastX === null) { lastX = x; lastT = when; lastMove = when; }
    const dt = Math.max(1e-3, when - lastT), dx = x - lastX;
    vel += (dx / dt - vel) * Math.min(1, dt / 0.08);
    if (!rev && vel < -6) rev = true; else if (rev && vel > -1.5) rev = false;
    for (const s of STEMS) set(scrub[s].gain, rev && !held ? 1 : 0);
    // events: fire as you slide forward past them (a jump of more than ~1.5 s fires nothing)
    if (dx > 0 && dx < 36 && !rev && !held) {
      if (lastX < ev.door.f && x >= ev.door.f) shot('door', ev.door.k, when);
      let hit = null; for (const e of ev.steps) if (lastX < e.f && x >= e.f) hit = e;
      if (hit && when - lastStep >= STEP_GAP) { shot('steps', hit.k, when); lastStep = when; }
    }
    lastX = x; lastT = when;

    // the sinker: past Asher everything slows, blurs together and fades as you go on
    const p = SINKER_ON ? Math.max(0, Math.min(1, (x - ev.pass) / (ev.end - ev.pass))) : 0;
    rate = Math.pow(2, -SINK_SEMIS * Math.pow(p, 1.3) / 12);

    // states: each dog's growl loops while its head is up, forward at natural speed, backward at the speed you slide
    const dir = rev ? -1 : 1, pr = rev ? Math.max(0.25, Math.min(3, -vel / fps)) * rate : rate;
    for (const s in voices) { const v = voices[s]; if (v) pos[s] = (pos[s] + v.dir * v.pr * dt) % loopBuf[s].L; }
    const aUp = smooth(ev.asher.up[0], ev.asher.up[1], x), mUp = smooth(ev.mango.up[0], ev.mango.up[1], x);
    if (!held) {
      if (aUp > 0.15 && !voices.growl) gateOn('growl', when, 0.35, dir, pr); else if (aUp < 0.1 && voices.growl) gateOff('growl', when);
      if (mUp > 0.15 && !voices.mango) gateOn('mango', when, 1.4, dir, pr); else if (mUp < 0.1 && voices.mango) gateOff('mango', when);
      for (const s in voices) if (voices[s] && voices[s].dir !== dir) { voiceOff(s, when, 0.025); voiceOn(s, when, dir, pr, 0.06); }   // turn the record around
    }
    for (const s in voices) if (voices[s]) { set(voices[s].src.playbackRate, pr); voices[s].pr = pr; }
    // pause for a second and the growling fades out (over ~0.9 s); it comes back as soon as you move
    if (Math.abs(vel) > 0.5) lastMove = when;
    const idleTo = 1 - smooth(1.0, 1.9, when - lastMove);
    idle = idleTo < idle ? idleTo : idle + (idleTo - idle) * Math.min(1, dt / 0.25);
    // Asher and Mango also grow quieter as you near and pass them
    set(loopLevel.growl.gain, idle * (1 - 0.5 * smooth(ev.asher.up[1], ev.pass, x)));
    set(loopLevel.mango.gain, idle * (1 - 0.6 * smooth(ev.mango.up[1], ev.pass, x)));
    const b = smooth(0, 0.55, p), F = p >= 1 ? 0 : Math.pow(10, fadeAt(p) / 20);
    set(dry.gain, 1 - 0.75 * b); set(blurSend.gain, 1.1 * b); set(blurTone.frequency, lerp(5000, 500, p));
    const f = PULSE_HZ * rate, br = 0.7 * Math.pow(1 - p, 1.3);
    for (const o of [dSub, sawA, sawB]) set(o.frequency, f);
    set(texHP.frequency, f * 1.5); set(texLP.frequency, f * (1.3 + 11 * br));
    set(droneGain.gain, lv.sinker * smooth(0, 0.18, p));
    set(droneHere.gain, 1 - smooth(0.1, 0.8, p)); set(droneAround.gain, smooth(0.1, 0.8, p));
    const open = smooth(scene.door_swing[0], scene.door_swing[1], x);
    set(buzzGain.gain, lv.buzz * (0.25 + 0.75 * open)); set(buzzTone.frequency, lerp(420, 1500, open) * Math.max(0.3, rate));
    oscs.forEach((o, i) => set(o.frequency, BUZZ_F[i] * rate)); set(crackle.frequency, 3200 * rate);
    stats.reverse = rev; stats.sink = +p.toFixed(3); stats.dogs = +idle.toFixed(2);
    set(master.gain, gainUser * (1 - smooth(352, 369, x)) * F);
  }
  return {
    ctx, apply,
    setUser(v, when) { gainUser = v; master.gain.setTargetAtTime(v, when, 0.06); },
    // skip: hold everything, collapse it into the resonance and fade out over the warp
    warp(ms) {
      held = true; const now = ctx.currentTime, d = ms / 1000;
      for (const [p, v] of [[dry.gain, 0], [band.Q, 16], [fb.gain, 0.86]]) { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, d * 0.25); }
      band.frequency.cancelScheduledValues(now); band.frequency.setValueAtTime(band.frequency.value, now); band.frequency.exponentialRampToValueAtTime(140, now + d);
      wet.gain.cancelScheduledValues(now); wet.gain.setValueAtTime(wet.gain.value, now); wet.gain.linearRampToValueAtTime(1.0, now + d * 0.5); wet.gain.linearRampToValueAtTime(0, now + d);
      oscs.forEach((o) => { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(o.frequency.value, now); o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.5, now + d); });
      master.gain.cancelScheduledValues(now); master.gain.setValueAtTime(master.gain.value, now); master.gain.linearRampToValueAtTime(0, now + d + 0.1);
    },
    fadeOut(s) { const now = ctx.currentTime; master.gain.cancelScheduledValues(now); master.gain.setValueAtTime(master.gain.value, now); master.gain.linearRampToValueAtTime(0, now + s); },
  };
}

// ---- loading ----------------------------------------------------------------------------------------------------------
let raw = null, loading = null;
function fetchAll() {
  if (loading) return loading;
  const base = CFG.base;
  loading = Promise.all([fetch(base + 'audio_scene.json').then((r) => r.json()), fetch(base + 'audio/events.json').then((r) => r.json()),
    ...FILES.map((s) => fetch(base + 'audio/' + s + '.m4a').then((r) => { if (!r.ok) throw Error(s); return r.arrayBuffer(); }))])
    .then(([scene, ev, ...abs]) => (raw = { scene, ev, abs })).catch((e) => { stats.error = String(e); raw = null; });
  return loading;
}
async function decode(ctx) { const out = {}; await Promise.all(FILES.map(async (s, i) => { out[s] = await ctx.decodeAudioData(raw.abs[i].slice(0)); })); return out; }

// ---- live -----------------------------------------------------------------------------------------------------------
const stats = { enabled: !OFF, state: 'idle', error: null, muted: true, shots: 0, reverse: false, sink: 0, dogs: 1 };
let ctx = null, graph = null, starting = null, lastX = 0, muted = true, ended = false;   // off until the speaker button
const btn = document.getElementById('sound-toggle');
async function start() {
  if (OFF || ended) return;
  if (starting) return starting;
  starting = (async () => {
    ctx = new AC({ latencyHint: 'interactive' });
    ctx.resume().catch(() => {});                    // still inside the button's click: iOS needs the resume here
    stats.state = 'loading';
    await fetchAll(); if (!raw) { stats.state = 'unavailable'; return; }
    const bufs = await decode(ctx);
    graph = await build(ctx, raw.scene, raw.ev, bufs);
    graph.apply(lastX, ctx.currentTime, true);
    graph.setUser(muted ? 0 : 1, ctx.currentTime);
    if (ctx.state !== 'running') await ctx.resume();
    stats.state = ctx.state;
  })().catch((e) => { stats.error = String(e); stats.state = 'failed'; });
  return starting;
}
// iPhones: Web Audio normally follows the ringer switch. Once the visitor turns sound on, ask for media playback (the
// Audio Session API where it exists) and keep a silent <audio> element looping, which puts the page in the same
// playback mode on older iOS, so the intro plays even on silent. Both are released when sound is turned off or ends.
let keeper = null;
function silentWav() {
  const sr = 8000, n = sr / 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function playThroughSilent(on) {
  try { if (navigator.audioSession) navigator.audioSession.type = on ? 'playback' : 'auto'; } catch (e) {}
  try {
    if (on) {
      if (!keeper) { keeper = new Audio(silentWav()); keeper.loop = true; keeper.setAttribute('playsinline', ''); keeper.setAttribute('aria-hidden', 'true'); }
      const p = keeper.play(); if (p && p.catch) p.catch(() => {});
    } else if (keeper) keeper.pause();
  } catch (e) {}
}
function setMuted(m) {
  muted = stats.muted = m;
  if (btn) { btn.setAttribute('aria-pressed', String(!m)); btn.setAttribute('aria-label', m ? 'Turn sound on' : 'Turn sound off'); btn.classList.toggle('off', m); }
  if (ended) return;
  playThroughSilent(!m);
  if (!m) { if (!ctx) start(); else if (ctx.state !== 'running') ctx.resume().then(() => (stats.state = ctx.state)).catch(() => {}); }
  if (graph) graph.setUser(m ? 0 : 1, ctx.currentTime);
}
// a tap or key press elsewhere never starts sound; while it is off, the first one (or the first wheel) pulses the
// speaker button once as an invitation. If the system suspends sound while it is on (a call, say), a tap resumes it.
const gestureEvents = ['pointerdown', 'touchend', 'keydown'];
let invited = false;
function invite() { if (invited || !btn || !muted) return; invited = true; btn.classList.add('invite'); setTimeout(() => btn.classList.remove('invite'), 2600); }
function onGesture(e) {
  if (btn && (e.target === btn || btn.contains(e.target))) return;
  if (muted) invite(); else if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
const onWheelInvite = () => invite();

window.NolfeIntroAudio = {
  get stats() { return Object.assign({}, stats, { ctx: ctx ? ctx.state : (ended ? 'closed' : null) }); },
  load() { if (!OFF && !ended) fetchAll(); },
  frame(x) { lastX = x; if (graph && ctx && ctx.state === 'running') graph.apply(x, ctx.currentTime, true); },
  warp(ms) { if (graph) graph.warp(ms); this.end(ms + 250); },
  end(afterMs = 700) {
    if (ended) return; ended = true;
    gestureEvents.forEach((t) => removeEventListener(t, onGesture, true)); removeEventListener('wheel', onWheelInvite, true);
    if (graph && ctx.state === 'running') graph.fadeOut(Math.min(0.6, afterMs / 1000));
    setTimeout(() => { try { ctx && ctx.close(); } catch (e) {} playThroughSilent(false); if (btn) btn.remove();
      graph = null; raw = null; loading = null; ctx = null; }, afterMs + 100);   // let the decoded sound go once it's over
  },
  // offline render for previews: `path` is [[seconds, frame], ...] (default: a straight walk at real time)
  async renderOffline({ path = null, sampleRate = 48000, tail = 1.5, solo = null } = {}) {
    await fetchAll(); if (!raw) throw Error('no audio assets');
    const sc = raw.scene; path = path || [[0, 0], [(sc.count - 1) / sc.fps, sc.count - 1]];
    const end = path[path.length - 1][0], dur = end + tail;
    const off = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
    const lv = solo ? Object.fromEntries(Object.keys(LEVEL).map((k) => [k, solo.includes(k) ? LEVEL[k] : 0])) : LEVEL;
    const g = await build(off, sc, raw.ev, await decode(off), lv);
    g.setUser(1, 0);
    const fAt = (t) => { for (let i = 1; i < path.length; i++) if (t <= path[i][0]) { const [t0, f0] = path[i - 1], [t1, f1] = path[i]; return f0 + (f1 - f0) * (t - t0) / Math.max(1e-6, t1 - t0); } return path[path.length - 1][1]; };
    for (let t = 0; t <= end + 1e-9; t += 1 / 60) g.apply(fAt(t), t + 1e-4, false);
    return off.startRendering();
  },
};
if (!OFF) {
  if (btn) { btn.hidden = false; setMuted(true); btn.addEventListener('click', (e) => { e.stopPropagation(); setMuted(!muted); }); }
  gestureEvents.forEach((t) => addEventListener(t, onGesture, true));
  addEventListener('wheel', onWheelInvite, { capture: true, passive: true });
} else if (btn) btn.remove();
})();

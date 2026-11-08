/* Nolfe — entrance player.
   Vertical input (swipe up / wheel / trackpad / keys) scrubs a pre-rendered camera move; stopping input lets it
   settle and pause; reversing retraces. Horizontal input is ignored. When the shot reaches the doorway into the
   void, the live time block (already drawing the identical view underneath) takes over, the entrance is torn down
   and cannot come back for this page instance.

   URL switches for testing: ?intro=seq|video|off  ?format=jpg|webp  ?gop=8  ?orient=landscape|portrait
                             ?motion=reduce  ?debug  ?warpms=4160 (slow-motion skip, for recording)
   Skip intro: a half-second warp through the rest of the shot and the portal (plain fade with reduced motion). */
(function () {
'use strict';
const Entry = window.NolfeEntry;
const TB = () => window.NolfeTimeBlock;
const AUD = () => window.NolfeIntroAudio;
const Q = new URLSearchParams(location.search);
const CFG = Object.assign({ base: 'intro/', mode: 'seq', format: 'jpg' }, window.NOLFE_INTRO_CONFIG || {});
const MODE = Q.get('intro') || CFG.mode;
let FORMAT = Q.get('format') || CFG.format;
const VIDEO_KIND = Q.get('gop') === '8' ? 'mp4_gop8' : 'mp4_intra';
const DEBUG = Q.has('debug');
const REDUCED = Q.get('motion') === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- tuning -------------------------------------------------------------------------------------------
const WHEEL_PX_JOURNEY = 4300;   // wheel/trackpad delta for the whole entrance at a gentle pace (was 5200)
const SWIPE_SCREENS = 3.75;      // full-height upward swipes for the whole entrance at a gentle pace (was 4.5)
const KEY_STEP = 24;             // frames per key press (one second of the shot)
const VMAX = 84;                 // frames/s cap: at most 3.5x the rendered pace, so hard swipes really move faster
// How hard or fast you swipe: gentle input moves 1:1 (precise); faster input travels further, up to ACCEL_MAX x, on
// a smooth curve between a slow and a fast speed (wheel/trackpad in px/s, touch in screen-heights/s)
const ACCEL_MAX = 2.2, WHEEL_SLOW = 700, WHEEL_FAST = 4500, SWIPE_SLOW = 0.5, SWIPE_FAST = 3.0;
const accel = (v, slow, fast) => 1 + (ACCEL_MAX - 1) * Math.pow(Math.max(0, Math.min(1, (v - slow) / (fast - slow))), 1.3);
const K_TARGET = 9, K_FOLLOW = 7;// two cascaded lags: smooth start, no overshoot
const INERTIA_TAU = 0.42;        // s, swipe coast
const DECODE_CAP = 24;           // decoded frames held (~2 MB each at 960x540)
const DECODE_CONC = 3, FETCH_CONC = 6;
const LIFT = 0.16;               // peak exposure lift that hides the handoff

const root = document.getElementById('intro');
const cv = document.getElementById('intro-canvas');
const ctx = cv.getContext('2d', { alpha: false });
const video = document.getElementById('intro-video');
const grainEl = document.getElementById('intro-grain');
const hint = document.getElementById('intro-hint');
const skipBtn = document.getElementById('skip-intro');
const stage = document.getElementById('stage');

const S = window.NolfeIntroStats = { mode: REDUCED ? 'reduced' : MODE, format: FORMAT, orient: null, loaded: 0, bytes: 0,
  decoded: 0, peakDecoded: 0, decodeMs: [], seekMs: [], stale: 0, drawn: 0, firstPaint: null, crossedAt: null,
  t0: performance.now(), fail: null, crossV0: null };

let man, set, orient, H = 370, fps = 24, look = [];
let x = 0, xs = 0, xt = 0, vel = 0, inertia = 0;
let crossingStarted = false, alive = true, lastT = performance.now(), cutAt = 0, waitSince = 0;
const aborter = new AbortController();

// ---- loading: compressed frames in memory, a small decoded window around the camera ----------------------
let gen = 0, inflight = 0, decodingN = 0;
const blobs = new Map(), bitmaps = new Map(), fetching = new Set(), decoding = new Set(), tries = new Map();
let queue = [];
const pad4 = (i) => String(i).padStart(4, '0');
const frameUrl = (i) => CFG.base + set[FORMAT].pattern.replace('%04d', pad4(i));
function coarseToFine() {
  const seen = new Set(), out = [];
  for (const step of [16, 8, 4, 2, 1]) for (let i = 0; i <= H; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
  return out;
}
function nextToFetch() {
  const c = Math.floor(x), dir = vel < -0.5 ? -1 : 1;
  for (let k = 0; k <= 36; k++) { const i = c + k * dir; if (i >= 0 && i <= H && !blobs.has(i) && !fetching.has(i)) return i; }
  while (queue.length) { const i = queue.shift(); if (!blobs.has(i) && !fetching.has(i)) return i; }
  return -1;
}
function pump() {
  if (!alive || MODE === 'video') return;
  while (inflight < FETCH_CONC) {
    const i = nextToFetch(); if (i < 0) return;
    const g = gen; inflight++; fetching.add(i);
    fetch(frameUrl(i), { signal: aborter.signal })
      .then((r) => { if (!r.ok) throw Error('HTTP ' + r.status); return r.blob(); })
      .then((b) => { if (g !== gen) return; blobs.set(i, b); S.loaded++; S.bytes += b.size; })
      .catch((e) => { if (!alive || g !== gen) return; const n = (tries.get(i) || 0) + 1; tries.set(i, n);
        if (n < 3) queue.push(i); else if (i === 0) fail('poster'); })
      .finally(() => { inflight--; fetching.delete(i); if (g === gen) pump(); });
  }
}
function decodeBlob(b) {
  if (window.createImageBitmap) return createImageBitmap(b);
  return new Promise((ok, no) => { const u = URL.createObjectURL(b), im = new Image();
    im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); no(); }; im.src = u; });
}
function decode(i) {
  if (bitmaps.has(i) || decoding.has(i) || !blobs.has(i) || decodingN >= DECODE_CONC) return;
  const g = gen, t0 = performance.now(); decoding.add(i); decodingN++;
  decodeBlob(blobs.get(i)).then((bm) => {
    if (g !== gen || !alive) { bm.close && bm.close(); return; }
    bitmaps.set(i, bm); S.decodeMs.push(performance.now() - t0); if (S.decodeMs.length > 200) S.decodeMs.shift();
    evict();
    if (S.firstPaint == null && Math.round(x) === i) render();       // paint the door as soon as it exists
  }).catch(() => {}).finally(() => { decoding.delete(i); decodingN--; });
}
function evict() {
  while (bitmaps.size > DECODE_CAP) {
    let worst = -1, wd = -1;
    for (const k of bitmaps.keys()) { const d = Math.abs(k - x) + (k < x && vel > 0 ? 4 : 0); if (d > wd) { wd = d; worst = k; } }
    const bm = bitmaps.get(worst); bitmaps.delete(worst); bm.close && bm.close();
  }
  S.decoded = bitmaps.size; S.peakDecoded = Math.max(S.peakDecoded, bitmaps.size);
}
function wantDecoded() {
  const c = Math.round(x), dir = vel < -0.5 ? -1 : 1;
  for (const k of [0, 1, 2, -1, 3, 4, 6, 8, 11]) { const i = c + k * dir; if (i >= 0 && i <= H && !bitmaps.has(i)) decode(i); }
}

// ---- drawing ------------------------------------------------------------------------------------------
let cw = 0, ch = 0, lastKey = '';
function cover(w, h) { const s = Math.max(cw / w, ch / h), dw = w * s, dh = h * s; return [(cw - dw) / 2, (ch - dh) / 2, dw, dh]; }
function displayedFocal() {           // vertical focal length the viewer actually sees (cover-fit may crop height)
  const s = Math.max(cw / set.w, ch / set.h); return 1.7320508 * (set.h * s) / ch;
}
function nearestDecoded(i) { for (let k = 1; k <= 16; k++) { if (bitmaps.has(i - k)) return i - k; if (bitmaps.has(i + k)) return i + k; } return -1; }
function render() {
  if (MODE === 'video' && !REDUCED) return renderVideo();
  const a = Math.min(H, Math.floor(x)), b = Math.min(H, a + 1), fr = x - a;
  const ia = bitmaps.has(a) ? a : nearestDecoded(a);
  if (ia < 0) return;                                   // keep the previous image rather than flash black
  const ib = ia === a && fr > 0.02 && b !== a && bitmaps.has(b) ? b : -1;
  const key = `${ia}|${ib}|${ib >= 0 ? fr.toFixed(2) : ''}|${cw}x${ch}`;
  if (key === lastKey) return; lastKey = key;
  const [dx, dy, dw, dh] = cover(set.w, set.h);
  ctx.globalAlpha = 1; ctx.drawImage(bitmaps.get(ia), dx, dy, dw, dh);
  if (ib >= 0) { ctx.globalAlpha = fr; ctx.drawImage(bitmaps.get(ib), dx, dy, dw, dh); ctx.globalAlpha = 1; }
  if (ia !== a) S.stale++;
  S.drawn++; if (S.firstPaint == null) { S.firstPaint = performance.now() - S.t0; onFirstPaint(); }
}
let seekStart = 0;
function renderVideo() {
  if (video.readyState < 2) return;
  if (S.firstPaint == null) { S.firstPaint = performance.now() - S.t0; onFirstPaint(); }
  const want = (Math.min(H, Math.round(x)) + 0.5) / fps;
  if (!video.seeking && Math.abs(video.currentTime - want) > 0.5 / fps) { seekStart = performance.now(); video.currentTime = want; }
}
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cw = Math.max(1, Math.round(innerWidth * dpr)); ch = Math.max(1, Math.round(innerHeight * dpr));
  cv.width = cw; cv.height = ch; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium'; lastKey = '';
  if (man && !crossingStarted) { const o = pickOrient(); if (o !== orient) useSet(o); }
}
function pickOrient() { const f = Q.get('orient'); return f === 'landscape' || f === 'portrait' ? f : innerWidth >= innerHeight ? 'landscape' : 'portrait'; }
function useSet(o) {
  gen++; orient = S.orient = o; set = man.sets[o];
  for (const bm of bitmaps.values()) bm.close && bm.close();
  bitmaps.clear(); blobs.clear(); tries.clear(); S.loaded = 0; S.bytes = 0; lastKey = '';
  if (MODE === 'video' && !REDUCED) {
    video.src = CFG.base + set[VIDEO_KIND].src; video.load();
  } else {
    queue = REDUCED ? [0] : coarseToFine(); pump();      // reduced motion only ever shows the door
  }
}

// ---- grain (live, so it costs no download and fades as we cross) ------------------------------------------
function makeGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), d = g.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) { const n = 128 + (Math.random() + Math.random() - 1) * 120; d.data[i] = n; d.data[i + 1] = n * 0.99; d.data[i + 2] = n * 1.02; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0); grainEl.style.backgroundImage = `url(${c.toDataURL()})`;
}
let grainTick = 0;
function updateGrain() {
  const L = look[Math.min(H, Math.round(x))] ?? 1;
  grainEl.style.opacity = (0.085 * L).toFixed(3);
  if (L > 0 && ++grainTick % 2 === 0) grainEl.style.transform = `translate3d(${-((Math.random() * 128) | 0)}px,${-((Math.random() * 128) | 0)}px,0)`;
}
// Exposure lift: rises over the last frames before the doorway, peaks at the handoff, then relaxes inside.
function updateLift(now) {
  const pre = smooth(H - 14, H, x);
  const post = cutAt ? Math.exp(-(now - cutAt) / 380) : 0;
  const k = Math.max(cutAt ? 0 : pre, post);
  stage.style.filter = k > 0.004 ? `brightness(${(1 + LIFT * k).toFixed(3)})` : '';
}
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- main loop ----------------------------------------------------------------------------------------
function tick(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000) || 0.016; lastT = now;
  if (cutAt) { updateLift(now); if (now - cutAt < 2000) requestAnimationFrame(tick); else stage.style.filter = ''; return; }
  if (warpT0) { if (alive) { warpStep(now); requestAnimationFrame(tick); } return; }
  if (!alive) return;
  if (inertia) { xt = clamp(xt + inertia * dt); inertia *= Math.exp(-dt / INERTIA_TAU); if (Math.abs(inertia) < 0.4) inertia = 0; }
  xs += (xt - xs) * (1 - Math.exp(-K_TARGET * dt));
  const prev = x;
  const step = (xs - x) * (1 - Math.exp(-K_FOLLOW * dt));
  x = clamp(x + Math.max(-VMAX * dt, Math.min(VMAX * dt, step)));
  if (Math.abs(xt - x) < 0.003 && Math.abs(xs - xt) < 0.003) { x = xs = xt; }
  vel = vel * 0.7 + ((x - prev) / dt) * 0.3;
  if (!crossingStarted && !REDUCED) stateFor(now);
  else if (REDUCED && !crossingStarted && !hint.classList.contains('on') && S.firstPaint != null) hint.classList.add('on');
  wantDecoded(); render(); updateGrain(); updateLift(now);
  const au = AUD(); if (au) au.frame(x);
  if (DEBUG) hud(now);
  requestAnimationFrame(tick);
}
const clamp = (v) => Math.max(0, Math.min(H, v));
function stateFor(now) {
  if (x > 0.3 || xt > 0.3) Entry.set('JOURNEY');
  else if (x < 0.02 && xt < 0.02) { Entry.set('DOOR'); if (!hint.classList.contains('on') && performance.now() - lastInput > 2500) hint.classList.add('on'); }
  const tb = TB();
  // Last second of the shot: camera is level and on the time block's axis -> park the live viewer on the same view.
  if (tb && x > H - 26) tb.hold(handoffDistanceAt(x), displayedFocal()); else if (tb && x < H - 30) tb.release();
  if (tb && x > H * 0.5) tb.preload();
  const committed = xt >= H - 0.5;
  if (committed && (x >= H - 0.05 || (x >= H - 2.5 && vel > 3))) {
    if (!tb || tb.ready() || (waitSince && now - waitSince > 10000)) cross();
    else { if (!waitSince) waitSince = now; if (now - waitSince > 500) hint.classList.add('on', 'wait'); }
  }
}
function handoffDistanceAt(fx) { return man.camera.handoffDistance - man.camera.ddPerFrameAtHandoff * (H - fx); }

// ---- transitions --------------------------------------------------------------------------------------
function cross() {
  if (crossingStarted) return; crossingStarted = true;
  const v0 = Math.max(0, vel) * man.camera.ddPerFrameAtHandoff;      // viewer units per second (negative = closer)
  S.crossV0 = v0; S.crossedAt = performance.now() - S.t0;
  Entry.set('CROSSING', { via: 'journey' });
  const au = AUD(); if (au) au.end(900);
  TB().cross({ d0: handoffDistanceAt(x), v0, f0: displayedFocal() });
  cutAt = performance.now();
  root.classList.add('leaving');                                      // 140 ms crossfade at the lift's peak
  setTimeout(teardown, 320);
}
function skip(via, fadeMs) {
  if (crossingStarted) return; crossingStarted = true;
  const au = AUD(); if (au) au.end(fadeMs || 0);
  Entry.set('CROSSING', { via });
  const tb = TB(); if (tb) tb.enterNow(); else Entry.set('INSIDE');
  if (!fadeMs) { teardown(); return; }
  root.style.transitionDuration = fadeMs + 'ms'; root.classList.add('leaving');
  setTimeout(teardown, fadeMs + 60);
}
function fail(reason) { S.fail = S.fail || reason; skip('fail', 0); }

// ---- skip: a half-second rush through the rest of the shot and out through the portal --------------------
// The remaining frames race past, smeared outward from the vanishing point by a radial zoom blur until the forms
// come apart. The light streaks come from the scene itself: each step a small light map of the frame (what's lit,
// in its own colour; shadows drop to nothing) is streaked outward from the vanishing point and added back, so the
// lit treads, the moonlit floor, the dogs' eyes and the doorway glow stretch into lines like a jump to light speed.
// The portal flares gold, then white, and the time block is there. Reduced motion (and the video comparison mode)
// keep the plain fade.
const WARP_MS = +Q.get('warpms') || 520;      // ?warpms= slows it down for recording
const LIGHT_T = 58, LIGHT_GAIN = 2.6;
const SHOW_LM = Q.has('lightmap');               // ?lightmap: show the light map and its streaks in the corner (review only)          // light map: luminance threshold (0-255) and boost of what's above it
let warpT0 = 0, warpX0 = 0, LM = null, lmx = null, SB = null, sbx = null;
function warp() {
  if (crossingStarted) return;
  if (REDUCED || MODE === 'video' || !set || !bitmaps.size) return skip('skip', 380);
  crossingStarted = true;
  Entry.set('CROSSING', { via: 'skip' });
  warpT0 = performance.now(); warpX0 = x; inertia = 0; S.crossedAt = warpT0 - S.t0;
  hint.classList.remove('on'); skipBtn.classList.remove('on');
  for (let k = 1; k <= 12; k++) warpDecode(Math.round(warpX0 + (H - warpX0) * k / 12));   // something to show at every step
  const lw = Math.max(160, Math.round(cw / 4)), lh = Math.max(1, Math.round(ch * lw / cw));
  LM = document.createElement('canvas'); LM.width = lw; LM.height = lh; lmx = LM.getContext('2d', { willReadFrequently: true });
  SB = document.createElement('canvas'); SB.width = lw; SB.height = lh; sbx = SB.getContext('2d');
  const tb = TB(); if (tb) tb.preload();
  const au = AUD(); if (au) au.warp(WARP_MS);
}
function warpDecode(i) {
  let j = -1;
  for (let k = 0; k <= 16 && j < 0; k++) { if (blobs.has(i + k)) j = i + k; else if (blobs.has(i - k)) j = i - k; }
  if (j < 0 || bitmaps.has(j) || decoding.has(j)) return;
  decoding.add(j);
  decodeBlob(blobs.get(j)).then((bm) => { if (!alive) { bm.close && bm.close(); return; } bitmaps.set(j, bm); })
    .catch(() => {}).finally(() => decoding.delete(j));
}
function warpFrame(i) { let best = -1, bd = 1e9; for (const k of bitmaps.keys()) { const d = Math.abs(k - i); if (d < bd) { bd = d; best = k; } } return best; }
function warpStep(now) {
  const t = Math.min(1, (now - warpT0) / WARP_MS), sp = t * t;                    // accelerating
  x = warpX0 + (H - warpX0) * Math.min(1, t * t * (1.6 - 0.6 * t));
  const i = warpFrame(Math.round(x)), cx = cw / 2, cy = ch * 0.44, R = Math.hypot(cw, ch) / 2;
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (i >= 0) {
    const [dx, dy, dw, dh] = cover(set.w, set.h), z = 1 + 0.6 * sp;                      // pushing in toward the portal
    ctx.drawImage(bitmaps.get(i), cx + (dx - cx) * z, cy + (dy - cy) * z, dw * z, dh * z);
  }
  const spread = 0.015 + 0.55 * sp;                       // radial zoom blur: the canvas over itself, four doubling passes
  for (let p = 0; p < 4; p++) {
    const s = 1 + spread * (1 << p) / 15;
    ctx.globalAlpha = 0.5; ctx.drawImage(cv, 0, 0, cw, ch, cx - cx * s, cy - cy * s, cw * s, ch * s);
  }
  if (i >= 0) {                                                                      // light streaks from the scene's own light
    const lw = LM.width, lh = LM.height, k = lw / cw, [dx, dy, dw, dh] = cover(set.w, set.h), z = 1 + 0.6 * sp;
    lmx.globalCompositeOperation = 'source-over'; lmx.globalAlpha = 1; lmx.fillStyle = '#000'; lmx.fillRect(0, 0, lw, lh);
    lmx.drawImage(bitmaps.get(i), (cx + (dx - cx) * z) * k, (cy + (dy - cy) * z) * k, dw * z * k, dh * z * k);
    const img = lmx.getImageData(0, 0, lw, lh), d = img.data;                        // light map: lit areas only, in their colour
    for (let p = 0; p < d.length; p += 4) {
      const L = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
      let a = (L - LIGHT_T) / (255 - LIGHT_T); a = a > 0 ? Math.min(1, a * a * LIGHT_GAIN * 4) : 0;
      const m = a * 255 / Math.max(1, L);                                            // keep hue, push brightness
      d[p] = Math.min(255, d[p] * m); d[p + 1] = Math.min(255, d[p + 1] * m); d[p + 2] = Math.min(255, d[p + 2] * m);
    }
    lmx.putImageData(img, 0, 0);
    sbx.globalCompositeOperation = 'source-over'; sbx.globalAlpha = 1; sbx.clearRect(0, 0, lw, lh); sbx.drawImage(LM, 0, 0);
    const scx = cx * k, scy = cy * k, reach = 0.08 + 1.8 * sp;                       // streak length grows with speed
    for (let p = 0; p < 6; p++) {                                                    // radial streak: six doubling passes
      const s2 = 1 + reach * (1 << p) / 63;
      sbx.globalAlpha = 0.5; sbx.drawImage(SB, 0, 0, lw, lh, scx - scx * s2, scy - scy * s2, lw * s2, lh * s2);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, 0.35 + 0.9 * sp); ctx.drawImage(SB, 0, 0, lw, lh, 0, 0, cw, ch);
    ctx.globalAlpha = Math.min(1, 0.6 * sp); ctx.drawImage(SB, 0, 0, lw, lh, 0, 0, cw, ch);
    if (SHOW_LM) { const w3 = cw / 3, h3 = w3 * lh / lw; ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.drawImage(LM, 0, 0, w3, h3); ctx.drawImage(SB, 0, h3 + 4, w3, h3); }
  }
  ctx.globalCompositeOperation = 'lighter';
  const flare = smooth(0.62, 1, t);                                                 // the portal: gold, then white
  if (flare > 0) { ctx.globalAlpha = flare; ctx.fillStyle = t < 0.85 ? 'rgb(255,196,110)' : 'rgb(255,236,205)'; ctx.fillRect(0, 0, cw, ch); }
  ctx.restore(); lastKey = ''; S.drawn++;
  updateGrain(); updateLift(now);
  if (t >= 1) finishWarp();
}
function finishWarp() {
  const tb = TB(); if (tb) tb.enterNow(); else Entry.set('INSIDE');
  cutAt = performance.now();                                    // the exposure lift relaxes into the time block
  root.style.transitionDuration = '180ms'; root.classList.add('leaving');
  setTimeout(teardown, 240);
}
function teardown() {
  alive = false; gen++;
  try { aborter.abort(); } catch (e) {}
  for (const bm of bitmaps.values()) bm.close && bm.close();
  bitmaps.clear(); blobs.clear(); queue = [];
  if (video.getAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
  removeEventListener('wheel', onWheel, { passive: false }); removeEventListener('keydown', onKey, true);
  removeEventListener('resize', resize);
  const tbCanvas = document.getElementById('tb'); if (tbCanvas) tbCanvas.tabIndex = 0;
  root.remove(); skipBtn.remove(); if (hudEl) { hudEl.remove(); hudEl = null; }
  if (!cutAt) stage.style.filter = '';
}

// ---- input --------------------------------------------------------------------------------------------
let lastInput = 0;
function advance(df) {
  lastInput = performance.now(); inertia = 0;
  hint.classList.remove('on'); xt = clamp(xt + df);
}
function onWheel(e) {
  if (!alive || crossingStarted) { if (alive) e.preventDefault(); return; }
  e.preventDefault();
  let dy = e.deltaY, dx = e.deltaX;
  if (e.deltaMode === 1) { dy *= 16; dx *= 16; } else if (e.deltaMode === 2) { dy *= innerHeight; dx *= innerWidth; }
  if (Math.abs(dx) > Math.abs(dy) || e.shiftKey) return;                 // horizontal never steers the entrance
  if (REDUCED) { if (dy > 4) skip('reduced', 600); return; }
  dy = Math.max(-240, Math.min(240, dy));
  const now = performance.now(); wheelTrail.push([now, Math.abs(dy)]);           // how fast the wheel/trackpad is going
  while (wheelTrail.length && now - wheelTrail[0][0] > 120) wheelTrail.shift();
  const pxPerS = wheelTrail.reduce((a, w) => a + w[1], 0) / 0.12;
  advance(dy * H / WHEEL_PX_JOURNEY * accel(pxPerS, WHEEL_SLOW, WHEEL_FAST));
}
const wheelTrail = [];
function onKey(e) {
  if (!alive || crossingStarted) return;
  if (e.target === skipBtn && (e.key === 'Enter' || e.key === ' ')) return;
  const k = e.key; let df = 0;
  if (k === 'ArrowDown' || k === 'PageDown' || k === 'Enter' || (k === ' ' && !e.shiftKey)) df = k === 'PageDown' ? 2 * KEY_STEP : KEY_STEP;
  else if (k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) df = -(k === 'PageUp' ? 2 * KEY_STEP : KEY_STEP);
  else return;
  e.preventDefault(); e.stopPropagation();
  if (REDUCED) { if (df > 0) skip('reduced', 600); return; }
  advance(df);
}
let ptr = null;
function onDown(e) {
  if (!alive || crossingStarted || e.button > 0 || e.target === skipBtn) return;
  unlockVideo();
  ptr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, axis: null, trail: [[performance.now(), e.clientY]] };
  inertia = 0; try { root.setPointerCapture(e.pointerId); } catch (err) {}
}
function onMove(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  if (!ptr.axis && Math.hypot(dx, dy) > 8) ptr.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  if (ptr.axis !== 'v') return;
  const now = performance.now(); ptr.trail.push([now, e.clientY]); while (ptr.trail.length > 2 && now - ptr.trail[0][0] > 110) ptr.trail.shift();
  const [ta, ya] = ptr.trail[0], span = Math.max(0.016, (now - ta) / 1000);
  const screensPerS = Math.abs(ya - e.clientY) / innerHeight / span;            // how fast the finger is moving
  if (!REDUCED) advance((ptr.y - e.clientY) * H / (innerHeight * SWIPE_SCREENS) * accel(screensPerS, SWIPE_SLOW, SWIPE_FAST));
  ptr.y = e.clientY;
}
function onUp(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const p = ptr; ptr = null;
  if (p.axis !== 'v') return;
  if (REDUCED) { if (p.y0 - p.y > 30) skip('reduced', 600); return; }
  const now = performance.now(), [t0, y0] = p.trail[0], [t1, y1] = p.trail[p.trail.length - 1];
  if (now - t1 > 90 || t1 - t0 < 10) return;
  const pxPerS = (y0 - y1) / ((t1 - t0) / 1000);                                // a harder flick coasts further
  inertia = Math.max(-VMAX * 1.5, Math.min(VMAX * 1.5, pxPerS * H / (innerHeight * SWIPE_SCREENS) * accel(Math.abs(pxPerS) / innerHeight, SWIPE_SLOW, SWIPE_FAST)));
}
let unlocked = false;
function unlockVideo() {      // iOS paints seeked frames reliably once the element has played inside a gesture
  if (unlocked || MODE !== 'video') return; unlocked = true;
  const p = video.play(); if (p && p.then) p.then(() => video.pause()).catch(() => {});
}

// ---- boot ---------------------------------------------------------------------------------------------
function onFirstPaint() {
  setTimeout(() => { if (alive && !crossingStarted && performance.now() - lastInput > 600) hint.classList.add('on'); }, 700);
  setTimeout(() => { if (alive) { skipBtn.classList.add('on'); const sb = document.getElementById('sound-toggle'); if (sb) sb.classList.add('on'); } }, 1400);
  setTimeout(() => { const au = AUD(); if (au && alive) au.load(); }, 1800);
  setTimeout(() => { const tb = TB(); if (tb && alive) tb.preload(); }, 2500);
}
async function boot() {
  skipBtn.addEventListener('click', () => warp());   // the rush; falls back to the plain fade when it can't run
  addEventListener('wheel', onWheel, { passive: false });
  addEventListener('keydown', onKey, true);
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  addEventListener('resize', resize);
  makeGrain();
  if (MODE === 'off') return skip('off', 0);
  // Ask the parent page (Wix) about this session while the manifest and WebP check run, so neither waits on the other.
  const manifestP = fetch(CFG.base + 'manifest.json', { signal: aborter.signal })
    .then((r) => { if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); });
  manifestP.catch(() => {});
  const [enteredBefore, webpOk] = await Promise.all([Entry.askParent(350), FORMAT === 'webp' ? canWebp() : true]);
  if (enteredBefore) return skip('return', 0);
  // A late answer from the parent (its page code loaded after us) still counts until the visitor starts walking.
  const lateAnswer = (e) => { const d = e.data; if (d && d.nolfe === 'entry-state' && d.entered && !lastInput && !crossingStarted) skip('return', 250); };
  addEventListener('message', lateAnswer); setTimeout(() => removeEventListener('message', lateAnswer), 2500);
  if (!webpOk) FORMAT = S.format = 'jpg';
  try { man = await manifestP; } catch (e) { return fail('manifest'); }
  H = man.handoffFrame; fps = man.fps; look = man.look;
  orient = null; resize(); if (!orient) useSet(pickOrient());
  if (REDUCED) { root.classList.add('reduced'); }
  if (MODE === 'video' && !REDUCED) {
    root.classList.add('video-mode');
    video.addEventListener('seeked', () => { if (seekStart) { S.seekMs.push(performance.now() - seekStart); if (S.seekMs.length > 300) S.seekMs.shift(); seekStart = 0; } });
    video.addEventListener('error', () => fail('video'));
  }
  const tbCanvas = document.getElementById('tb'); if (tbCanvas) tbCanvas.tabIndex = -1;   // Tab reaches the entrance, then Skip
  root.tabIndex = 0; root.focus({ preventScroll: true });
  requestAnimationFrame(tick);
  setTimeout(() => { if (S.firstPaint == null && alive) fail('timeout'); }, 9000);   // assets unreachable -> straight in
}

function canWebp() {
  return new Promise((ok) => { const im = new Image(); im.onload = () => ok(im.width === 1); im.onerror = () => ok(false);
    im.src = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='; });
}

// ---- debug HUD (?debug) -------------------------------------------------------------------------------
let hudEl = null, hudAt = 0;
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;
const p95 = (a) => { if (!a.length) return 0; const s = [...a].sort((p, c) => p - c); return s[Math.floor(s.length * 0.95)]; };
function hud(now) {
  if (now - hudAt < 200) return; hudAt = now;
  if (!hudEl) { hudEl = document.createElement('pre'); hudEl.id = 'hud'; document.body.appendChild(hudEl); }
  const tb = TB(), mb = set ? (S.decoded * set.w * set.h * 4 / 1048576).toFixed(0) : 0;
  hudEl.textContent = `${Entry.state}  ${S.mode}/${S.format}  ${S.orient}\nframe ${x.toFixed(1)} -> ${xt.toFixed(1)} / ${H}  v ${vel.toFixed(1)} f/s\n` +
    (MODE === 'video' ? `seek avg ${avg(S.seekMs).toFixed(1)} ms  p95 ${p95(S.seekMs).toFixed(1)} ms (${S.seekMs.length})\n`
      : `loaded ${S.loaded}/${H + 1}  ${(S.bytes / 1048576).toFixed(2)} MB\ndecoded ${S.decoded} (~${mb} MB)  decode ${avg(S.decodeMs).toFixed(1)} ms  stale ${S.stale}/${S.drawn}\n`) +
    `first paint ${S.firstPaint == null ? '-' : S.firstPaint.toFixed(0) + ' ms'}  tb ${tb ? JSON.stringify(tb.stats()) : '-'}`;
}
if (DEBUG) addEventListener('keydown', (e) => { if (e.key === 'h') hudEl && hudEl.remove(); });

boot();
})();

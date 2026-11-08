/* Nolfe — entry controller.
   One in-memory state machine shared by the intro and the time block:
     DOOR -> JOURNEY -> CROSSING -> INSIDE
   - DOOR <-> JOURNEY may go back and forth (retracing the stairs).
   - Once CROSSING starts, nothing can return to DOOR/JOURNEY for this page instance.
   - Never written to localStorage/sessionStorage and never pushed to history: a full reload starts at the door.
   - Survives re-initialisation of either component on this page (it lives on window).
   - In the Wix embed, the parent page can remember "entered" in Wix memory storage across in-site
     navigation (see README): the embed asks once at boot and reports when it enters. */
(function () {
  'use strict';
  if (window.NolfeEntry) return;
  const ORDER = { DOOR: 0, JOURNEY: 1, CROSSING: 2, INSIDE: 3 };
  const listeners = new Set();
  let state = 'DOOR', detail = null;
  const root = document.documentElement;
  root.dataset.entry = 'door';

  function set(next, info) {
    if (!(next in ORDER) || next === state) return false;
    if (ORDER[state] >= ORDER.CROSSING && ORDER[next] < ORDER[state]) return false;   // one-way
    const prev = state; state = next; detail = info || null;
    root.dataset.entry = next.toLowerCase();
    for (const fn of [...listeners]) { try { fn(next, prev, detail); } catch (e) { console.error(e); } }
    if (next === 'INSIDE') tellParent({ nolfe: 'entered' });
    return true;
  }
  function tellParent(msg) { try { if (window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {} }

  // Ask the parent page (Wix) whether this visitor already entered during this page session.
  // Resolves false immediately when standalone, or after a short timeout if no one answers.
  function askParent(timeoutMs) {
    return new Promise((resolve) => {
      if (window.parent === window) return resolve(false);
      let done = false;
      const finish = (v) => { if (done) return; done = true; removeEventListener('message', onMsg); resolve(v); };
      const onMsg = (e) => { const d = e.data; if (d && d.nolfe === 'entry-state') finish(!!d.entered); };
      addEventListener('message', onMsg);
      tellParent({ nolfe: 'hello' });
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  // In-site navigation through Wix. The menu inside the embed links to other pages with target=_top, which reloads the
  // whole Wix page and clears the parent's in-memory "entered" flag. When the Home page code says it can navigate
  // (entry-state with nav:true), those clicks ask it to change pages with Wix's own router instead (no reload), so
  // coming back to Home lands straight in the time block. If the page doesn't confirm within 800 ms, the link opens
  // normally.
  let parentNav = false, navTimer = 0;
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || e.source !== window.parent) return;
    if (d.nolfe === 'entry-state' && d.nav) parentNav = true;
    if (d.nolfe === 'nav-ack') { clearTimeout(navTimer); navTimer = 0; }
  });
  document.addEventListener('click', (e) => {
    if (!parentNav || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_top')) return;
    let u; try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (!/^https?:$/.test(u.protocol) || !/(^|\.)nolfemedia\.com$/.test(u.hostname)) return;
    e.preventDefault();
    if (u.pathname === '/' || u.pathname === '') return;            // Home: this is Home already
    tellParent({ nolfe: 'navigate', href: u.href });
    clearTimeout(navTimer);
    navTimer = setTimeout(() => { navTimer = 0; window.open(u.href, '_top'); }, 800);
  }, true);

  window.NolfeEntry = {
    get state() { return state; },
    get detail() { return detail; },
    get entered() { return state === 'INSIDE'; },
    get crossingOrInside() { return ORDER[state] >= ORDER.CROSSING; },
    set, askParent, tellParent,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

/**
 * Real-browser e2e for the iOS-style three-detent continuous-chat sheet — no app
 * server. Bundles chat-sheet-fixture.tsx with esbuild, loads it in headless
 * chromium via Playwright, and drives the sheet with REAL pointer gestures.
 *
 * Coverage (the user asked for exhaustive interaction + state testing):
 *   - DETENTS: peek (76px) → half (46vh) → full (72vh), stepped by pulls.
 *   - GESTURES, per input type (MOUSE on desktop, TOUCH on mobile):
 *       slow drag (distance threshold) · flick (velocity threshold) ·
 *       sub-threshold nudge (snaps back) · drag-and-hold at an arbitrary mid
 *       height (live 1:1 tracking) · drag BEYOND full (rubber-band overscroll).
 *   - EVERY control/state via deterministic fixture loads + interactions:
 *       empty · peek/half/full · typing→send · attach image→thumbnail→remove ·
 *       mic press→recording · voice speaking→mute toggle · responding typing
 *       dots · booting (disabled) · suggestions · reduced-motion.
 *   - Screenshots every state; captures the browser console and fails on any
 *     page error or error-level log.
 *
 * Run: bun run --cwd packages/ui test:chat-sheet-e2e
 * Exits non-zero on any failed assertion / console error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  touchDragHold,
  touchSwipe,
  touchTap,
} from "../../../testing/real-touch-gestures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// 1) Bundle the fixture (stub the API-touching prompt-suggestions hook).
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
    }));
  },
};
// The overlay's import graph transitively reaches server-only @elizaos/core
// features (plugin-manager, working-memory, todos, …) whose module-init touches
// the `process` global and node builtins — DEAD code in the browser (never
// executed at render; the only render-path core symbol, findInteractionRegions,
// is test-only). Production Vite resolves core's `browser` export condition;
// this raw-esbuild bundle does not, so replace `@elizaos/core` with a no-op
// Proxy (mirrors run-home-screen-e2e) instead of bundling its Node graph.
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};
const result = await build({
  entryPoints: [join(here, "chat-sheet-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubPromptSuggestions, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat sheet e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-sheet.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

// --- DOM probes ----------------------------------------------------------
const variant = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-variant");
const detent = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-detent");
// The canonical state-machine value (CLOSED | INPUT | OPEN_UNDER_HALF |
// OPEN_HALF_OR_OVER | MAXIMIZED) — the single source the overlay derives.
const chatState = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-chat-state");
// Header buttons (maximize/clear/home/settings) are always mounted (so they can
// fade + lerp their space), so visibility is the LIVE-height `data-header-shown`
// flag, not their presence in the DOM.
const headerShown = async (p) =>
  (await p.getByTestId("chat-sheet").getAttribute("data-header-shown")) ===
  "true";
// The history (thread) is the element whose height animates 0 → half → full;
// the panel (chat-sheet) also holds the always-present input, so measure the
// thread for detent heights.
const sheetHeight = (p) =>
  p.evaluate(
    () =>
      document
        .querySelector('[data-testid="chat-thread"]')
        ?.getBoundingClientRect().height ?? 0,
  );
async function waitForSheetHeightNear(p, expected, tolerance, timeout = 1500) {
  await p
    .waitForFunction(
      ({ expected, tolerance }) => {
        const h =
          document
            .querySelector('[data-testid="chat-thread"]')
            ?.getBoundingClientRect().height ?? 0;
        return Math.abs(h - expected) <= tolerance;
      },
      { expected, tolerance },
      { timeout },
    )
    .catch(() => {});
}
const viewportH = (p) =>
  p.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
// Distance from the viewport top to the panel's top edge — at FULL the sheet
// rises to ~SHEET_TOP_MARGIN (72px) from the top.
const panelTop = (p) =>
  p.evaluate(
    () =>
      document.querySelector('[data-testid="chat-sheet"]')?.getBoundingClientRect()
        .top ?? 0,
  );
const panelRadii = (p) =>
  p.evaluate(() => {
    const panel = document.querySelector('[data-testid="chat-sheet"]');
    const surface = panel?.firstElementChild;
    const content = document.querySelector('[data-testid="chat-content"]');
    const read = (el) =>
      el ? Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) : -1;
    return { surface: read(surface), content: read(content) };
  });
const SHEET_TOP_MARGIN = 72;
const grabberBox = (p) => p.getByTestId("chat-sheet-grabber").boundingBox();

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

function attachConsole(p, sink) {
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

const SETTLE = 480; // spring settle time before measuring a detent

/**
 * Real pointer gesture on the grabber. `up` px is the pull distance (positive =
 * up/open, negative = down/close). `pointer` is "mouse" (real Playwright mouse)
 * or "touch" (CDP Input.dispatchTouchEvent through Chromium's real touch path).
 * `slow` inserts per-step waits so elapsed time is real → LOW velocity (forces a
 * distance-threshold decision); without it the moves fire back-to-back → HIGH
 * velocity (a flick). `hold` leaves the pointer down for a mid-drag screenshot.
 */
const heldTouchDrags = new WeakMap();
const testIdSelector = (testId) => `[data-testid="${testId}"]`;

async function gesture(
  p,
  up,
  {
    pointer = "mouse",
    slow = false,
    hold = false,
    steps = 12,
    // Which handle to drag: the open-sheet grabber (default) or the collapsed
    // pill — the pill→input→chat open paths must be driven from the pill itself.
    target = "chat-sheet-grabber",
  } = {},
) {
  const b = await p.getByTestId(target).boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const targetY = (i) => cy - (up * i) / steps;
  if (pointer === "mouse") {
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    for (let i = 1; i <= steps; i += 1) {
      await p.mouse.move(cx, targetY(i));
      if (slow) await p.waitForTimeout(28);
    }
    if (!hold) await p.mouse.up();
  } else {
    const drag = await touchDragHold(p, testIdSelector(target), 0, -up, {
      steps,
      stepDelayMs: slow ? 28 : 0,
    });
    if (hold) {
      heldTouchDrags.set(p, drag);
    } else {
      await drag.release();
    }
  }
}
async function release(p, pointer, up = 0) {
  if (pointer === "mouse") {
    await p.mouse.up();
  } else {
    const drag = heldTouchDrags.get(p);
    if (!drag) throw new Error("release(touch): no held real-touch drag");
    heldTouchDrags.delete(p);
    await drag.release();
  }
}

/** Full detent-stepping + flick + sub-threshold + rubber-band suite for one input type. */
async function runDragSuite(p, pointer, tag) {
  const vh = await viewportH(p);
  const halfH = Math.round(vh * 0.46);
  // FULL now fills to the panel's max height (sheet rises to the top), captured
  // live once we reach it — no fixed fraction.
  let fullH = 0;
  const TOL = 36;
  await p.waitForTimeout(150);

  // fully collapsed at rest — the thread is gone (height 0), just the input
  assert((await variant(p)) === "closed", `[${pointer}] starts COLLAPSED (closed)`);
  assert((await detent(p)) === "collapsed", `[${pointer}] detent is collapsed at rest`);
  assert(near(await sheetHeight(p), 0, 6), `[${pointer}] COLLAPSED thread height ≈ 0px`);
  await snap(p, `${tag}-collapsed`);

  // FLICK up → HALF (fast deliberate pull crosses the velocity threshold → snap to a detent)
  await gesture(p, 160, { pointer, slow: false, steps: 2 });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "half", `[${pointer}] flick-up snaps COLLAPSED→HALF`);
  await waitForSheetHeightNear(p, halfH, TOL);
  assert(near(await sheetHeight(p), halfH, TOL), `[${pointer}] HALF height ≈ ${halfH}px (got ${Math.round(await sheetHeight(p))})`);
  await snap(p, `${tag}-half`);
  // #9142 regression guard: the grabber BAR (inner span) must actually PAINT
  // once the sheet is open — a prior regression pinned the bar to `opacity-0`,
  // leaving the handle grabbable but invisible. The wrapper's `grabberOpacity`
  // crossfade owns show/hide; the bar's OWN opacity must be 1, never 0.
  const grabberBarOpacity = await p.evaluate(() =>
    getComputedStyle(
      document
        .querySelector('[data-testid="chat-sheet-grabber"]')
        ?.querySelector("span") ?? document.body,
    ).opacity,
  );
  assert(
    grabberBarOpacity === "1",
    `[${pointer}] grabber bar paints (inner-span opacity "${grabberBarOpacity}" === "1", not opacity-0) (#9142)`,
  );
  // The sheet header (maximize/clear/launcher) shows at HALF and up now,
  // not only at FULL.
  assert(
    (await p.getByTestId("chat-full-maximize").count()) === 1 &&
      (await p.getByTestId("chat-full-launcher").count()) === 1,
    `[${pointer}] HALF detent shows the sheet header`,
  );

  // FLICK up again → FULL — the sheet rises to the top of the screen
  await gesture(p, 140, { pointer, slow: false, steps: 2 });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "full", `[${pointer}] flick-up snaps HALF→FULL`);
  fullH = Math.round(await sheetHeight(p));
  assert(fullH > halfH + 40, `[${pointer}] FULL is taller than HALF (full ${fullH} > half ${halfH})`);
  const top = Math.round(await panelTop(p));
  assert(
    near(top, SHEET_TOP_MARGIN, TOL + 12),
    `[${pointer}] FULL rises to the top (panel top ${top}px ≈ ${SHEET_TOP_MARGIN}px)`,
  );
  await snap(p, `${tag}-full`);

  // Header (post home↔launcher consolidation, #9450): Maximize + Clear on the
  // left, a single Launcher button on the right (the old Home/Views/Settings
  // trio collapsed into one launcher target). The stray copy-conversation button
  // was removed in #10713 (#10749), so the FULL header is exactly these three.
  assert(
    (await p.getByTestId("chat-full-maximize").count()) === 1 &&
      (await p.getByTestId("chat-full-clear").count()) === 1 &&
      (await p.getByTestId("chat-full-launcher").count()) === 1,
    `[${pointer}] header shows maximize + clear + launcher`,
  );
  // Maximize → full-bleed (edge-to-edge): data-maximized flips + panel reaches x=0.
  await p.getByTestId("chat-full-maximize").click();
  await p.waitForTimeout(SETTLE);
  assert(
    (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 1,
    `[${pointer}] maximize → data-maximized=true (full screen)`,
  );
  const maxBox = await p.getByTestId("chat-sheet").boundingBox();
  assert(
    !!maxBox && maxBox.x <= 1,
    `[${pointer}] maximized panel is edge-to-edge (x=${Math.round(maxBox?.x ?? -1)})`,
  );
  // Restore → inset again.
  await p.getByTestId("chat-full-maximize").click();
  await p.waitForTimeout(SETTLE);
  assert(
    (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 0,
    `[${pointer}] restore → no longer maximized`,
  );
  // Clear routes to the controller and keeps the sheet open (it resets the
  // thread in place). Home/Settings instead collapse the sheet (navigate-and-
  // close) — tested in their own block so they don't tear down this flow.
  await p.getByTestId("chat-full-clear").click();
  await p.waitForTimeout(120);
  assert(
    sink.logs.some((l) => l.includes("clearConversation")),
    `[${pointer}] clear button calls clearConversation`,
  );

  // drag BEYOND full (held) → rubber-band, not 1:1
  await gesture(p, 260, { pointer, hold: true });
  await p.waitForTimeout(120);
  const beyondH = await sheetHeight(p);
  assert(
    beyondH > fullH - 4 && beyondH < fullH + 80,
    `[${pointer}] BEYOND full rubber-bands (got ${Math.round(beyondH)}, full ${fullH}, raw would be ~${fullH + 260})`,
  );
  await snap(p, `${tag}-beyond-full-rubberband`);
  await release(p, pointer, 260);
  await p.waitForTimeout(SETTLE);
  assert(near(await sheetHeight(p), fullH, TOL + 24), `[${pointer}] settles back near FULL after overscroll`);

  // mid-drag HOLD between detents (live 1:1 tracking)
  await gesture(p, -150, { pointer, hold: true }); // pull down ~150 from full
  await p.waitForTimeout(120);
  const midH = await sheetHeight(p);
  assert(
    midH < fullH - 20 && midH > halfH - 120,
    `[${pointer}] mid-drag tracks the finger downward (got ${Math.round(midH)}, below full ${fullH})`,
  );
  await snap(p, `${tag}-mid-drag-hold`);
  await release(p, pointer, -150);
  await p.waitForTimeout(SETTLE);

  // FREE DRAG: a deliberate SLOW drag RESTS where released (not snapped to a
  // detent). Flick to FULL first for a known start, then slow-drag down. The
  // strict "rests in the middle" check is mouse-authoritative — real touch can
  // coalesce a slow drag and under-travel; touch still verifies the sheet stays
  // open (no snap-shut) after the drag.
  await gesture(p, 200, { pointer, slow: false, steps: 2 });
  await p.waitForTimeout(SETTLE);
  const startFree = Math.round(await sheetHeight(p));
  await gesture(p, -180, { pointer, slow: true, steps: 16 });
  await p.waitForTimeout(SETTLE);
  const restedH = Math.round(await sheetHeight(p));
  if (pointer === "mouse") {
    assert(
      restedH > halfH + 30 && restedH < startFree - 60,
      `[${pointer}] slow drag RESTS at a free height — rested ${restedH}, between half ${halfH} and full ${startFree} (not snapped)`,
    );
  } else {
    assert(
      restedH <= startFree && restedH > halfH - 80,
      `[${pointer}] slow drag rests open (rested ${restedH}, start ${startFree})`,
    );
  }
  assert((await variant(p)) === "open", `[${pointer}] free-rested sheet stays open`);
  await snap(p, `${tag}-free-rest`);

  // FLICK down → COLLAPSED (from the free height). Loop until closed (stops
  // before reaching the pill, since the pill needs a flick from the collapsed
  // input — not an open sheet).
  for (let i = 0; i < 5 && (await variant(p)) === "open"; i += 1) {
    await gesture(p, -130, { pointer, slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
  }
  assert((await variant(p)) === "closed", `[${pointer}] flick-down returns to COLLAPSED`);
  // Let the collapse spring fully settle before measuring the resting thread.
  await p.waitForTimeout(SETTLE);
  // thread ≈ 0; allow a small band for the spring tail (touch dispatch wider).
  assert(
    near(await sheetHeight(p), 0, pointer === "mouse" ? 30 : 48),
    `[${pointer}] back COLLAPSED, thread ≈ 0px (got ${Math.round(await sheetHeight(p))})`,
  );
  await snap(p, `${tag}-back-to-collapsed`);

  // click-out collapses: open, then click the dimmed scrim → collapses.
  await gesture(p, 120, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "open", `[${pointer}] re-opened for the click-out check`);
  await p
    .getByTestId("chat-sheet-backdrop")
    .click({ position: { x: 16, y: 16 }, force: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "closed", `[${pointer}] clicking outside COLLAPSES the chat`);
  await snap(p, `${tag}-clicked-out-collapsed`);

  // FLICK up (short + fast → velocity threshold, distance < 56). Few steps so
  // the down→up wall-clock is tiny → high velocity, the whole point of a flick.
  await gesture(p, 48, { pointer, slow: false, steps: 2 });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "open", `[${pointer}] FLICK up opens despite <56px travel (velocity)`);
  await snap(p, `${tag}-flick-open`);

  // sub-threshold NUDGE (small + slow → neither threshold → snaps back)
  const beforeNudge = await variant(p);
  await gesture(p, -34, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === beforeNudge, `[${pointer}] sub-threshold nudge snaps back (no detent change)`);
  await snap(p, `${tag}-nudge-snapback`);
}

const browser = await chromium.launch();
const sink = { logs: [], errors: [] };
try {
  // ===== DESKTOP + MOUSE =====
  const desktop = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  attachConsole(desktop, sink);
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="chat-sheet"]');
  await desktop.waitForTimeout(700);
  await runDragSuite(desktop, "mouse", "desktop");

  // ===== MOBILE + TOUCH =====
  const mobile = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  attachConsole(mobile, sink);
  await mobile.goto(url);
  await mobile.waitForSelector('[data-testid="chat-sheet"]');
  await mobile.waitForTimeout(700);
  await runDragSuite(mobile, "touch", "mobile");

  // ===== GRABBER horizontal flick → launcher intent, REAL touch (#9943) =====
  // The collapsed grabber's horizontal swipe pages home → launcher through the
  // shell-surface store (goLauncher). Android's on-device spec drives this with
  // a real finger; drive it here through Chromium's REAL touch pipeline
  // (Input.dispatchTouchEvent, hit-test + touch-action + implicit capture), and
  // ALSO under a janked main thread (fire-and-forget dispatch → the renderer
  // coalesces the moves), the failure shape of the Davey!-janked WebView.
  {
    const surfacePage = (p) =>
      p.evaluate(
        () =>
          globalThis[Symbol.for("elizaos.ui.shell-surface-store")]?.state
            ?.page ?? "home",
      );
    const resetSurface = (p) =>
      p.evaluate(() => {
        const s = globalThis[Symbol.for("elizaos.ui.shell-surface-store")];
        if (s) {
          s.state = { ...s.state, page: "home" };
          for (const l of s.listeners) l();
        }
      });
    const grabberSel = '[data-testid="chat-sheet-grabber"]';

    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector(grabberSel);
    await p.waitForTimeout(700);

    // 1. Plain real-touch flick (adb-like: 150px left over ~280ms).
    assert(
      (await surfacePage(p)) === "home",
      "[grabber-swipe] starts on the home surface",
    );
    await touchSwipe(p, grabberSel, -150, -6, { steps: 14, stepDelayMs: 20 });
    await p.waitForTimeout(400);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] REAL-touch left flick on the grabber commits goLauncher (#9943)",
    );
    await snap(p, "grabber-real-touch-launcher");

    // 2. Real-touch flick with the main thread JANKED: dispatch the whole
    // sequence fire-and-forget so the renderer coalesces the moves (this is
    // what a 700ms+ frame on the Android WebView does to a 280ms finger swipe).
    await resetSurface(p);
    const box = await p.locator(grabberSel).first().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await p.context().newCDPSession(p);
    const touchPoint = (x, y) => [
      { x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
    ];
    const busy = p
      .evaluate((ms) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          // burn the main thread across the whole swipe
        }
      }, 1200)
      .catch(() => {});
    await p.waitForTimeout(80); // let the busy loop engage
    const sends = [
      cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: touchPoint(cx, cy),
      }),
    ];
    for (let i = 1; i <= 14; i += 1) {
      sends.push(
        cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touchPoint(cx - (150 * i) / 14, cy - (6 * i) / 14),
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    sends.push(
      cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      }),
    );
    await Promise.allSettled(sends);
    await busy;
    await p.waitForTimeout(600);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] real-touch flick still commits with the main thread janked / moves coalesced (#9943)",
    );
    await cdp.detach().catch(() => {});

    // 3. Synthetic PointerEvent path (jsdom-style dispatch) stays green.
    await resetSurface(p);
    await p.evaluate((sel) => {
      const g = document.querySelector(sel);
      const r = g.getBoundingClientRect();
      const cx0 = r.x + r.width / 2;
      const cy0 = r.y + r.height / 2;
      const fire = (type, x, y) =>
        g.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      fire("pointerdown", cx0, cy0);
      fire("pointermove", cx0 - 75, cy0 - 3);
      fire("pointermove", cx0 - 150, cy0 - 6);
      fire("pointerup", cx0 - 150, cy0 - 6);
    }, grabberSel);
    await p.waitForTimeout(400);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] synthetic PointerEvent flick still commits (parity)",
    );
    await p.close();
  }

  // ===== CONTROLS + INPUT STATES (mobile viewport for the tactile surface) =====
  const ctrl = async () =>
    browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });

  // empty thread: no sheet, just the composer (suggestion strip is flagged off)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?empty`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert((await p.locator('[data-testid="chat-thread"]').count()) === 0, "EMPTY: no thread/history mounted (just the input panel)");
    assert((await p.getByTestId("chat-suggestions").count()) === 0, "EMPTY: suggestion strip NOT shown (flagged off)");
    assert(await p.getByTestId("chat-composer-attach").isVisible(), "EMPTY: attach (+) button shown");
    assert((await p.getByTestId("chat-composer-mic").count()) === 1, "EMPTY: mic button shown (no draft)");
    await snap(p, "state-empty");
    await p.close();
  }

  // booting: waking-up placeholder; typing AND voice are allowed (voice capture
  // is decoupled from agent-respond readiness — a transcript goes through the
  // same warm-tolerant send path, so the mic stays enabled while warming).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?phase=booting`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-textarea").getAttribute("placeholder"))?.includes("waking up"),
      "BOOTING: composer placeholder says 'waking up'",
    );
    assert(
      (await p.getByTestId("chat-composer-attach").getAttribute("aria-disabled")) !== "true",
      "BOOTING: attach (+) stays enabled (you can compose while it wakes)",
    );
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-disabled")) !== "true",
      "BOOTING: mic stays ENABLED while warming (voice decoupled from agent-ready)",
    );
    await snap(p, "state-booting");
    await p.close();
  }

  // recording: mic active + interim transcript
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?recording&phase=listening`);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "RECORDING: mic shows active (aria-pressed)",
    );
    assert(
      (await p.getByText("tell me the plan for", { exact: false }).count()) > 0,
      "LISTENING: interim transcript line is rendered",
    );
    await snap(p, "state-recording-listening");
    await p.close();
  }

  // speaking: the agent is delivering its reply aloud. Voice input is gated while
  // a reply is in flight, so the trailing control is the STOP (interrupt) — NOT
  // the mic — and no stray mute/speaker control pops in.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?speaking`);
    await p.waitForSelector('[data-testid="chat-composer-stop"]');
    await p.waitForTimeout(500);
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0,
      "SPEAKING: mic hidden while a reply is in flight (voice gated)",
    );
    assert(
      await p.getByTestId("chat-composer-stop").isVisible(),
      "SPEAKING: stop control shown to interrupt the spoken reply",
    );
    assert(
      (await p.getByTestId("chat-voice-mute").count()) === 0,
      "SPEAKING: no stray voice-mute button shown while the agent speaks",
    );
    await snap(p, "state-speaking");
    await p.close();
  }

  // AUDIO-UNLOCK chip with the sheet OPEN (regression): the chip renders at the
  // overlay root ABOVE the glass panel. The open-sheet outside-tap swallower
  // used to treat it as "outside" — eating the click (unlockAudio never fired)
  // AND collapsing the sheet, so sound could not be enabled while chat was open.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    const logs = [];
    p.on("console", (m) => logs.push(m.text()));
    await p.goto(`${url}?unlock`);
    await p.waitForSelector('[data-testid="overlay-voice-audio-unlock"]');
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open to half behind the chip
    await p.waitForTimeout(450);
    assert((await variant(p)) === "open", "UNLOCK: sheet opens behind the audio-unlock chip");
    await snap(p, "state-audio-unlock-open");
    await p.getByTestId("overlay-voice-audio-unlock").click();
    await p.waitForTimeout(300);
    assert(
      logs.some((t) => t.includes("[fixture] unlockAudio")),
      "UNLOCK: chip tap fires unlockAudio (not swallowed as an outside tap)",
    );
    assert(
      (await p.getByTestId("overlay-voice-audio-unlock").count()) === 0,
      "UNLOCK: chip clears once audio is unlocked",
    );
    assert(
      (await variant(p)) === "open",
      "UNLOCK: sheet STAYS OPEN — the chip tap is not an outside collapse",
    );
    await snap(p, "state-audio-unlock-cleared");
    await p.close();
  }

  // TRANSCRIBING while an inline reply is in flight (regression, #9880 path):
  // the mic reads "stop transcription" and must END the session on tap even
  // while `responding` is true — the OFF path was gated on the reply finishing,
  // leaving a lit, dead mic button.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    const logs = [];
    p.on("console", (m) => logs.push(m.text()));
    await p.goto(`${url}?transcribing&recording&speaking&phase=listening`);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-label")) ===
        "stop transcription",
      "TRANSCRIBING+REPLY: mic reads 'stop transcription'",
    );
    await snap(p, "state-transcribing-inline-reply");
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      logs.some((t) => t.includes("[fixture] stopTranscriptionAndMic")),
      "TRANSCRIBING+REPLY: mic tap ends transcription even mid-reply (not gated on responding)",
    );
    // With the mic off and the (fixture-constant) reply still in flight the
    // trailing control morphs mic → stop, exactly like the plain speaking state.
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0 &&
        (await p.getByTestId("chat-composer-stop").count()) === 1,
      "TRANSCRIBING+REPLY: after the tap the trailing control is the stop (mic off)",
    );
    await p.close();
  }

  // responding: typing dots inside the (opened) sheet
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?phase=responding`);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open to half so the dots are visible
    await p.waitForTimeout(450);
    assert(await p.getByTestId("typing-dots").isVisible(), "RESPONDING: typing-dots shown in the open sheet");
    await snap(p, "state-responding");
    await p.close();
  }

  // typing → send button morph, and Enter sends
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(600);
    const input = p.getByTestId("chat-composer-textarea");
    await input.fill("draft message");
    await p.waitForTimeout(200);
    assert(await p.getByTestId("chat-composer-action").isVisible(), "TYPING: trailing control morphs mic→send");
    assert((await p.getByTestId("chat-composer-mic").count()) === 0, "TYPING: mic hidden while a draft exists");
    assert((await variant(p)) === "open", "TYPING: composing pulls the sheet open");
    await snap(p, "state-typing-send");
    // SEND-TAP: tapping the send button must keep the composer focused so the
    // FIRST tap sends. Regression guard — previously the button stole focus, the
    // textarea blurred, the keyboard retracted and the composer relayouted
    // between pointerdown and click, so the first tap only dismissed the
    // keyboard and a second tap was needed. A preventDefault on the send
    // button's pointerdown keeps focus; Chromium still dispatches click.
    const focusedTestId = () =>
      p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    await input.focus();
    assert(
      (await focusedTestId()) === "chat-composer-textarea",
      "SEND-TAP: composer focused before send",
    );
    await p.getByTestId("chat-composer-action").click();
    await p.waitForTimeout(200);
    assert(
      (await focusedTestId()) === "chat-composer-textarea",
      "SEND-TAP: composer keeps focus after tapping send (keyboard stays up)",
    );
    assert(
      (await input.inputValue()) === "",
      "SEND-TAP: composer clears after tapping send",
    );
    await p.close();
  }

  // attach image → thumbnail + remove button (real file through the hidden input)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-attach"]');
    await p.waitForTimeout(600);
    // 1x1 transparent PNG
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await p.setInputFiles('input[type="file"]', {
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngB64, "base64"),
    });
    await p.waitForTimeout(350);
    assert((await p.locator('img[alt="shot.png"]').count()) === 1, "ATTACH: pending image thumbnail rendered");
    assert(await p.getByTestId("chat-composer-action").isVisible(), "ATTACH: send button shown for image-only turn");
    assert(await p.getByLabel("remove shot.png").isVisible(), "ATTACH: per-image remove button shown");
    await snap(p, "state-image-attached");
    await p.getByLabel("remove shot.png").click();
    await p.waitForTimeout(250);
    assert((await p.locator('img[alt="shot.png"]').count()) === 0, "REMOVE: thumbnail cleared after remove");
    await p.close();
  }

  // mic press → recording (interactive toggle, not URL-seeded)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(600);
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "MIC CLICK: toggles recording on",
    );
    await snap(p, "state-mic-clicked-recording");
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) !== "true",
      "MIC CLICK: toggles recording back off",
    );
    await p.close();
  }

  // VOICE ↔ CHAT, direction 1 — DICTATION fills the chat box (transcription into
  // the composer, editable, then sent as a normal turn). The user explicitly
  // asked this be tested both ways.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    await p.evaluate(() => window.__emitDictation?.("buy oat milk"));
    await p.waitForTimeout(200);
    let draft = await p.getByTestId("chat-composer-textarea").inputValue();
    assert(
      draft.includes("buy oat milk"),
      `DICTATION: final transcript fills the composer box (draft="${draft}")`,
    );
    assert(
      await p.getByTestId("chat-composer-action").isVisible(),
      "DICTATION: send control morphs in once the box holds the dictated text",
    );
    await snap(p, "state-dictation-in-box");
    // A second transcript APPENDS (proves it's an editable draft, not a replace).
    await p.evaluate(() => window.__emitDictation?.("at noon"));
    await p.waitForTimeout(150);
    draft = await p.getByTestId("chat-composer-textarea").inputValue();
    assert(
      draft.includes("buy oat milk") && draft.includes("at noon"),
      `DICTATION: a second transcript appends to the draft (draft="${draft}")`,
    );
    // Send the dictated draft → the box clears (the normal send path).
    const n = sink.logs.length;
    await p.getByTestId("chat-composer-action").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-textarea").inputValue()) === "",
      "DICTATION: sending the dictated draft clears the box",
    );
    assert(
      sink.logs.slice(n).some((l) => l.includes("[fixture] send:")),
      "DICTATION: the dictated text sends as a chat turn",
    );
    await p.close();
  }

  // VOICE ↔ CHAT, direction 2 — CONTINUOUS (hands-free) converse: a tap on the
  // mic opens the loop and a final transcript sends a VOICE_DM (spoken reply),
  // NOT a typed draft. Asserted via the fixture's channel-tagged send log.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-composer-mic").click(); // tap = hands-free converse
    await p.waitForTimeout(200);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "CONTINUOUS: tapping the mic starts the hands-free loop",
    );
    const n = sink.logs.length;
    await p.evaluate(() => window.__emitVoiceFinal?.("what is the weather"));
    await p.waitForTimeout(300);
    assert(
      sink.logs.slice(n).some((l) => l.includes("(VOICE_DM)")),
      "CONTINUOUS: a final transcript sends a VOICE_DM (spoken-reply turn), not a draft",
    );
    assert(
      (await p.getByTestId("chat-composer-textarea").inputValue()) === "",
      "CONTINUOUS: converse does NOT leave text in the composer box",
    );
    await p.close();
  }

  // PUSH-TO-TALK: press-and-hold the mic (>200ms, no drag) starts a "dictate"
  // capture; release stops it — and it must NOT toggle hands-free (the
  // suppress-click guard). Asserted via the fixture intent log.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    const mic = p.getByTestId("chat-composer-mic");
    const box = await mic.boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    const n = sink.logs.length;
    await p.mouse.move(mx, my);
    await p.mouse.down();
    await p.waitForTimeout(280); // exceed the 200ms press threshold (no movement)
    await p.mouse.up();
    await p.waitForTimeout(200);
    assert(
      sink.logs.slice(n).some((l) => l.includes("startRecording(dictate)")),
      "PTT: press-and-hold starts a DICTATE capture",
    );
    assert(
      sink.logs.slice(n).some((l) => l.includes("stopRecording")),
      "PTT: release stops the capture",
    );
    assert(
      !sink.logs.slice(n).some((l) => l.includes("toggleHandsFree")),
      "PTT: a held press does NOT toggle hands-free (suppress-click guard)",
    );
    await p.close();
  }

  // PTT CANCEL must NOT leak the click-suppress (the "next tap eaten" bug): a
  // held press ended by pointercancel (not pointerup) stops dictation but leaves
  // the NEXT quick tap free to toggle hands-free.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    const mic = p.getByTestId("chat-composer-mic");
    const n0 = sink.logs.length;
    await mic.dispatchEvent("pointerdown", { pointerId: 7, button: 0 });
    await p.waitForTimeout(280); // > 200ms → dictation starts
    await mic.dispatchEvent("pointercancel", { pointerId: 7 });
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n0).some((l) => l.includes("startRecording(dictate)")),
      "PTT-CANCEL: the hold started dictation",
    );
    assert(
      sink.logs.slice(n0).some((l) => l.includes("stopRecording")),
      "PTT-CANCEL: pointercancel stops the capture",
    );
    const n1 = sink.logs.length;
    await mic.click();
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n1).some((l) => l.includes("toggleHandsFree")),
      "PTT-CANCEL: the NEXT tap still toggles hands-free (suppress did not leak)",
    );
    await p.close();
  }

  // TYPING-PAUSE: while the hands-free loop is on, typing a draft must signal the
  // controller (setComposerHasDraft -> true) so the always-on mic pauses over the
  // keyboard; clearing it resumes.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-composer-mic").click(); // hands-free on
    await p.waitForTimeout(150);
    const n = sink.logs.length;
    await p.getByTestId("chat-composer-textarea").fill("hold on");
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n).some((l) => l.includes("setComposerHasDraft -> true")),
      "TYPING-PAUSE: a draft pauses the always-on loop (setComposerHasDraft true)",
    );
    const m = sink.logs.length;
    await p.getByTestId("chat-composer-textarea").fill("");
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(m).some((l) => l.includes("setComposerHasDraft -> false")),
      "TYPING-PAUSE: clearing the draft resumes the loop (setComposerHasDraft false)",
    );
    await p.close();
  }

  // suggestions are feature-flagged off — no strip, no chips at rest
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?empty`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    assert(
      (await p.locator('[data-testid^="chat-suggestion-"]').count()) === 0,
      "SUGGESTIONS: no chips rendered (flagged off)",
    );
    await snap(p, "state-suggestions-off");
    await p.close();
  }

  // multi-line: the composer auto-grows with newlines
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    const ta = p.getByTestId("chat-composer-textarea");
    const h1 = await ta.evaluate((el) => el.getBoundingClientRect().height);
    await ta.fill("line one\nline two\nline three\nline four");
    await p.waitForTimeout(250);
    const h2 = await ta.evaluate((el) => el.getBoundingClientRect().height);
    assert(
      h2 > h1 + 24,
      `MULTILINE: composer grows with newlines (${Math.round(h1)} → ${Math.round(h2)}px)`,
    );
    await snap(p, "state-multiline-input");
    await p.close();
  }

  // keyboard: focusing opens; tapping the scrim blurs the input + collapses
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    const focused = () =>
      p.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "chat-composer-textarea",
      );
    await p.getByTestId("chat-composer-textarea").focus();
    await p.waitForTimeout(150);
    assert(await focused(), "FOCUS: composer holds focus");
    assert((await variant(p)) === "open", "FOCUS: focusing opens the chat");
    await p
      .getByTestId("chat-sheet-backdrop")
      .click({ position: { x: 16, y: 16 }, force: true });
    await p.waitForTimeout(350);
    assert(
      (await focused()) === false,
      "CLICK-OUT: blurs the composer (mobile keyboard drops)",
    );
    assert((await variant(p)) === "closed", "CLICK-OUT: collapses the chat");
    await p.close();
  }

  // KEYBOARD SIZING: when the on-screen keyboard opens it shrinks the VISUAL
  // viewport. The overlay must (a) lift above the keyboard and (b) never grow
  // past the visible area — the thread scrolls instead of the panel spilling off
  // the top of the screen. We mock `window.visualViewport` (Playwright has no
  // soft keyboard) by shadowing it with an EventTarget whose `height` we shrink
  // and whose `resize` we dispatch — exactly the signal a real keyboard emits.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });
    attachConsole(p, sink);
    await p.addInitScript(() => {
      const innerH = window.innerHeight;
      const fake = new EventTarget();
      Object.assign(fake, {
        width: window.innerWidth,
        height: innerH,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        get: () => fake,
      });
      window.__setKeyboard = (kb) => {
        fake.height = innerH - kb;
        fake.offsetTop = 0;
        fake.dispatchEvent(new Event("resize"));
      };
    });
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);

    const metrics = () =>
      p.evaluate(() => {
        const overlay = document.querySelector(
          '[data-testid="continuous-chat-overlay"]',
        );
        const panel = document.querySelector('[data-testid="chat-sheet"]');
        const r = panel.getBoundingClientRect();
        return {
          overlayBottom: Number.parseFloat(getComputedStyle(overlay).bottom),
          panelTop: r.top,
          panelBottom: r.bottom,
          panelHeight: r.height,
          innerH: window.innerHeight,
          vvH: window.visualViewport.height, // visible bottom = keyboard line
        };
      });

    // rest, no keyboard: overlay sits flush at the bottom (inset 0)
    const rest = await metrics();
    assert(
      near(rest.overlayBottom, 0, 1),
      `KEYBOARD: overlay rests at the bottom with no keyboard (bottom ${rest.overlayBottom}px)`,
    );

    // raise a 334px keyboard while COLLAPSED — just the input lifts above it
    const KB = 334;
    await p.evaluate((kb) => window.__setKeyboard(kb), KB);
    await p.waitForTimeout(SETTLE);
    const collapsed = await metrics();
    assert(
      near(collapsed.overlayBottom, KB, 2),
      `KEYBOARD(collapsed): overlay lifts to sit above the keyboard (bottom ${Math.round(collapsed.overlayBottom)}px ≈ ${KB})`,
    );
    assert(
      collapsed.panelBottom <= collapsed.vvH + 1,
      `KEYBOARD(collapsed): input panel sits above the keyboard line (bottom ${Math.round(collapsed.panelBottom)} ≤ ${collapsed.vvH})`,
    );
    await snap(p, "state-keyboard-collapsed");

    // Flick to FULL with the keyboard still up — the WORST case for height.
    // Slow drags deliberately free-rest; the FULL semantic state requires a
    // committed flick/pull release, so drive the real touch path that way.
    await gesture(p, 120, { pointer: "touch", slow: false, steps: 2 }); // → HALF
    await p.waitForTimeout(SETTLE);
    await gesture(p, 240, { pointer: "touch", slow: false, steps: 2 }); // → FULL
    await p.waitForTimeout(SETTLE);
    const keyboardFullDetent = await detent(p);
    assert(
      keyboardFullDetent === "full",
      `KEYBOARD: pulled to FULL with the keyboard open (got ${keyboardFullDetent})`,
    );
    const full = await metrics();
    assert(
      full.panelTop >= -1,
      `KEYBOARD(full): tall panel does NOT spill above the screen top (top ${Math.round(full.panelTop)} ≥ 0)`,
    );
    assert(
      full.panelBottom <= full.vvH + 1,
      `KEYBOARD(full): panel stays above the keyboard line (bottom ${Math.round(full.panelBottom)} ≤ ${full.vvH})`,
    );
    assert(
      full.panelHeight <= full.vvH - 56 + 1,
      `KEYBOARD(full): panel height capped to the visible area (h ${Math.round(full.panelHeight)} ≤ ${full.vvH - 56})`,
    );
    await snap(p, "state-keyboard-full");

    // close the keyboard → the overlay drops back to the bottom
    await p.evaluate(() => window.__setKeyboard(0));
    await p.waitForTimeout(SETTLE);
    const reclosed = await metrics();
    assert(
      near(reclosed.overlayBottom, 0, 1),
      `KEYBOARD: overlay returns to the bottom when the keyboard closes (bottom ${Math.round(reclosed.overlayBottom)}px)`,
    );
    await p.close();
  }

  // no_provider failure → recovery gate (Connect a provider → Open Settings)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?failure=no_provider`);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open the sheet to reveal the gate
    await p.waitForTimeout(450);
    assert(
      await p.getByText("Connect a provider to chat").isVisible(),
      "NO_PROVIDER: structured recovery gate is rendered (not raw error text)",
    );
    const cta = p.getByTestId("chat-no-provider-settings");
    assert(await cta.isVisible(), "NO_PROVIDER: 'Open Settings' CTA shown");
    await snap(p, "state-no-provider-gate");
    await cta.click();
    await p.waitForTimeout(150);
    assert(
      sink.logs.some((l) => l.includes("[fixture] openSettings")),
      "NO_PROVIDER: tapping the CTA jumps to Settings",
    );
    await p.close();
  }

  // PILL: pull DOWN from the input collapses the whole chat into a small pill at
  // the bottom (input hidden). Slow-drag and flick both pill it; the composer
  // stays mounted but hidden + inert. (A pill TAP opens the chat — see PILL-TAP.)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    assert((await detent(p)) === "collapsed", "PILL: starts at input (collapsed)");
    // A SLOW drag down from the collapsed input also collapses to the pill —
    // there's nothing to "size" below the input, so down always means pill.
    await gesture(p, -90, { pointer: "touch", slow: true, steps: 12 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL: slow drag-down collapses the input → pill");
    // Reset to the input peek and verify a quick FLICK down pills it too.
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    assert((await detent(p)) === "collapsed", "PILL: reset to the input peek before flick check");
    await gesture(p, -90, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL: flick-down collapses the input → pill");
    assert(
      (await p.getByTestId("chat-pill").count()) === 1,
      "PILL: the recoverable pill capsule is shown",
    );
    // Persistent panel: the composer stays MOUNTED across pill↔input (so the
    // morph is continuous, never a remount) but is hidden — opacity 0 + `inert`.
    {
      const contentOpacity = await p
        .getByTestId("chat-content")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
      // ≤0.12, not ≤0.05: the morph to openProgress 0 is an asymptotic spring,
      // so after the settle window it's imperceptibly-but-not-exactly 0 (it
      // occasionally lands ~0.05). 12% opacity is still visually hidden; the
      // tight bound just flaked.
      assert(
        contentOpacity <= 0.12,
        `PILL: the input is visually hidden in pill mode (content opacity ${contentOpacity})`,
      );
      assert(
        (await p.getByTestId("chat-content").getAttribute("inert")) !== null,
        "PILL: the input is inert (out of tab order / a11y tree) in pill mode",
      );
    }
    await snap(p, "state-pill");
    await p.close();
  }

  // ── PILL TAP opens the chat to HALF (regression for the reported bug): a real
  // TAP (pointerdown+up, no move) routes through the gesture's onDrag(0) → onTap
  // path. It must open the chat in ONE tap straight to the HALF detent (the
  // conversation is visible) — NOT blink to a bare input bar that needs a second
  // tap. Assert the detent is half/open AND the content actually formed (opacity
  // ~1), not just a detent label with a stuck-at-0 morph.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -90, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL-TAP: collapsed to pill first");
    // Real tap: touchStart then touchEnd at the SAME spot (no move).
    await touchTap(p, '[data-testid="chat-pill"]');
    await p.waitForTimeout(SETTLE);
    const openedOpacity = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      openedOpacity > 0.9,
      `PILL-TAP: tap animates pill → chat, content fully formed (opacity ${openedOpacity})`,
    );
    assert(
      (await detent(p)) === "half",
      `PILL-TAP: a SINGLE tap opens the chat to half (got ${await detent(p)})`,
    );
    assert((await variant(p)) === "open", "PILL-TAP: the chat is open after one tap");
    await snap(p, "state-pill-tap-opened");
    await p.close();
  }

  // reduced-motion still opens via flick
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 120, { pointer: "mouse", slow: true });
    await p.waitForTimeout(200);
    assert((await variant(p)) === "open", "REDUCED-MOTION: pull-up still opens");
    await snap(p, "state-reduced-motion-open");
    await p.close();
  }

  // HEADER NAV (post-consolidation): the per-tab Home/Views/Settings trio is
  // gone — a single always-present, always-enabled Launcher button replaces
  // it, and the old testids must stay gone (regression guard for #9450).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "half", "NAV: opened to half");
    assert(
      (await p.getByTestId("chat-full-launcher").count()) === 1 &&
        !(await p.getByTestId("chat-full-launcher").isDisabled()),
      "NAV: single launcher button present and enabled",
    );
    assert(
      (await p.getByTestId("chat-full-home").count()) === 0 &&
        (await p.getByTestId("chat-full-views").count()) === 0 &&
        (await p.getByTestId("chat-full-settings").count()) === 0,
      "NAV: legacy home/views/settings buttons removed (#9450)",
    );
    await p.close();
  }

  // NAVIGATE-AND-CLOSE: tapping Launcher animates OUT of maximize (if
  // maximized) and collapses the sheet, THEN navigates — the page swap waits for
  // the close animation to start, so it reads as the chat closing into the new
  // view rather than a jump-cut from full-screen.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, 140, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    await p.getByTestId("chat-full-maximize").click();
    await p.waitForTimeout(SETTLE);
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "NAV-CLOSE: maximized before tapping launcher",
    );
    await p.getByTestId("chat-full-launcher").click();
    await p.waitForTimeout(600);
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 0,
      "NAV-CLOSE: tapping launcher animates OUT of maximize",
    );
    assert(
      (await detent(p)) === "collapsed",
      "NAV-CLOSE: tapping launcher collapses the sheet (close)",
    );
    assert(
      sink.logs.some((l) => l.includes("navigateHome")),
      "NAV-CLOSE: launcher navigation fires after the close starts",
    );
    await p.close();
  }

  // MAXIMIZE-FROM-HALF: tapping maximize at the HALF detent rises to FULL and
  // goes edge-to-edge (was a no-op — full-bleed required the FULL flag). And the
  // full-screen panel fills top-to-bottom with no gap at the bottom.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "half", "MAX-HALF: at half before maximize");
    await p.getByTestId("chat-full-maximize").click();
    await p.waitForTimeout(SETTLE);
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "MAX-HALF: maximize from HALF goes full-screen",
    );
    const box = await p.getByTestId("chat-sheet").boundingBox();
    const vh = await p.evaluate(() => window.innerHeight);
    assert(
      !!box && box.y <= 8 && box.y + box.height >= vh - 2,
      `MAX-HALF: full-screen fills top-to-bottom — no bottom gap (y=${Math.round(
        box?.y ?? -1,
      )}, bottom=${Math.round((box?.y ?? 0) + (box?.height ?? 0))}, vh=${vh})`,
    );
    await p.close();
  }

  // ── MAXIMIZE WITH A BOTTOM GESTURE INSET (regression): on Android the home-
  // gesture inset feeds the overlay's bottom padding, which is cached into
  // `bottomPad`. Full-bleed drops that padding to 0 (the composer carries the
  // clearance), so the panel must fill the WHOLE viewport. The bug: panelMaxH
  // still subtracted the stale bottomPad, so the maximized panel floated a
  // gesture-inset BELOW the top — a hard-cut glass seam under the status bar and
  // the safe-area-padded header pushed down. Assert: panel reaches y≈0 AND the
  // header buttons sit at the safe area, not a gesture-inset lower.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    // Simulate the Android insets, then fire a resize so the overlay samples its
    // (now gesture-inset-padded) bottom padding into bottomPad while NOT maximized.
    await p.evaluate(() => {
      const r = document.documentElement.style;
      r.setProperty("--android-gesture-inset-bottom", "32px");
      r.setProperty("--safe-area-top", "30px");
      window.dispatchEvent(new Event("resize"));
    });
    await p.waitForTimeout(120);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 2 }); // → half
    await p.waitForTimeout(SETTLE);
    await p.getByTestId("chat-full-maximize").click(); // → full-bleed
    await p.waitForTimeout(SETTLE);
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "MAX-INSET: maximized full-bleed",
    );
    const box = await p.getByTestId("chat-sheet").boundingBox();
    assert(
      !!box && box.y <= 2,
      `MAX-INSET: maximized panel fills to the TOP despite the bottom inset (y=${Math.round(
        box?.y ?? -1,
      )}) — no status-bar seam`,
    );
    const btn = await p.getByTestId("chat-full-maximize").boundingBox();
    // Header padding = safe-area-top (30) + 0.5rem (8); buttons must sit ~there,
    // NOT a whole gesture inset (~36px) lower (the old "bad space" margin).
    assert(
      !!btn && btn.y <= 30 + 8 + 20,
      `MAX-INSET: header buttons sit at the safe area, not pushed down by a gap (y=${Math.round(
        btn?.y ?? -1,
      )})`,
    );
    await snap(p, "state-maximized-with-inset");
    await p.close();
  }

  // ── ALL FIVE CHATSTATES (the canonical machine) — assert data-chat-state + the
  // header-button gate, screenshot each (the user asked for a shot of every
  // state). Driven by real gestures on the grabber + the pill.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    assert((await chatState(p)) === "INPUT", "STATES: rest is INPUT");
    assert(
      !(await headerShown(p)),
      "STATES: INPUT shows no header buttons",
    );
    await snap(p, "state-INPUT");

    await gesture(p, halfH, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "OPEN_HALF_OR_OVER",
      `STATES: flick-up → OPEN_HALF_OR_OVER (got ${await chatState(p)})`,
    );
    assert(
      await headerShown(p),
      "STATES: OPEN_HALF_OR_OVER shows header buttons",
    );
    await snap(p, "state-OPEN_HALF_OR_OVER");

    await p.getByTestId("chat-full-maximize").click();
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "MAXIMIZED",
      `STATES: maximize → MAXIMIZED (got ${await chatState(p)})`,
    );
    await snap(p, "state-MAXIMIZED");

    // #10698 regression: the floating transcript's message bubbles carry NO
    // per-message fill — text floats over the ONE shared panel glass. The
    // backdrop-blur gate only bans blur, not a fill, so a re-added
    // bg-black*/bg-white/10 would slip past it. Assert the COMPUTED background of
    // the WHOLE per-message wrapper chain — every ancestor from the selectable
    // content up to (excluding) the thread-line container — so a fill re-added
    // at any wrapper level is caught, not just on the immediate parent.
    const bubbleBackgrounds = await p
      .locator('[data-testid="thread-line"] [data-chat-selectable="true"]')
      .evaluateAll((nodes) =>
        nodes.flatMap((n) => {
          const chain = [];
          for (
            let el = n.parentElement;
            el && el.getAttribute("data-testid") !== "thread-line";
            el = el.parentElement
          ) {
            chain.push(getComputedStyle(el).backgroundColor);
          }
          return chain.length > 0 ? chain : ["missing"];
        }),
      );
    assert(
      bubbleBackgrounds.length > 0,
      `#10698: populated thread renders message bubbles (found ${bubbleBackgrounds.length})`,
    );
    const filled = bubbleBackgrounds.filter(
      (bg) => bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent",
    );
    assert(
      filled.length === 0,
      `#10698: message bubbles have NO per-message fill (transparent bg); filled=${JSON.stringify(filled)}`,
    );
    await p.close();
  }

  // OPEN_UNDER_HALF + CLOSED on a fresh page (cleaner than stepping down from
  // MAXIMIZED, which is full-bleed and has no grabber to drag).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    // OPEN_UNDER_HALF — a slow short pull from INPUT rests in the gap below half.
    // Use MANY steps so the drag is unambiguously slow: this pull travels ~half
    // the half-detent (~200px), and at the default step count its velocity lands
    // right on the 0.5 px/ms flick threshold — a hair over and it snaps to the
    // half detent instead of free-resting (the intermittent failure). More steps
    // ⇒ longer elapsed ⇒ velocity well under the threshold ⇒ deterministic settle.
    await gesture(p, Math.round(halfH * 0.5), {
      pointer: "mouse",
      slow: true,
      steps: 30,
    });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "OPEN_UNDER_HALF",
      `STATES: slow free-rest below half → OPEN_UNDER_HALF (got ${await chatState(p)})`,
    );
    assert(
      !(await headerShown(p)),
      "STATES: OPEN_UNDER_HALF hides header buttons",
    );
    // With the header hidden below half, the thread viewport must be inset below
    // the floating grabber so the topmost line isn't tucked under the handle.
    const padBelowHalf = await p
      .getByTestId("chat-thread")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop) || 0);
    assert(
      padBelowHalf > 8,
      `STATES: OPEN_UNDER_HALF insets the thread below the grabber (paddingTop ${padBelowHalf})`,
    );
    await snap(p, "state-OPEN_UNDER_HALF");

    // CLOSED — flick down to input, then down again to the pill. Real touch:
    // the grabber sits near the screen bottom, so a downward mouse drag clamps at
    // the viewport edge; CDP touch events carry the full downward delta.
    await gesture(p, -vh, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "CLOSED",
      `STATES: flick-down from input → CLOSED (got ${await chatState(p)})`,
    );
    await snap(p, "state-CLOSED");
    await p.close();
  }

  // ── PILL → INPUT → CHAT liquid-glass morph. A flick-up from the pill reaches
  // the chat (B4 fix — used to dead-stop at the bare input); a slow drag LERPS
  // the morph (content opacity strictly between 0 and 1 mid-pull).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await chatState(p)) === "CLOSED", "PILL-MORPH: collapsed to pill");

    // MID-DRAG hold: slow-pull the PILL up ~half the open distance and HOLD —
    // the glass/content crossfades in proportionally (not a discrete pop).
    await gesture(p, 60, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 8,
      target: "chat-pill",
    });
    const midOpacity = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      midOpacity > 0.05 && midOpacity < 0.95,
      `PILL-MORPH: content lerps in mid-drag (opacity ${midOpacity})`,
    );
    // NEVER two pills: the grabber bar and the (identical) pill bar must not both
    // be visible at any point in the morph. They crossfade through ~0 at the
    // midpoint — read both live opacities and assert they're never both shown.
    const grabO = await p
      .getByTestId("chat-sheet-grabber")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    const pillO = await p
      .getByTestId("chat-pill")
      .evaluate((el) =>
        Number.parseFloat(getComputedStyle(el.parentElement).opacity),
      );
    assert(
      !(grabO > 0.15 && pillO > 0.15),
      `PILL-MORPH: never two handle bars at once (grabber ${grabO}, pill ${pillO})`,
    );
    await snap(p, "transition-pill-to-input-mid-drag");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);

    // FLICK up from the pill → reaches the chat (history present), not a stop.
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, 140, {
      pointer: "mouse",
      slow: false,
      steps: 2,
      target: "chat-pill",
    });
    await p.waitForTimeout(SETTLE);
    const after = await chatState(p);
    assert(
      after === "OPEN_HALF_OR_OVER" || after === "OPEN_UNDER_HALF",
      `PILL-MORPH: a flick from the pill reaches the chat (got ${after})`,
    );
    await snap(p, "transition-pill-to-chat-flick");
    await p.close();
  }

  // ── INPUT → PILL liquid-glass morph (regression for the dead collapse drag):
  // dragging the input peek DOWN toward the pill must morph it LIVE under the
  // finger — the input bar fades + scales into the pill capsule — instead of
  // staying fully formed (content opacity 1, pill 0) and only snapping to the
  // pill on release (the unresponsive gesture). Mirrors the pill→input morph.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(600);
    assert(
      (await detent(p)) === "collapsed",
      "INPUT-PILL-MORPH: starts at the input peek",
    );
    // Slow drag DOWN ~90px (of the 120px morph distance) and HOLD — mid-drag the
    // input should be ~3/4 morphed to the pill: content well below opacity 1, the
    // pill capsule clearly fading in.
    await gesture(p, -90, { pointer: "mouse", slow: true, hold: true, steps: 8 });
    const contentMid = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    const pillMid = await p
      .getByTestId("chat-pill")
      .evaluate((el) =>
        Number.parseFloat(getComputedStyle(el.parentElement).opacity),
      );
    assert(
      contentMid < 0.95,
      `INPUT-PILL-MORPH: the input fades mid-drag (content opacity ${contentMid})`,
    );
    assert(
      pillMid > 0.05,
      `INPUT-PILL-MORPH: the pill capsule fades in mid-drag (pill opacity ${pillMid})`,
    );
    await snap(p, "transition-input-to-pill-mid-drag");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);
    assert(
      (await detent(p)) === "pill",
      "INPUT-PILL-MORPH: settles to the pill on release",
    );
    await p.close();
  }

  // ── PILL → INPUT on a short SLOW pull: a slow drag up from the pill that only
  // forms the input bar (past the halfway-open mark but short of the thread)
  // must settle at the INPUT state, NOT overshoot to the half detent. Regression
  // guard for the onSettleFree pill branch (it used to force half on any open).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL-INPUT: collapsed to pill first");
    // SLOW pull up ~80px: past the 60px halfway-open mark (commits to leaving the
    // pill) but under PILL_OPEN_DISTANCE (120px), so only the input bar forms.
    await gesture(p, 80, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 10,
      target: "chat-pill",
    });
    const heldRadii = await panelRadii(p);
    assert(
      near(heldRadii.surface, heldRadii.content, 0.5),
      `PILL-INPUT: held drag keeps glass/content radii in sync (surface ${heldRadii.surface}, content ${heldRadii.content})`,
    );
    assert(
      heldRadii.surface > 0 && heldRadii.surface <= 40,
      `PILL-INPUT: held drag uses a real capsule radius, not a huge clamped radius (${heldRadii.surface})`,
    );
    await p.mouse.up();
    await p.waitForTimeout(SETTLE);
    const st = await chatState(p);
    assert(
      st === "INPUT",
      `PILL-INPUT: short slow pull from pill settles at INPUT, not half (got ${st})`,
    );
    await snap(p, "transition-pill-slow-pull-to-input");
    await p.close();
  }

  // ── ROTATION re-settles to a single CLEAN bar (flip-to-side): a viewport SIZE
  // change must never leave the pill↔input morph stranded mid-crossfade. The
  // crossfade math already prevents two bars at once, but a rotation that fires
  // MID-DRAG (rotation often orphans the pointer → draggingRef stuck +
  // openProgress frozen) would leave a half-formed bar and a stuck drag. Assert
  // the morph snaps to a clean resting end (one bar at full opacity).
  {
    const barOpacities = async (pg) => {
      const grabO = await pg
        .getByTestId("chat-sheet-grabber")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
      const pillO = await pg
        .getByTestId("chat-pill")
        .evaluate((el) =>
          Number.parseFloat(getComputedStyle(el.parentElement).opacity),
        );
      return { grabO, pillO, two: grabO > 0.15 && pillO > 0.15 };
    };

    // Rotate MID-MORPH with the pointer HELD — the orphaned-drag case. Flick to
    // pill, start a slow pill drag and HOLD it mid-crossfade, then rotate WITHOUT
    // releasing. The resize must force-settle: pill fully back, grabber gone.
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "ROTATION: collapsed to pill first");
    await gesture(p, 60, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 8,
      target: "chat-pill",
    });
    const midContent = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      midContent > 0.05 && midContent < 0.95,
      `ROTATION: held mid-crossfade before rotating (content ${midContent})`,
    );
    await p.setViewportSize({ width: 874, height: 402 }); // rotate to landscape
    await p.waitForTimeout(SETTLE);
    {
      const b = await barOpacities(p);
      assert(
        !b.two,
        `ROTATION: never two bars after rotating mid-morph (grab ${b.grabO}, pill ${b.pillO})`,
      );
      assert(
        b.pillO > 0.85 && b.grabO < 0.15,
        `ROTATION: morph re-settled to the single pill bar (grab ${b.grabO}, pill ${b.pillO})`,
      );
    }
    await release(p, "mouse");
    await snap(p, "rotation-mid-morph-resettled");
    await p.close();
  }

  // ── HEADER tracks the LIVE height (bug 1): dragging the panel below half must
  // HIDE the top buttons MID-DRAG, not keep them on a too-short panel. And the
  // MAXIMIZED enum can never disagree with the full-bleed layout.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    // Open to full so the header is shown and the grabber sits high (a downward
    // drag stays on-screen).
    await gesture(p, vh, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    assert(
      await headerShown(p),
      "HEADER-LIVE: header shown at full before the drag",
    );
    // Slow-drag DOWN well below half and HOLD (don't release) — the header must
    // already be gone while the finger is still down.
    await gesture(p, -Math.round(halfH * 1.3), {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 10,
    });
    assert(
      !(await headerShown(p)),
      "HEADER-LIVE: header is HIDDEN mid-drag once the panel renders below half",
    );
    await snap(p, "state-mid-drag-below-half-no-header");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);

    // Invariant: data-chat-state==="MAXIMIZED" IFF data-maximized==="true".
    await gesture(p, vh, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    await p.getByTestId("chat-full-maximize").click();
    await p.waitForTimeout(SETTLE);
    {
      const cs = await chatState(p);
      const max = await p
        .getByTestId("chat-sheet")
        .getAttribute("data-maximized");
      assert(
        (cs === "MAXIMIZED") === (max === "true"),
        `HEADER-LIVE: chat-state MAXIMIZED iff data-maximized (state=${cs}, maximized=${max})`,
      );
    }
    await p.close();
  }

  // ── STREAMING (bug 2): the in-flight (empty) assistant turn breathes the dots
  // ANCHORED inside its own bubble, not as a detached "..." sibling — so the
  // streamed text fills in right there.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?streaming`);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    // Open the thread so the in-flight assistant bubble is on screen.
    await gesture(p, 400, { pointer: "mouse", slow: false, steps: 2 });
    await p.waitForTimeout(SETTLE);
    const dotsInBubble = await p
      .locator(
        '[data-testid="thread-line"][data-role="assistant"] [data-testid="typing-dots"]',
      )
      .count();
    assert(
      dotsInBubble >= 1,
      `STREAMING: dots are anchored inside the in-flight assistant bubble (found ${dotsInBubble})`,
    );
    await snap(p, "state-streaming-dots-in-bubble");
    await p.close();
  }

  // ── MULTI-SEND + voice gating (Phase A): while a reply is in flight the mic is
  // gated; the trailing control is STOP with no draft, and SWAPS to an ENABLED
  // "send another" the instant you type — sending queues another turn into the
  // room (serialized multi-send) instead of being blocked until the reply lands.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?streaming`);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(400);
    // No draft while responding → STOP, and the mic is gated (not rendered).
    assert(
      await p.getByTestId("chat-composer-stop").isVisible(),
      "MULTI-SEND: STOP shown while responding with no draft",
    );
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0,
      "MULTI-SEND: mic gated while responding",
    );
    // Type → the trailing control swaps to an ENABLED send (queue another turn).
    const input = p.getByTestId("chat-composer-textarea");
    await input.fill("queue another");
    await p.waitForTimeout(150);
    const action = p.getByTestId("chat-composer-action");
    assert(
      await action.isVisible(),
      "MULTI-SEND: send shown while responding + draft",
    );
    assert(
      (await action.getAttribute("aria-disabled")) !== "true",
      "MULTI-SEND: send ENABLED while responding (send another)",
    );
    const before = await p.getByTestId("thread-line").count();
    await action.click();
    await p.waitForTimeout(200);
    const after = await p.getByTestId("thread-line").count();
    assert(
      after > before,
      `MULTI-SEND: sending while responding appends another message (${before} → ${after})`,
    );
    await snap(p, "state-multi-send-while-responding");
    await p.close();
  }
} finally {
  await browser.close();
}

// --- Logs + errors review ---
console.log("\n── browser console (sample) ──");
for (const line of sink.logs.slice(0, 6)) console.log(`  ${line}`);
const errorLevel = sink.logs.filter((l) => l.startsWith("[error]"));
assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);
assert(errorLevel.length === 0, `no error-level console messages (${errorLevel.length})`);
assert(
  sink.logs.some(
    (l) =>
      l.includes("[fixture] toggleHandsFree") ||
      l.includes("[fixture] toggleRecording") ||
      l.includes("startRecording"),
  ),
  "fixture logged a voice interaction (mic tap → hands-free / recording)",
);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nCHAT-SHEET E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nCHAT-SHEET E2E PASSED");

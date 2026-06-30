/**
 * Perf-gate e2e (#9954, Item 5) — headless-Chromium harness that drives the REAL
 * ContinuousChatOverlay (perf-gate-fixture.tsx mounts the live overlay over a
 * long, overflowing thread and a multi-conversation list) and feeds REAL
 * PerformanceObserver / requestAnimationFrame entries into the SAME shared,
 * unit-tested detectors the dev HUD uses:
 *
 *   - frame-budget.ts — summarizeFrameSamples + shouldReportFrameBudget over raw
 *     inter-frame rAF deltas + longtask counts, collected PER GESTURE WINDOW via
 *     the FRAME_SAMPLER_INIT start()/read()/stop() controls (each window measured
 *     in isolation, so a regression on scroll vs swipe is attributable).
 *   - layout-stability.ts — summarizeStability over raw `layout-shift` entries
 *     (collected by LAYOUT_SHIFT_OBSERVER_INIT) across the steady-state
 *     interaction (the buffer is reset AFTER the one-time sheet-open animation).
 *
 * It opens the chat sheet to FULL (so `#continuous-thread`, the real scroll +
 * conversationSwipe surface, is mounted + bound) and then drives:
 *   1. REAL overlay thread-scroll  — vertical pointer flings over the
 *      overflowing `#continuous-thread` (axis-locks to native scroll),
 *   2. REAL conversation-swipe     — horizontal pointer swipes over the SAME
 *      `#continuous-thread`, i.e. the overlay's production conversationSwipe
 *      wiring that navigates between live conversations.
 *
 * HARD-FAILS (process.exit(1)) when a per-gesture window breaches the frame
 * thresholds (sample-count floor, p95 frame time, dropped-frame %, long tasks)
 * or the session's non-intentional CLS exceeds budget.
 *
 * The detectors are pure + meta-tested; this is the live-surface driver that
 * feeds them real numbers so a jank/CLS regression fails a build instead of only
 * blinking in the dev PerfOverlay.
 *
 * Run: bun run --cwd packages/ui test:perf-gate-e2e
 * Exits non-zero on any breached threshold or page error.
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  FRAME_SAMPLER_INIT,
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
} from "../../../testing/layout-stability.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-perf-gate-e2e");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

// ── Hard-gate thresholds. CALIBRATED to the MEASURED develop baseline of the
// REAL ContinuousChatOverlay in this headless-Chromium harness, with comfortable
// headroom so refresh-rate / CI-VM noise doesn't redden the lane while a real
// regression (sustained jank, a content reflow during swipe) trips.
//
// MEASURED BASELINE — develop real overlay, this harness, 3 runs, headless
// chromium (the dev box composites at ~120Hz, so a clean frame is ~8.3ms):
//   overlay-scroll:      fps ~120,    p95 9.7–9.8ms, dropped 0/593–627  (0%),  long 0
//   conversation-swipe:  fps ~117–120, p95 9.7–10.1ms, dropped 0–3/449–464 (≤1%),
//                        worst 17–67ms (the swipe-commit content-swap frame), long 0–1
//   session CLS:         0.0000 (scroll + translateX swipe composite, no reflow)
//
// The frame gate is expressed as a FACTOR over the 60fps budget (16.67ms), not a
// fixed ms, so it auto-adapts to a 60Hz CI runner (where a clean frame is already
// ~16.7ms) as well as a 120Hz dev box — matching the already-merged sibling
// real-overlay gate run-chat-perf-gate.mjs (p95BudgetFactor 2).
const FRAME_BUDGET = { targetFps: 60 };
const FRAME_GATE = {
  // p95 may reach 2× the 16.67ms 60fps budget (33.3ms / ≥30fps) before we flag.
  // Baseline p95 ~10ms here (~3.3× headroom); on a 60Hz CI runner a clean p95 is
  // ~16.7ms (~2× headroom). (HUD reports at 1.25×.)
  p95BudgetFactor: 2,
  // ≥20% of frames over the 60fps budget = unambiguous jank. Baseline tops out at
  // ~1% here, so this is ~20× headroom (tighter than the sibling gate's 25%).
  droppedFrameRatio: 0.2,
  // Long tasks are REPORTED (printed per window) but not a hard-fail criterion:
  // the live overlay re-renders the whole thread on a swipe-commit, which
  // legitimately spikes 0–3 long tasks WITHOUT breaching the frame budget
  // (dropped stays ≤1%, p95 ~10ms). The issue's named gate criteria are
  // dropped-frame %, p95 frame-time, and CLS — and the already-merged sibling
  // real-overlay gate run-chat-perf-gate.mjs sets this false for the same reason.
  reportOnLongTask: false,
};
const MIN_SAMPLES = 30; // a real gesture must animate ≥30 frames; else regression
// Web-Vitals "good" is 0.1; baseline session CLS is 0.0000, so 0.1 is the safe
// budget (same one run-home-screen-e2e + run-chat-perf-gate apply to the live UI).
const MAX_CLS = 0.1;

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild stubs for the REAL-overlay bundle (copied from
// run-conversation-swipe-e2e / run-chat-perf-gate): the prompt-suggestions hook
// hits the API, @elizaos/core transitively reaches its Node graph, and node
// builtins are dead in the browser. ───────────────────────────────────────────
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
    }));
  },
};
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
  entryPoints: [join(here, "perf-gate-fixture.tsx")],
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
const html = `<!doctype html><html><head><meta charset="utf-8"><title>perf gate e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#16121c}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "perf-gate.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

/**
 * Dispatch a real touch-pointer drag from a CSS-selected element's centre by
 * (dx, dy). The per-step waits let the in-page rAF frame sampler actually tick
 * across the drag (a back-to-back synthetic burst can commit before a single
 * frame delta lands), so each gesture window is a non-empty sample set.
 */
async function drag(p, selector, dx, dy, { steps = 12, stepMs = 16 } = {}) {
  const box = await p.locator(selector).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.evaluate(
    ({ cx, cy, selector }) => {
      const el = document.querySelector(selector);
      window.__t = el;
      el?.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 1,
          pointerType: "touch",
          clientX: cx,
          clientY: cy,
          bubbles: true,
        }),
      );
    },
    { cx, cy, selector },
  );
  for (let i = 1; i <= steps; i += 1) {
    const x = cx + (dx * i) / steps;
    const y = cy + (dy * i) / steps;
    await p.evaluate(
      ({ x, y }) =>
        window.__t?.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerId: 1,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        ),
      { x, y },
    );
    await p.waitForTimeout(stepMs);
  }
  await p.evaluate(
    ({ x, y }) =>
      window.__t?.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 1,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      ),
    { x: cx + dx, y: cy + dy },
  );
}

/**
 * Sample REAL frames over one gesture window: start the in-page sampler, run the
 * driver, read the raw deltas + longtask count, feed them to the shared pure
 * summarizer, and HARD-FAIL on the frame thresholds.
 */
async function gateWindow(page, label, drive) {
  await page.evaluate(() => window.__ELIZA_FRAME.start());
  await drive();
  const { deltas, longTasks } = await page.evaluate(() =>
    window.__ELIZA_FRAME.read(),
  );
  await page.evaluate(() => window.__ELIZA_FRAME.stop());

  const s = summarizeFrameSamples(deltas, longTasks, FRAME_BUDGET);
  const droppedPct = (100 * s.droppedFrames) / Math.max(1, s.sampleCount);
  console.log(
    `  [${label}] fps=${s.fps.toFixed(1)} p95=${s.p95FrameMs.toFixed(1)}ms ` +
      `worst=${s.worstFrameMs.toFixed(1)}ms dropped=${s.droppedFrames}/${s.sampleCount} ` +
      `(${droppedPct.toFixed(0)}%) long=${s.longTasks}`,
  );
  // Guard the vacuous pass: shouldReportFrameBudget returns false on 0 samples.
  assert(
    s.sampleCount >= MIN_SAMPLES,
    `[${label}] captured ≥${MIN_SAMPLES} frames (got ${s.sampleCount})`,
  );
  assert(
    !shouldReportFrameBudget(s, FRAME_GATE),
    `[${label}] within frame budget (p95 ${s.p95FrameMs.toFixed(1)}ms ≤ ` +
      `${(s.budgetMs * FRAME_GATE.p95BudgetFactor).toFixed(1)}ms, dropped ` +
      `${droppedPct.toFixed(0)}% < ${(FRAME_GATE.droppedFrameRatio * 100).toFixed(0)}%)`,
  );
  return s;
}

const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext({
  // Mobile viewport so the overlay renders its sheet (the production phone
  // surface the gate is meant to protect).
  viewport: { width: 420, height: 820 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 420, height: 820 } },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));

// Inject BOTH collectors before any paint, so every frame + shift is captured.
await page.addInitScript(FRAME_SAMPLER_INIT);
await page.addInitScript(LAYOUT_SHIFT_OBSERVER_INIT);
await page.goto(url);
await page.waitForSelector('[data-testid="chat-sheet"]');
await page.waitForTimeout(600);

// Open the sheet to FULL so `#continuous-thread` (the real scroll + swipe
// surface) is mounted + bound. Two pull-ups on the grabber: collapsed → half →
// full (mirrors run-conversation-swipe-e2e / run-chat-perf-gate).
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
await page.waitForTimeout(450);
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
await page.waitForTimeout(450);
assert(
  (await page.locator("#continuous-thread").count()) === 1,
  "thread (scroll + swipe surface) is mounted with the sheet open",
);
assert(
  (await page.locator("#continuous-thread").evaluate(
    (el) => el.scrollHeight > el.clientHeight + 8,
  )),
  "thread actually overflows (real scroll surface, not a stub)",
);
await snap(page, "perf-gate-open");

// Reset the layout-shift buffer AFTER the one-time sheet-open animation, so the
// CLS gate measures the steady-state scroll+swipe interaction, not the mount.
await page.evaluate(() => {
  window.__ELIZA_LAYOUT_SHIFTS__ = [];
});

// ── 1. REAL overlay thread-scroll — vertical pointer flings over the
// overflowing #continuous-thread (a mostly-vertical drag axis-locks to native
// scroll). ─────────────────────────────────────────────────────────────────────
await gateWindow(page, "overlay-scroll", async () => {
  for (let i = 0; i < 6; i += 1) {
    await drag(page, "#continuous-thread", 6, -200, { steps: 12, stepMs: 16 });
    await page.waitForTimeout(120);
    await drag(page, "#continuous-thread", 6, 200, { steps: 12, stepMs: 16 });
    await page.waitForTimeout(120);
  }
});
await snap(page, "after-scroll");

// ── 2. REAL conversation-swipe — horizontal pointer swipes over the SAME
// #continuous-thread, i.e. the overlay's production conversationSwipe wiring
// that navigates between live conversations. ──────────────────────────────────
await gateWindow(page, "conversation-swipe", async () => {
  for (let i = 0; i < 4; i += 1) {
    await drag(page, "#continuous-thread", -180, 4, { steps: 14, stepMs: 16 });
    await page.waitForTimeout(200);
    await drag(page, "#continuous-thread", 180, 4, { steps: 14, stepMs: 16 });
    await page.waitForTimeout(200);
  }
});
await snap(page, "after-swipe");

// ── 3. Layout stability across the steady-state interaction (mirror
// run-home-screen-e2e / run-chat-perf-gate). ──────────────────────────────────
const shifts = await page.evaluate(() => window.__ELIZA_LAYOUT_SHIFTS__ ?? []);
const stability = summarizeStability(shifts, [], { maxCls: MAX_CLS });
console.log(
  `  [layout] cls=${stability.cls.toFixed(4)} non-intentional-shifts=${stability.shiftCount} flashed=${stability.flashed}`,
);
assert(
  !stability.flagged,
  `layout stable during scroll+swipe (CLS ${stability.cls.toFixed(4)} ≤ ${MAX_CLS}, ${stability.shiftCount} shifts)`,
);

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
if (errors.length) console.log(errors.join("\n"));

await page.close(); // flush the video
await context.close();
await browser.close();

// Rename the recorded video to a stable name.
const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
if (vids[0]) {
  await rename(join(videoDir, vids[0]), join(outDir, "perf-gate.webm"));
  console.log("  🎬 perf-gate.webm");
}

console.log(
  failures === 0 ? "\nPERF GATE PASSED" : `\n${failures} GATE CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);

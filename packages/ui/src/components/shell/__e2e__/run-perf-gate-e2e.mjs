/**
 * Perf-gate e2e (#9954, Item 5) — headless-Chromium harness that drives the REAL
 * overlay-scroll + conversation-swipe surfaces (perf-gate-fixture.tsx) and feeds
 * REAL PerformanceObserver / requestAnimationFrame entries into the SAME shared,
 * unit-tested detectors the dev HUD uses:
 *
 *   - frame-budget.ts — summarizeFrameSamples + shouldReportFrameBudget over raw
 *     inter-frame rAF deltas + longtask counts, collected per gesture window via
 *     the FRAME_SAMPLER_INIT start()/read()/stop() controls (each window isolated).
 *   - layout-stability.ts — summarizeStability over raw `layout-shift` entries
 *     (collected by LAYOUT_SHIFT_OBSERVER_INIT) across the whole session.
 *
 * HARD-FAILS (process.exit(1)) when a per-gesture window breaches the frame
 * thresholds (sample-count floor, p95 frame time, dropped-frame %, long tasks)
 * or the session's non-intentional CLS exceeds the Web-Vitals "good" budget.
 * Mirrors run-home-screen-e2e.mjs's CLS gate, extended to frame budget.
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

// ── Hard-gate thresholds. Looser than the HUD's sensitive defaults so they sit
// above headless-chromium's no-GPU rAF noise floor, but still fail real jank. ──
const FRAME_BUDGET = { targetFps: 60 };
const FRAME_GATE = {
  // p95 frame may exceed the 16.67ms 60fps budget by up to 2× (33.3ms) before we
  // flag — p95 must still hold ≥30fps. (HUD reports at 1.25×.)
  p95BudgetFactor: 2,
  // ≥20% of frames over budget = unambiguous jank. (HUD reports at 10%.)
  droppedFrameRatio: 0.2,
  // Long tasks are asserted explicitly below, not via the budget detector.
  reportOnLongTask: false,
};
const MIN_SAMPLES = 30; // a real gesture must animate ≥30 frames; else regression
const MAX_LONG_TASKS = 2; // tolerate ≤2 incidental; ≥3 main-thread stalls = fail
const MAX_CLS = 0.1; // Web-Vitals "good" (same as run-home-screen-e2e)

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Stub node builtins (dead in the browser) so the fixture bundle builds. The
// fixture only imports React + the pure usePullGesture hook, so nothing here is
// actually reached at runtime — the page-error guard below would catch it if so.
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
  plugins: [stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>perf gate e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
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

/** Dispatch a real touch-pointer drag from an element's centre by (dx, dy). */
async function drag(p, testid, dx, dy, { steps = 12 } = {}) {
  const box = await p.getByTestId(testid).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.evaluate(
    ({ cx, cy }) => {
      const el = document.elementFromPoint(cx, cy);
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
    { cx, cy },
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
      `long=${s.longTasks}`,
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
  assert(
    s.longTasks <= MAX_LONG_TASKS,
    `[${label}] no main-thread stall (longTasks ${s.longTasks} ≤ ${MAX_LONG_TASKS})`,
  );
  return s;
}

const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 600, height: 820 },
  hasTouch: true,
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 600, height: 820 } },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));

// Inject BOTH collectors before any paint, so every frame + shift is captured.
await page.addInitScript(FRAME_SAMPLER_INIT);
await page.addInitScript(LAYOUT_SHIFT_OBSERVER_INIT);
await page.goto(url);
await page.waitForSelector('[data-testid="perf-gate-root"]');
await page.waitForTimeout(300);
await snap(page, "perf-gate-rest");

// ── 1. Overlay scroll — wheel + pointer-drag flings over the real scroller. ────
await gateWindow(page, "overlay-scroll", async () => {
  const box = await page.getByTestId("perf-overlay-scroll").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(120);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(120);
  }
});
await snap(page, "after-scroll");

// ── 2. Conversation swipe — the REAL usePullGesture, left/right several times. ─
await gateWindow(page, "conversation-swipe", async () => {
  for (let i = 0; i < 4; i += 1) {
    await drag(page, "conversation-swiper", -180, 0, { steps: 12 });
    await page.waitForTimeout(200);
    await drag(page, "conversation-swiper", 180, 0, { steps: 12 });
    await page.waitForTimeout(200);
  }
});
await snap(page, "after-swipe");

// ── 3. Layout stability across the whole session (mirror run-home-screen-e2e). ─
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

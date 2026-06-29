/**
 * Conversation-overlay PERF GATE (#9954) — headless-Chromium harness that drives
 * the REAL ContinuousChatOverlay under thread-scroll + repeated conversation
 * swipes, harvests REAL PerformanceObserver + requestAnimationFrame entries from
 * the page, feeds them into the SAME shared detectors the dev HUD uses
 * (frame-budget.ts summarizeFrameSamples + shouldReportFrameBudget, and
 * layout-stability.ts summarizeStability over real `layout-shift` entries), and
 * HARD-FAILS on:
 *   - dropped-frame ratio over threshold,
 *   - p95 frame time over the budget factor,
 *   - non-intentional cumulative layout shift (CLS) over budget.
 *
 * The detectors are pure + unit-tested; this is the live-surface driver that
 * feeds them real numbers so a jank/CLS regression fails a build instead of
 * only blinking in the dev PerfOverlay.
 *
 * Run: bun run --cwd packages/ui test:chat-perf-gate
 * Exits non-zero on any breached threshold or page error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
} from "../../../testing/layout-stability.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-perf-gate");
await mkdir(outDir, { recursive: true });

// ── Thresholds. Deliberately not razor-thin so a single unavoidable frame in a
// CI VM doesn't redden the lane, but tight enough that a real regression
// (sustained jank, a content reflow during swipe) trips. ───────────────────────
const FRAME_BUDGET_OPTIONS = {
  // p95 frame may exceed the 16.67ms 60fps budget by up to 2× (33ms) before we
  // flag — CI VMs are noisier than a device, but sustained 30fps still fails.
  p95BudgetFactor: 2,
  // Up to 25% of frames over budget is tolerated; beyond that it's visible jank.
  droppedFrameRatio: 0.25,
  // Long tasks are noisy on a shared CI runner; don't fail solely on them here.
  reportOnLongTask: false,
};
const STABILITY_BUDGET = { maxCls: 0.1, flashMinDelta: 0.2 };

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild bundle (mirror run-conversation-swipe-e2e stubs). ──────────────────
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
  entryPoints: [join(here, "conversation-swipe-fixture.tsx")],
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
// Install the shared layout-shift observer + a rAF frame sampler BEFORE the app
// boots, so every shift + frame during the run is captured into window globals.
const observerInit = `
${LAYOUT_SHIFT_OBSERVER_INIT}
(() => {
  const w = window;
  if (w.__ELIZA_PERF_FRAMES__) return;
  w.__ELIZA_PERF_FRAMES__ = [];
  let last = null;
  const tick = (now) => {
    if (last !== null) w.__ELIZA_PERF_FRAMES__.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat perf gate</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#16121c}</style>
<script>${observerInit}</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-perf-gate.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

/** Real touch-pointer drag from an element's centre by (dx, dy). */
async function drag(p, selector, dx, dy, { steps = 14, stepMs = 16 } = {}) {
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

const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 820 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('[data-testid="chat-sheet"]');
await page.waitForTimeout(600);

// Open the sheet to FULL so the thread (scroll + swipe surface) is mounted.
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
await page.waitForTimeout(450);
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
await page.waitForTimeout(450);
check(
  (await page.locator("#continuous-thread").count()) === 1,
  "thread (perf surface) mounted",
);

// Reset the sampled windows AFTER the (one-time) open animation so the measured
// window is the steady-state interaction, not the mount.
await page.evaluate(() => {
  window.__ELIZA_PERF_FRAMES__ = [];
  window.__ELIZA_LAYOUT_SHIFTS__ = [];
});

// ── Drive a sustained interaction: alternate scroll + swipe several times. ─────
for (let i = 0; i < 6; i += 1) {
  // Vertical scroll the thread (mostly-vertical drag → axis-locks to scroll).
  await drag(page, "#continuous-thread", 6, -160, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(120);
  await drag(page, "#continuous-thread", 6, 160, { steps: 12, stepMs: 16 });
  await page.waitForTimeout(120);
  // Swipe forward then back between conversations.
  await drag(page, "#continuous-thread", -180, 4, { steps: 14, stepMs: 16 });
  await page.waitForTimeout(160);
  await drag(page, "#continuous-thread", 180, 4, { steps: 14, stepMs: 16 });
  await page.waitForTimeout(160);
}

// ── Harvest the REAL entries and feed the shared detectors. ────────────────────
const { frames, shifts } = await page.evaluate(() => ({
  frames: window.__ELIZA_PERF_FRAMES__ ?? [],
  shifts: window.__ELIZA_LAYOUT_SHIFTS__ ?? [],
}));

const frameSummary = summarizeFrameSamples(frames);
const stability = summarizeStability(shifts, [], STABILITY_BUDGET);

console.log(
  `\nframes: ${frameSummary.sampleCount} | fps ${frameSummary.fps.toFixed(1)} | ` +
    `p95 ${frameSummary.p95FrameMs.toFixed(1)}ms | worst ${frameSummary.worstFrameMs.toFixed(1)}ms | ` +
    `dropped ${frameSummary.droppedFrames}/${frameSummary.sampleCount}`,
);
console.log(
  `layout: cls ${stability.cls.toFixed(4)} | non-intentional shifts ${stability.shiftCount}\n`,
);
await page.screenshot({ path: join(outDir, "perf-gate-final.png") });

check(
  frameSummary.sampleCount > 20,
  `captured a meaningful frame window (${frameSummary.sampleCount} frames)`,
);
const droppedRatio = frameSummary.sampleCount
  ? frameSummary.droppedFrames / frameSummary.sampleCount
  : 1;
check(
  droppedRatio <= FRAME_BUDGET_OPTIONS.droppedFrameRatio,
  `dropped-frame ratio ${(droppedRatio * 100).toFixed(1)}% within ${(FRAME_BUDGET_OPTIONS.droppedFrameRatio * 100).toFixed(0)}%`,
);
check(
  frameSummary.p95FrameMs <=
    frameSummary.budgetMs * FRAME_BUDGET_OPTIONS.p95BudgetFactor,
  `p95 frame ${frameSummary.p95FrameMs.toFixed(1)}ms within ${(frameSummary.budgetMs * FRAME_BUDGET_OPTIONS.p95BudgetFactor).toFixed(1)}ms`,
);
// shouldReportFrameBudget is the same policy the HUD applies; assert the window
// does NOT trip it (under our CI-tuned thresholds).
check(
  !shouldReportFrameBudget(frameSummary, FRAME_BUDGET_OPTIONS),
  "frame-budget detector does not flag the interaction window",
);
check(
  stability.cls <= STABILITY_BUDGET.maxCls,
  `non-intentional CLS ${stability.cls.toFixed(4)} within ${STABILITY_BUDGET.maxCls}`,
);
check(!stability.flagged, "layout-stability detector does not flag the window");
check(errors.length === 0, `no page errors (saw ${errors.length})`);
if (errors.length) console.log(errors.join("\n"));

await context.close();
await browser.close();

console.log(failures === 0 ? "\nPERF GATE PASSED" : `\n${failures} GATE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

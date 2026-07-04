/**
 * Conversation-overlay PERF GATE (#9954): drives the REAL ContinuousChatOverlay
 * under thread-scroll + repeated conversation swipes, harvests REAL
 * PerformanceObserver + requestAnimationFrame entries, and feeds them into the
 * SAME shared detectors the dev HUD uses (frame-budget summarizeFrameSamples +
 * shouldReportFrameBudget, layout-stability summarizeStability). HARD-FAILS on a
 * dropped-frame ratio, p95 frame time, or non-intentional CLS over budget.
 *
 * The detectors are pure + unit-tested; this is the live-surface driver that
 * feeds them real numbers so jank/CLS regressions fail a build. Mechanics come
 * from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:chat-perf-gate
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
  stubPromptSuggestions,
} from "../../../testing/e2e-runner/index.ts";
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

// Deliberately not razor-thin so an unavoidable CI-VM frame doesn't redden the
// lane, but tight enough that real jank (sustained slowdown, a swipe reflow) trips.
const FRAME_BUDGET_OPTIONS = {
  p95BudgetFactor: 2, // p95 may reach 2× the 60fps budget (33ms) before flagging
  droppedFrameRatio: 0.25, // >25% frames over budget = visible jank
  reportOnLongTask: false, // long tasks are noisy on shared CI runners
};
const STABILITY_BUDGET = { maxCls: 0.1, flashMinDelta: 0.2 };

// Install the shared layout-shift observer + a rAF frame sampler BEFORE the app
// boots, so every shift + frame during the run is captured into window globals.
const OBSERVER_INIT = `
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

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "conversation-swipe-fixture.tsx"),
      outDir,
      htmlName: "chat-perf-gate.html",
      title: "chat perf gate",
      plugins: [
        stubPromptSuggestions(join(here, "usePromptSuggestions.stub.ts")),
        stubElizaCore(),
        stubNodeBuiltins(),
      ],
      processShim: true,
      background: "#16121c",
      headHtml: `<script>${OBSERVER_INIT}</script>`,
    },
    context: {
      viewport: { width: 420, height: 820 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    },
    record: { name: "chat-perf-gate.webm" },
    waitFor: '[data-testid="chat-sheet"]',
    passMessage: "\nPERF GATE PASSED",
    failMessage: "\nGATE CHECK(S) FAILED",
  },
  async ({ page, gate, errors }) => {
    const check = gate.assert;
    await page.waitForTimeout(600);

    // Open the sheet to FULL so the thread (scroll + swipe surface) is mounted.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
    await page.waitForTimeout(450);
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
    await page.waitForTimeout(450);
    check((await page.locator("#continuous-thread").count()) === 1, "thread (perf surface) mounted");

    // Reset the sampled windows AFTER the one-time open animation so the measured
    // window is the steady-state interaction, not the mount.
    await page.evaluate(() => {
      window.__ELIZA_PERF_FRAMES__ = [];
      window.__ELIZA_LAYOUT_SHIFTS__ = [];
    });

    // Drive a sustained interaction: alternate scroll + swipe several times.
    for (let i = 0; i < 6; i += 1) {
      await drag(page, "#continuous-thread", 6, -160, { steps: 12, stepMs: 16 });
      await page.waitForTimeout(120);
      await drag(page, "#continuous-thread", 6, 160, { steps: 12, stepMs: 16 });
      await page.waitForTimeout(120);
      await drag(page, "#continuous-thread", -180, 4, { steps: 14, stepMs: 16 });
      await page.waitForTimeout(160);
      await drag(page, "#continuous-thread", 180, 4, { steps: 14, stepMs: 16 });
      await page.waitForTimeout(160);
    }

    // Harvest the REAL entries and feed the shared detectors.
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
      frameSummary.p95FrameMs <= frameSummary.budgetMs * FRAME_BUDGET_OPTIONS.p95BudgetFactor,
      `p95 frame ${frameSummary.p95FrameMs.toFixed(1)}ms within ${(frameSummary.budgetMs * FRAME_BUDGET_OPTIONS.p95BudgetFactor).toFixed(1)}ms`,
    );
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
  },
);

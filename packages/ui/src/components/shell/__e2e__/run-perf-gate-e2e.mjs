/**
 * Perf-gate e2e (#9954, Item 5): drives the REAL ContinuousChatOverlay over a
 * long overflowing thread + multi-conversation list and feeds REAL rAF /
 * PerformanceObserver entries into the SAME shared, unit-tested detectors the dev
 * HUD uses — frame-budget.ts (per-gesture windows via FRAME_SAMPLER_INIT) and
 * layout-stability.ts (steady-state CLS via LAYOUT_SHIFT_OBSERVER_INIT). It opens
 * the sheet to FULL, then drives real thread-scroll then conversation-swipe over
 * `#continuous-thread` and HARD-FAILS on breached frame thresholds or CLS.
 *
 * Thresholds are calibrated to the measured develop baseline (see FRAME_GATE) and
 * expressed as a factor over the 60fps budget so a 60Hz CI runner and a 120Hz dev
 * box both pass. Mechanics come from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:perf-gate-e2e
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

// Hard-gate thresholds, CALIBRATED to the measured develop baseline of the REAL
// overlay in this headless-Chromium harness (see run-perf-gate history for the
// per-window numbers). Expressed as a FACTOR over the 60fps budget (16.67ms) so a
// 60Hz CI runner and a 120Hz dev box both pass; mirrors run-chat-perf-gate.
const FRAME_BUDGET = { targetFps: 60 };
const FRAME_GATE = {
  // p95 may reach 2× the 16.67ms budget (33.3ms / ≥30fps) before we flag.
  p95BudgetFactor: 2,
  // ≥20% of frames over budget = unambiguous jank (baseline tops out ~1%).
  droppedFrameRatio: 0.2,
  // Long tasks are reported per-window but not a hard-fail: a swipe-commit
  // re-renders the whole thread, legitimately spiking 0–3 long tasks without
  // breaching the frame budget. The named gate criteria are dropped-%, p95, CLS.
  reportOnLongTask: false,
};
const MIN_SAMPLES = 30; // a real gesture animates ≥30 frames; fewer = regression
const MAX_CLS = 0.1; // Web-Vitals "good"; baseline session CLS is 0.0000

/**
 * Dispatch a real touch-pointer drag from a CSS-selected element's centre by
 * (dx, dy). The per-step waits let the in-page rAF sampler tick across the drag,
 * so each gesture window is a non-empty sample set.
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

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "perf-gate-fixture.tsx"),
      outDir,
      htmlName: "perf-gate.html",
      title: "perf gate e2e",
      plugins: [
        stubPromptSuggestions(join(here, "usePromptSuggestions.stub.ts")),
        stubElizaCore(),
        stubNodeBuiltins(),
      ],
      processShim: true,
      background: "#16121c",
    },
    context: {
      // Mobile viewport so the overlay renders its sheet (the production surface
      // the gate protects).
      viewport: { width: 420, height: 820 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    },
    record: { name: "perf-gate.webm" },
    initScripts: [FRAME_SAMPLER_INIT, LAYOUT_SHIFT_OBSERVER_INIT],
    waitFor: '[data-testid="chat-sheet"]',
    passMessage: "\nPERF GATE PASSED",
  },
  async ({ page, gate, snap, errors }) => {
    const { assert } = gate;

    /**
     * Sample REAL frames over one gesture window: start the in-page sampler, run
     * the driver, read the raw deltas + longtask count, feed the shared pure
     * summarizer, and HARD-FAIL on the frame thresholds.
     */
    async function gateWindow(label, drive) {
      await page.evaluate(() => window.__ELIZA_FRAME.start());
      await drive();
      const { deltas, longTasks } = await page.evaluate(() => window.__ELIZA_FRAME.read());
      await page.evaluate(() => window.__ELIZA_FRAME.stop());

      const s = summarizeFrameSamples(deltas, longTasks, FRAME_BUDGET);
      const droppedPct = (100 * s.droppedFrames) / Math.max(1, s.sampleCount);
      console.log(
        `  [${label}] fps=${s.fps.toFixed(1)} p95=${s.p95FrameMs.toFixed(1)}ms ` +
          `worst=${s.worstFrameMs.toFixed(1)}ms dropped=${s.droppedFrames}/${s.sampleCount} ` +
          `(${droppedPct.toFixed(0)}%) long=${s.longTasks}`,
      );
      assert(s.sampleCount >= MIN_SAMPLES, `[${label}] captured ≥${MIN_SAMPLES} frames (got ${s.sampleCount})`);
      assert(
        !shouldReportFrameBudget(s, FRAME_GATE),
        `[${label}] within frame budget (p95 ${s.p95FrameMs.toFixed(1)}ms ≤ ` +
          `${(s.budgetMs * FRAME_GATE.p95BudgetFactor).toFixed(1)}ms, dropped ` +
          `${droppedPct.toFixed(0)}% < ${(FRAME_GATE.droppedFrameRatio * 100).toFixed(0)}%)`,
      );
      return s;
    }

    await page.waitForTimeout(600);

    // Open the sheet to FULL so `#continuous-thread` (the real scroll + swipe
    // surface) is mounted + bound. Two pull-ups: collapsed → half → full.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
    await page.waitForTimeout(450);
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
    await page.waitForTimeout(450);
    assert(
      (await page.locator("#continuous-thread").count()) === 1,
      "thread (scroll + swipe surface) is mounted with the sheet open",
    );
    assert(
      await page.locator("#continuous-thread").evaluate((el) => el.scrollHeight > el.clientHeight + 8),
      "thread actually overflows (real scroll surface, not a stub)",
    );
    await snap(page, "perf-gate-open");

    // Reset the layout-shift buffer AFTER the one-time sheet-open animation, so
    // the CLS gate measures the steady-state scroll+swipe interaction.
    await page.evaluate(() => {
      window.__ELIZA_LAYOUT_SHIFTS__ = [];
    });

    // 1. REAL overlay thread-scroll — vertical pointer flings over the overflowing
    // #continuous-thread (a mostly-vertical drag axis-locks to native scroll).
    await gateWindow("overlay-scroll", async () => {
      for (let i = 0; i < 6; i += 1) {
        await drag(page, "#continuous-thread", 6, -200, { steps: 12, stepMs: 16 });
        await page.waitForTimeout(120);
        await drag(page, "#continuous-thread", 6, 200, { steps: 12, stepMs: 16 });
        await page.waitForTimeout(120);
      }
    });
    await snap(page, "after-scroll");

    // 2. REAL conversation-swipe — horizontal pointer swipes over the SAME
    // #continuous-thread (the overlay's production conversationSwipe wiring).
    await gateWindow("conversation-swipe", async () => {
      for (let i = 0; i < 4; i += 1) {
        await drag(page, "#continuous-thread", -180, 4, { steps: 14, stepMs: 16 });
        await page.waitForTimeout(200);
        await drag(page, "#continuous-thread", 180, 4, { steps: 14, stepMs: 16 });
        await page.waitForTimeout(200);
      }
    });
    await snap(page, "after-swipe");

    // 3. Layout stability across the steady-state interaction.
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
  },
);

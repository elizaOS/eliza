/**
 * Perf-gate e2e (#9954 Item 5, retargeted for #13531): drives the REAL
 * ContinuousChatOverlay over a long overflowing thread and feeds REAL rAF /
 * PerformanceObserver entries into the SAME shared, unit-tested detectors the dev
 * HUD uses — frame-budget.ts (per-gesture windows via FRAME_SAMPLER_INIT) and
 * layout-stability.ts (steady-state CLS via LAYOUT_SHIFT_OBSERVER_INIT). It opens
 * the sheet to FULL, then drives the two surviving high-cost gestures of the
 * single-infinite-thread redesign — thread-scroll and pull-to-maximize →
 * top-pull-restore — over `#continuous-thread` and the sheet grabber / restore
 * strip, and HARD-FAILS on breached frame thresholds or CLS. The maximize +
 * restore transitions re-render + re-layout the whole panel, so they are exactly
 * the layout-stability regressions this gate protects against.
 *
 * Thresholds are calibrated to the measured develop baseline (see FRAME_GATE) and
 * expressed as a factor over the 60fps budget so a 60Hz CI runner and a 120Hz dev
 * box both pass. Mechanics come from the shared e2e-runner.
 *
 * The steady-state CLS is 0.0000 because every maximize/restore shift is inside
 * the overlay's `data-eliza-layout-shift-intent="transient"` marker. A 0.0000
 * that big an exclusion could hide a regression, so before trusting it the gate
 * proves its detector has TEETH: it injects a REAL non-transient shift on the
 * pilled fixture (measureInjectedNonTransientShift) and asserts the same observer
 * + detector flag it. This is the exact class the removed horizontal
 * conversation-swipe once produced here — CLS 0.80 (#14333) — before #13531
 * deleted swipe and #13826 retargeted the gate onto scroll + maximize/restore.
 *
 * Run: bun run --cwd packages/ui test:perf-gate-e2e
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
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
import { measureInjectedNonTransientShift } from "../../../testing/layout-shift-teeth.ts";

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
  // Long tasks are reported per-window but not a hard-fail: a maximize/restore
  // commit re-renders the whole thread, legitimately spiking 0–3 long tasks
  // without breaching the frame budget. The named gate criteria are dropped-%,
  // p95, CLS.
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

const isMaximized = (p) =>
  p
    .getByTestId("chat-sheet")
    .evaluate((el) => el.getAttribute("data-maximized") === "true");

// Over-pull the grabber UP past the 80%-viewport maximize threshold (a large
// finger travel pushes the peak raw pull past max(0.8·viewportH, FULL)+56px into
// the rubber-band zone that commits full-bleed), then WAIT for the sheet to
// actually report data-maximized=true so the follow-on restore drive can find the
// top strip. Returns whether it committed.
async function pullToMaximize(p) {
  await drag(p, '[data-testid="chat-sheet-grabber"]', 0, -640, { steps: 18, stepMs: 16 });
  try {
    await p.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="chat-sheet"]')
          ?.getAttribute("data-maximized") === "true",
      { timeout: 2500 },
    );
  } catch {
    // Let the caller assert; a missed commit surfaces as a failed gate check
    // rather than a swallowed timeout.
  }
  return isMaximized(p);
}

// Pull DOWN from the top-20% restore strip (only present while full-bleed) to
// un-maximize, then WAIT for data-maximized to clear. Returns whether it
// restored; a no-op (strip absent) resolves false so the caller can assert.
async function pullToRestore(p) {
  const zone = p.locator('[data-testid="chat-maximize-restore-zone"]');
  if ((await zone.count()) === 0) return false;
  await drag(p, '[data-testid="chat-maximize-restore-zone"]', 0, 320, { steps: 16, stepMs: 16 });
  try {
    await p.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="chat-sheet"]')
          ?.getAttribute("data-maximized") !== "true",
      { timeout: 2500 },
    );
  } catch {
    // Surfaced by the caller's assertion, not swallowed.
  }
  return !(await isMaximized(p));
}

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "perf-gate-fixture.tsx"),
      outDir,
      htmlName: "perf-gate.html",
      title: "perf gate e2e",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
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

    // GUARD (#14333) — prove the gate has TEETH before trusting its green. A CLS
    // of 0.0000 later can be a true "every shift was intentional" pass OR a silent
    // regression: a dead PerformanceObserver, or an over-broad
    // `data-eliza-layout-shift-intent="transient"` marker swallowing a genuine
    // shift. Injecting REAL non-transient shifts on the still-pilled fixture (whole
    // surface visible, so impact is large and the margin over 0.1 is comfortable)
    // and asserting the SAME observer + detector flag them proves a re-introduced
    // real shift — the exact class the removed horizontal conversation-swipe once
    // produced here (CLS 0.80) — would red the gate, not hide behind the exclusion.
    const teeth = await measureInjectedNonTransientShift(page, {
      rootSelector: '[data-testid="perf-gate-root"]',
      maxCls: MAX_CLS,
    });
    console.log(
      `  [teeth] injected non-transient cls=${teeth.cls.toFixed(4)} shifts=${teeth.shiftCount} flagged=${teeth.flagged}`,
    );
    assert(
      teeth.flagged && teeth.cls > MAX_CLS,
      `the gate catches a REAL non-transient shift (injected CLS ${teeth.cls.toFixed(4)} > ${MAX_CLS}) — the transient-intent exclusion cannot silently swallow a regression`,
    );

    // Open the sheet to FULL so `#continuous-thread` (the real scroll surface) is
    // mounted + bound. Two pull-ups: collapsed → half → full.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
    await page.waitForTimeout(450);
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
    await page.waitForTimeout(450);
    assert(
      (await page.locator("#continuous-thread").count()) === 1,
      "thread (scroll surface) is mounted with the sheet open",
    );
    assert(
      await page.locator("#continuous-thread").evaluate((el) => el.scrollHeight > el.clientHeight + 8),
      "thread actually overflows (real scroll surface, not a stub)",
    );
    assert(!(await isMaximized(page)), "sheet opens to the INSET full detent (not yet maximized)");
    await snap(page, "perf-gate-open");

    // Reset the layout-shift buffer AFTER the one-time sheet-open animation, so
    // the CLS gate measures the steady-state scroll + maximize/restore
    // interaction.
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

    // 2. REAL pull-to-maximize → top-pull-restore (#13531) — an over-pull UP on
    // the grabber past the 80%-viewport threshold commits the sheet to
    // edge-to-edge full-bleed, and a downward pull from the top-20% strip restores
    // it. Both re-render + re-layout the whole panel, so this window gates those
    // transitions' frame budget. Repeat maximize↔restore so the window captures
    // ≥MIN_SAMPLES of a real re-layout, not a single spike; assert EACH commit so
    // a gate that never entered the state it measures cannot pass vacuously.
    let maximizeCommits = 0;
    let restoreCommits = 0;
    await gateWindow("maximize-restore", async () => {
      for (let i = 0; i < 4; i += 1) {
        if (await pullToMaximize(page)) maximizeCommits += 1;
        if (await pullToRestore(page)) restoreCommits += 1;
      }
    });
    await snap(page, "after-maximize-restore");
    assert(
      maximizeCommits >= 1,
      `an over-pull past the 80% threshold committed full-bleed at least once (${maximizeCommits}/4)`,
    );
    assert(
      restoreCommits >= 1,
      `a top-20% pull-down restored the inset overlay at least once (${restoreCommits}/4)`,
    );

    // Leave the sheet in a known-restored state + capture both end states.
    const finalMaximized = await pullToMaximize(page);
    assert(finalMaximized, "final over-pull commits full-bleed (data-maximized=true)");
    await snap(page, "maximized");
    const finalRestored = await pullToRestore(page);
    assert(finalRestored, "final top-20% pull-down restores the inset overlay (data-maximized cleared)");
    await snap(page, "restored");

    // 3. Layout stability across the steady-state interaction.
    const shifts = await page.evaluate(() => window.__ELIZA_LAYOUT_SHIFTS__ ?? []);
    const stability = summarizeStability(shifts, [], { maxCls: MAX_CLS });
    console.log(
      `  [layout] cls=${stability.cls.toFixed(4)} non-intentional-shifts=${stability.shiftCount} flashed=${stability.flashed}`,
    );
    assert(
      !stability.flagged,
      `layout stable during scroll + maximize/restore (CLS ${stability.cls.toFixed(4)} ≤ ${MAX_CLS}, ${stability.shiftCount} shifts)`,
    );

    // The maximize/restore transitions move the whole panel, so the observer MUST
    // have recorded real layout-shift entries — a CLS of 0 with ZERO raw entries
    // is a dead observer, not a stable surface, and every future reading would be
    // a vacuous pass. (The teeth-check above already proved the detector flags a
    // real shift; this proves the observer was live for THIS interaction.)
    assert(
      shifts.length > 0,
      `observer captured real layout-shift entries during the interaction (${shifts.length}) — CLS=0 is a true all-intentional pass, not a dead observer`,
    );

    assert(errors.length === 0, `no page errors (saw ${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  },
);

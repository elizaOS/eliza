/**
 * Conversation-overlay PERF GATE (#9954, retargeted for #13531): drives the REAL
 * ContinuousChatOverlay under thread-scroll + repeated pull-to-maximize /
 * top-pull-restore, harvests REAL PerformanceObserver + requestAnimationFrame
 * entries, and feeds them into the SAME shared detectors the dev HUD uses
 * (frame-budget summarizeFrameSamples + shouldReportFrameBudget, layout-stability
 * summarizeStability). HARD-FAILS on a dropped-frame ratio, p95 frame time, or
 * non-intentional CLS over budget.
 *
 * The single-infinite-thread redesign (#13531) removed chat-to-chat swipe; the
 * surviving high-cost gestures are the overflowing thread's scroll and the
 * maximize↔restore panel re-layout, so those are what this gate drives.
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
} from "../../../testing/e2e-runner/index.ts";
import {
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
} from "../../../testing/layout-stability.ts";
import { measureInjectedNonTransientShift } from "../../../testing/layout-shift-teeth.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-perf-gate");

// Deliberately not razor-thin so an unavoidable CI-VM frame doesn't redden the
// lane, but tight enough that real jank (sustained slowdown, a maximize reflow)
// trips. In a vsync-locked headless browser every frame delta quantizes to a
// multiple of the 16.67ms budget (16.67, 33.33, 50…), so a SINGLE dropped frame
// lands the p95 at ~33.4ms — right on a 2× threshold, which then flaps on
// sub-millisecond jitter (the streaming window re-renders once per frame, so >5%
// of its frames double and its p95 is reliably that one dropped frame). The p95
// factor therefore sits in the empty gap between one dropped frame (33.3ms,
// tolerated as the CI floor) and two (50ms, genuine sustained jank); the
// dropped-frame RATIO below is the primary jank signal and is left untouched.
const FRAME_BUDGET_OPTIONS = {
  p95BudgetFactor: 2.5, // flag p95 ≥ 2 dropped frames (41.7ms); one (33.3ms) is the CI vsync floor
  droppedFrameRatio: 0.25, // >25% frames over budget = visible jank
  reportOnLongTask: false, // long tasks are noisy on shared CI runners
};
// Streaming intentionally updates once per animation frame, making its dropped
// ratio sensitive to runner contention. Pair each streaming window with an
// immediately preceding zero-token window so the gate measures incremental work.
const FRAME_GATE_STREAMING = {
  p95BudgetFactor: 2.5,
  reportOnLongTask: false,
};
const STREAMING_DROP_DELTA_BUDGET = 0.3;
const STREAMING_DROP_ABSOLUTE_CEILING = 0.7;
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
// No-reflow guard observer: records every non-recent-input layout-shift and
// whether any attributed source lies OUTSIDE the chat overlay subtree
// ([data-testid="chat-sheet"]). Streaming into the open chat must reflow
// nothing but the chat — a shift attributed to a node outside the overlay is a
// cross-subtree reflow (the streaming turn pushed the surrounding page around),
// which is exactly what the memoization + contained scroll surface prevent.
(() => {
  const w = window;
  if (w.__ELIZA_REFLOW_SHIFTS__) return;
  w.__ELIZA_REFLOW_SHIFTS__ = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput === true) continue;
        if (!(entry.value > 0)) continue;
        const sources = Array.isArray(entry.sources) ? entry.sources : [];
        let outsideChat = false;
        for (const source of sources) {
          const node = source && source.node;
          const element =
            node instanceof Element ? node : (node && node.parentElement) || null;
          if (!element) continue;
          if (!element.closest('[data-testid="chat-sheet"]')) {
            outsideChat = true;
            break;
          }
        }
        w.__ELIZA_REFLOW_SHIFTS__.push({ value: entry.value, outsideChat, sourceCount: sources.length });
      }
    });
    obs.observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* layout-shift unsupported — caller treats absence as no reflow */
  }
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
          isPrimary: true,
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
            isPrimary: true,
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
          isPrimary: true,
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

// Over-pull the grabber UP past the 80%-viewport maximize threshold, then WAIT
// for data-maximized=true so the follow-on restore can find the top strip.
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
    // Surfaced by the caller's assertion, not swallowed.
  }
  return isMaximized(p);
}

// Pull DOWN from the top-20% restore strip (present only while full-bleed) to
// un-maximize, then WAIT for data-maximized to clear.
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

// Median of a numeric sample, ignoring non-finite values. The streaming frame
// budget is judged over several independent windows so one load-spiked window (a
// GC pause, a co-tenant CI process stealing the core) cannot redden the lane,
// while a genuine regression — which janks EVERY window — still trips the median.
function medianNumber(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Independent streaming windows sampled for the frame-budget median. Odd so the
// median is a single window's real measurement, not an interpolation.
const STREAM_WINDOWS = 3;

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "perf-gate-fixture.tsx"),
      outDir,
      htmlName: "chat-perf-gate.html",
      title: "chat perf gate",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
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

    // GUARD (#14333) — prove the CLS detector has teeth before trusting its green.
    // CLS 0.0000 below could be a dead observer or an over-broad transient marker
    // swallowing a real shift. Inject REAL non-transient shifts on the pilled
    // fixture and assert the SAME observer + detector flag them.
    const teeth = await measureInjectedNonTransientShift(page, {
      rootSelector: '[data-testid="perf-gate-root"]',
      maxCls: STABILITY_BUDGET.maxCls,
    });
    console.log(`teeth: injected non-transient cls ${teeth.cls.toFixed(4)} flagged ${teeth.flagged}`);
    check(
      teeth.flagged && teeth.cls > STABILITY_BUDGET.maxCls,
      `gate catches a REAL non-transient shift (injected CLS ${teeth.cls.toFixed(4)} > ${STABILITY_BUDGET.maxCls})`,
    );

    // Open the sheet to FULL so the thread (scroll surface) is mounted.
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

    // Drive a sustained interaction: alternate thread-scroll + maximize/restore
    // several times — the two surviving high-cost overlay gestures.
    let maximizeCommits = 0;
    let restoreCommits = 0;
    for (let i = 0; i < 4; i += 1) {
      await drag(page, "#continuous-thread", 6, -160, { steps: 12, stepMs: 16 });
      await page.waitForTimeout(120);
      await drag(page, "#continuous-thread", 6, 160, { steps: 12, stepMs: 16 });
      await page.waitForTimeout(120);
      // Over-pull up to maximize, then pull down from the top-20% strip to restore.
      if (await pullToMaximize(page)) maximizeCommits += 1;
      if (await pullToRestore(page)) restoreCommits += 1;
    }

    // Prove the gate actually entered + left the state it measures (never
    // vacuously green): the loop must have committed full-bleed and restored it.
    check(maximizeCommits >= 1, `over-pull commits full-bleed (${maximizeCommits}/4 committed)`);
    check(restoreCommits >= 1, `top-20% pull-down restores the inset overlay (${restoreCommits}/4 restored)`);

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
    // The maximize/restore transitions move the whole panel, so a CLS of 0 with
    // ZERO raw shift entries is a dead observer, not a stable surface.
    check(
      shifts.length > 0,
      `observer captured real layout-shift entries during the interaction (${shifts.length}) — CLS=0 is not a dead observer`,
    );

    // ── STREAMING FRAME BUDGET ──────────────────────────────────────────────
    // The gestures above cover scroll + maximize/restore; this phase covers the
    // OTHER hot path the memoized inline widgets exist to protect: tokens
    // landing into the OPEN chat. The fixture's tail turn carries a CHOICE
    // widget, so streaming into it is the exact condition where an unmemoized
    // widget would re-render on every token. We drive the fixture's token
    // driver ~one token per animation frame, harvest the SAME real frame
    // samples, and hold them to a frame budget — plus prove the widget stayed
    // mounted (never remounted/torn) across the whole stream.
    const hasStreamDriver = await page.evaluate(
      () => typeof window.__ELIZA_PERF_STREAM__ === "function",
    );
    check(hasStreamDriver, "fixture exposes the streaming token driver");

    // Prime one token so the tail turn's content is non-empty and its inline
    // widget renders, then scroll the thread to the bottom so the widget (on
    // the newest turn) is on screen for the whole streaming window.
    await page.evaluate(() => window.__ELIZA_PERF_STREAM__?.(1));
    await page.evaluate(() => {
      const thread = document.querySelector("#continuous-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    await page.waitForTimeout(200);
    await page
      .locator('[data-choice-id="perf-choice"]')
      .first()
      .waitFor({ state: "attached", timeout: 4000 })
      .catch(() => {
        // Surfaced by the assertion below, not swallowed.
      });

    const widgetBefore = await page
      .locator('[data-choice-id="perf-choice"]')
      .count();
    check(widgetBefore === 1, `CHOICE widget present before streaming (${widgetBefore})`);

    // Drive the streaming stress as SEVERAL independent windows and judge the
    // MEDIAN, mirroring the home-screen rail-swipe gate. A single load-spiked
    // window (a GC pause, a co-tenant CI process stealing the core) must not
    // redden the lane, but a real regression — an unmemoized widget re-rendering
    // on every token — janks EVERY window, so the median still trips. Each window
    // resets the sampled buffers, drives ~120 tokens (a few chars each, one batch
    // per animation frame — a sustained stream, not a burst) entirely in the page
    // so the rAF cadence is real, then harvests the SAME real frame + shift +
    // reflow entries and feeds them to the SAME shared detector.
    const streamWindows = [];
    const reflowAll = [];
    for (let w = 0; w < STREAM_WINDOWS; w += 1) {
      // Interleaving controls for load changes during the run; one early sample
      // cannot represent a later window on a shared runner.
      await page.evaluate(() => {
        window.__ELIZA_PERF_FRAMES__ = [];
      });
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let ticks = 0;
            const pump = () => {
              ticks += 1;
              if (ticks >= 120) {
                resolve(undefined);
                return;
              }
              requestAnimationFrame(pump);
            };
            requestAnimationFrame(pump);
          }),
      );
      await page.waitForTimeout(120);
      const baselineSummary = summarizeFrameSamples(
        await page.evaluate(() => window.__ELIZA_PERF_FRAMES__ ?? []),
      );
      const baselineRatio = baselineSummary.sampleCount
        ? baselineSummary.droppedFrames / baselineSummary.sampleCount
        : 0;
      check(
        baselineSummary.sampleCount > 20,
        `ambient window ${w + 1} captured a meaningful frame window (${baselineSummary.sampleCount} frames)`,
      );
      const streamingDropBudget = Math.min(
        STREAMING_DROP_ABSOLUTE_CEILING,
        baselineRatio + STREAMING_DROP_DELTA_BUDGET,
      );

      await page.evaluate(() => {
        window.__ELIZA_PERF_FRAMES__ = [];
        window.__ELIZA_LAYOUT_SHIFTS__ = [];
        window.__ELIZA_REFLOW_SHIFTS__ = [];
      });
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            let ticks = 0;
            const pump = () => {
              window.__ELIZA_PERF_STREAM__?.(3);
              ticks += 1;
              if (ticks >= 120) {
                resolve(undefined);
                return;
              }
              requestAnimationFrame(pump);
            };
            requestAnimationFrame(pump);
          }),
      );
      await page.waitForTimeout(120);
      const { frames, shifts, reflow } = await page.evaluate(() => ({
        frames: window.__ELIZA_PERF_FRAMES__ ?? [],
        shifts: window.__ELIZA_LAYOUT_SHIFTS__ ?? [],
        reflow: window.__ELIZA_REFLOW_SHIFTS__ ?? [],
      }));
      const summary = summarizeFrameSamples(frames);
      const droppedRatio = summary.sampleCount
        ? summary.droppedFrames / summary.sampleCount
        : 1;
      const flagged = shouldReportFrameBudget(summary, {
        ...FRAME_GATE_STREAMING,
        droppedFrameRatio: streamingDropBudget,
      });
      const stability = summarizeStability(shifts, [], STABILITY_BUDGET);
      streamWindows.push({
        summary,
        baselineRatio,
        droppedRatio,
        droppedDelta: droppedRatio - baselineRatio,
        flagged,
        cls: stability.cls,
      });
      reflowAll.push(...reflow);
      console.log(
        `stream window ${w + 1}/${STREAM_WINDOWS}: ambient ${(baselineRatio * 100).toFixed(1)}% | ` +
          `frames ${summary.sampleCount} | fps ${summary.fps.toFixed(1)} | p95 ${summary.p95FrameMs.toFixed(1)}ms | ` +
          `dropped ${summary.droppedFrames}/${summary.sampleCount} (${(droppedRatio * 100).toFixed(1)}%, ` +
          `delta ${((droppedRatio - baselineRatio) * 100).toFixed(1)}pp) | ` +
          `budget ${(streamingDropBudget * 100).toFixed(1)}% | flagged ${flagged}`,
      );
      // Each window must carry a meaningful sample or the median is noise.
      check(
        summary.sampleCount > 20,
        `streaming window ${w + 1} captured a meaningful frame window (${summary.sampleCount} frames)`,
      );
    }

    const outsideChatShifts = reflowAll.filter((s) => s.outsideChat);
    const budgetMs = streamWindows[0].summary.budgetMs;
    const medianP95 = medianNumber(streamWindows.map((s) => s.summary.p95FrameMs));
    const medianBaselineRatio = medianNumber(streamWindows.map((s) => s.baselineRatio));
    const medianDroppedRatio = medianNumber(streamWindows.map((s) => s.droppedRatio));
    const medianDroppedDelta = medianNumber(streamWindows.map((s) => s.droppedDelta));
    const medianCls = medianNumber(streamWindows.map((s) => s.cls));
    const flaggedCount = streamWindows.filter((s) => s.flagged).length;
    console.log(
      `\nstream median: p95 ${medianP95.toFixed(1)}ms (budget ${(budgetMs * FRAME_GATE_STREAMING.p95BudgetFactor).toFixed(1)}ms) | ` +
        `ambient ${(medianBaselineRatio * 100).toFixed(1)}% | dropped ${(medianDroppedRatio * 100).toFixed(1)}% | ` +
        `delta ${(medianDroppedDelta * 100).toFixed(1)}pp | cls ${medianCls.toFixed(4)} | ` +
        `flagged ${flaggedCount}/${STREAM_WINDOWS} windows | reflow ${reflowAll.length} outside-chat ${outsideChatShifts.length}\n`,
    );

    // The widget must still be mounted exactly once (never remounted/duplicated
    // by the stream) — the memoization guarantee, verified on the live surface.
    const widgetAfter = await page
      .locator('[data-choice-id="perf-choice"]')
      .count();
    check(
      widgetAfter === 1,
      `CHOICE widget survives the full stream, still mounted once (${widgetAfter})`,
    );

    check(
      medianDroppedDelta <= STREAMING_DROP_DELTA_BUDGET,
      `median streaming dropped-frame delta ${(medianDroppedDelta * 100).toFixed(1)}pp within ` +
        `${(STREAMING_DROP_DELTA_BUDGET * 100).toFixed(0)}pp allowance`,
    );
    check(
      medianDroppedRatio <= STREAMING_DROP_ABSOLUTE_CEILING,
      `median streaming dropped-frame ratio ${(medianDroppedRatio * 100).toFixed(1)}% within ` +
        `${(STREAMING_DROP_ABSOLUTE_CEILING * 100).toFixed(0)}% absolute ceiling`,
    );
    check(
      medianP95 <= budgetMs * FRAME_GATE_STREAMING.p95BudgetFactor,
      `median streaming p95 ${medianP95.toFixed(1)}ms within ${(budgetMs * FRAME_GATE_STREAMING.p95BudgetFactor).toFixed(1)}ms`,
    );
    // The SAME shared detector the dev HUD uses must clear the MEDIAN streaming
    // window (≤ half the windows flagged). A regression that janks every window
    // flags them all → fails; a lone load-spiked window does not.
    check(
      flaggedCount <= Math.floor(STREAM_WINDOWS / 2),
      `frame-budget detector does not flag the streaming window (${flaggedCount}/${STREAM_WINDOWS} windows flagged)`,
    );

    // NO-REFLOW GUARD: streaming into the open chat must reflow NOTHING outside
    // the chat overlay subtree. Every layout-shift source during the stream must
    // resolve inside [data-testid="chat-sheet"]; a shift attributed to a node
    // outside it means the growing turn pushed the surrounding page around —
    // exactly the cross-subtree reflow the contained scroll surface + memoized
    // widgets prevent. Zero across ALL windows is the only pass.
    check(
      outsideChatShifts.length === 0,
      `streaming causes ZERO layout shifts outside the chat overlay (saw ${outsideChatShifts.length} of ${reflowAll.length})`,
    );

    check(errors.length === 0, `no page errors (saw ${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  },
);

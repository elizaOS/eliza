/**
 * Divider-drag PERF GATE (perf/divider-drag-fps): drives an identical staged
 * pointer drag on two resize dividers over a byte-identical heavy body — the
 * pre-fix handler pattern (setState + synchronous localStorage per pointermove,
 * inline width → per-event reflow) vs the shipped pattern (rAF-coalesced ref
 * write, one state + storage commit on release) — and reports the REAL
 * PerformanceObserver frame stats plus the render-commit and localStorage-write
 * counts each produced. Feeds the shared frame-budget detector.
 *
 * The gate asserts the fix's mechanical contract in a real browser: the legacy
 * divider writes storage on (nearly) every pointer event and re-renders the
 * heavy body per event, while the shipped divider writes storage exactly ONCE
 * (on release) and never re-renders the body mid-drag — and its measured frame
 * window is at least as smooth as the legacy one.
 *
 * Run: bun run --cwd packages/ui test:divider-drag-perf-gate
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";
import { summarizeFrameSamples } from "../../../hooks/frame-budget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-divider-perf");

// rAF frame sampler installed before the app boots: every painted frame's
// inter-frame delta lands in a window global for the shared detector.
const OBSERVER_INIT = `
(() => {
  const w = window;
  if (w.__FRAMES__) return;
  w.__FRAMES__ = [];
  let last = null;
  const tick = (now) => {
    if (last !== null) w.__FRAMES__.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

/**
 * Staged real pointer drag on a divider handle by `dx` px, `steps` moves paced
 * `stepMs` apart, so the browser paints frames between moves (a synchronous
 * burst would land in one frame and hide the reflow cost).
 */
async function dragHandle(p, testId, dx, { steps = 40, stepMs = 8 } = {}) {
  const box = await p.getByTestId(testId).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx + (dx * i) / steps, cy);
    await p.waitForTimeout(stepMs);
  }
  await p.mouse.up();
  await p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

async function measure(p, testId, dx) {
  await p.evaluate(() => {
    window.__FRAMES__ = [];
  });
  // Full drag sweep: in and back out so the divider actually resizes the heavy
  // body across a wide range.
  await dragHandle(p, testId, dx);
  await dragHandle(p, testId, -dx);
  const frames = await p.evaluate(() => window.__FRAMES__ ?? []);
  return summarizeFrameSamples(frames);
}

const fmt = (s) =>
  `fps ${s.fps.toFixed(1)} | p95 ${s.p95FrameMs.toFixed(1)}ms | worst ${s.worstFrameMs.toFixed(1)}ms | dropped ${s.droppedFrames}/${s.sampleCount}`;

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "divider-drag-perf-fixture.tsx"),
      outDir,
      htmlName: "divider-drag-perf.html",
      title: "divider drag perf gate",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
      processShim: true,
      background: "#08080d",
      headHtml: `<script>${OBSERVER_INIT}</script>`,
    },
    context: { viewport: { width: 1280, height: 900 } },
    record: { name: "divider-drag-perf.webm" },
    waitFor: '[data-testid="divider-perf-root"]',
    passMessage: "\nDIVIDER PERF GATE PASSED",
    failMessage: "\nDIVIDER PERF GATE FAILED",
  },
  async ({ page, gate }) => {
    const check = gate.assert;

    // Reset counters after mount so only the drag windows are measured.
    await page.evaluate(() => {
      window.__DIVIDER_METRICS__ = {
        legacyRenders: 0,
        shippedRenders: 0,
        legacyStorageWrites: 0,
        shippedStorageWrites: 0,
      };
    });

    // Left-drag +200 grows each bar (handle on the left edge); the reverse
    // drag shrinks it back. 40 paced moves each way = ~80 pointer events.
    const legacy = await measure(page, "legacy-handle", 200);
    const shipped = await measure(page, "shipped-handle", 200);

    const metrics = await page.evaluate(() => window.__DIVIDER_METRICS__);

    console.log(`\nlegacy  divider: ${fmt(legacy)}`);
    console.log(`shipped divider: ${fmt(shipped)}`);
    console.log(
      `\nbody re-renders during drag  — legacy ${metrics.legacyRenders} | shipped ${metrics.shippedRenders}`,
    );
    console.log(
      `localStorage writes during 2 drags — legacy ${metrics.legacyStorageWrites} | shipped ${metrics.shippedStorageWrites}\n`,
    );
    await page.screenshot({ path: join(outDir, "divider-perf-final.png") });

    check(
      legacy.sampleCount > 20 && shipped.sampleCount > 20,
      `captured meaningful frame windows (legacy ${legacy.sampleCount}, shipped ${shipped.sampleCount})`,
    );
    // The fix's core contract, proven in a real browser:
    check(
      metrics.shippedStorageWrites === 2,
      `shipped divider persists exactly once per drag (2 drags → ${metrics.shippedStorageWrites} writes)`,
    );
    check(
      metrics.legacyStorageWrites > metrics.shippedStorageWrites * 4,
      `legacy divider persisted on ~every event (${metrics.legacyStorageWrites} writes vs ${metrics.shippedStorageWrites})`,
    );
    check(
      metrics.shippedRenders <= 2,
      `shipped divider re-renders the heavy body only on release, once per drag (2 drags → ${metrics.shippedRenders} renders)`,
    );
    check(
      metrics.legacyRenders > 20,
      `legacy divider re-rendered the heavy body per event (${metrics.legacyRenders})`,
    );
    // Smoothness: the shipped window must be no worse than legacy at p95.
    check(
      shipped.p95FrameMs <= legacy.p95FrameMs + 1,
      `shipped p95 ${shipped.p95FrameMs.toFixed(1)}ms not worse than legacy ${legacy.p95FrameMs.toFixed(1)}ms`,
    );
  },
);

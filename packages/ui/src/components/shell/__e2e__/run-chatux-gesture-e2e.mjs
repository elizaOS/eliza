/**
 * Real-browser gesture e2e + video for the chat-UX TopicGroup (#8928): flick UP
 * on the header collapses it to a pill; flick DOWN on the pill expands it again.
 * Drives real CDP touch and records a continuous .webm.
 *
 * The overlay's own perf-critical gestures (thread-scroll + maximize/restore, the
 * survivors of the single-infinite-thread redesign #13531) are driven against the
 * REAL ContinuousChatOverlay in run-perf-gate-e2e.mjs / run-chat-perf-gate.mjs.
 * Mechanics come from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:chatux-gesture-e2e
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";
import { touchSwipe } from "../../../testing/real-touch-gestures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-chatux");

/** Drive a real touch drag from an element's centre by (dx, dy). */
async function drag(page, testid, dx, dy, { steps = 10, slow = false } = {}) {
  await touchSwipe(page, `[data-testid="${testid}"]`, dx, dy, {
    steps,
    stepDelayMs: slow ? 24 : 0,
  });
}

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "chatux-gesture-fixture.tsx"),
      outDir,
      htmlName: "chatux-gesture.html",
      title: "chatux gesture e2e",
      plugins: [stubNodeBuiltins()],
      background: "#16121c",
    },
    context: {
      viewport: { width: 600, height: 760 },
      deviceScaleFactor: 2,
      hasTouch: true,
    },
    record: { name: "chatux-gestures.webm" },
  },
  async ({ page, gate, snap, errors }) => {
    await page.waitForTimeout(400);

    // 1. TopicGroup: flick UP on the header → collapse.
    await snap(page, "topic-expanded");
    gate.assert(
      await page.getByTestId("topic-group-header").isVisible(),
      "TopicGroup starts EXPANDED (quiet divider header, no chevron button)",
    );
    // Fast (no-wait) upward drag of ~70px = a flick → onPullUp → collapse.
    await drag(page, "topic-group-header", 0, -70, { steps: 8, slow: false });
    await page.waitForTimeout(250);
    gate.assert(
      await page.getByTestId("topic-group-pill").isVisible(),
      "Flick UP collapses the group to a pill (● topic — N messages)",
    );
    await snap(page, "topic-collapsed-after-flick");

    // 2. Flick DOWN on the pill → expand again (gesture, no buttons).
    await drag(page, "topic-group-pill", 0, 90, { steps: 8, slow: false });
    await page.waitForTimeout(250);
    gate.assert(
      await page.getByTestId("topic-group-header").isVisible(),
      "Flick DOWN on the pill expands the group again",
    );
    await snap(page, "topic-expanded-after-flick-down");

    gate.assert(errors.length === 0, `no page errors (saw ${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  },
);

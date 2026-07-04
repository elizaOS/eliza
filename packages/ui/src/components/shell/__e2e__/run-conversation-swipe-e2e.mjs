/**
 * Real-browser conversation-swipe INTERLEAVING e2e + video (#9954). Mounts the
 * REAL ContinuousChatOverlay over a stateful controller whose conversation list +
 * active id mutate (new conversation prepends at index 0; a swipe re-resolves the
 * adjacent chat through the latest state) and drives:
 *
 *   swipe-back → new → swipe-forward → new → forward → swipe-back
 *
 * After each step it asserts the interleaving invariants from the overlay's own
 * data-conversation-id / data-conversation-index DOM (active id in list, rendered
 * index matches, hasPrev/hasNext consistent, new lands at index 0, index-0 swipe
 * is a no-op) and that the swipe-jank telemetry fired during a real gesture.
 * Mechanics come from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:conversation-swipe-e2e
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
  stubPromptSuggestions,
} from "../../../testing/e2e-runner/index.ts";
import { touchSwipe } from "../../../testing/real-touch-gestures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-conversation-swipe");

// Live navigation state read straight off the overlay's DOM attributes — the
// SAME data-conversation-id / data-conversation-index the overlay surfaces in
// production (not a fixture-private signal).
const navState = (page) =>
  page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]');
    const harness = window.__convNav?.state?.() ?? null;
    return {
      domActiveId: sheet?.getAttribute("data-conversation-id") ?? null,
      domIndex: Number(sheet?.getAttribute("data-conversation-index") ?? "NaN"),
      harness,
    };
  });

/**
 * Drive a REAL touch drag from an element's centre by (dx, dy) via CDP
 * Input.dispatchTouchEvent (the shared #10722 helper) — hit-tested,
 * touch-action-aware, implicit-capture path, not a fabricated PointerEvent.
 */
async function drag(page, selector, dx, dy, { steps = 12, slow = false } = {}) {
  await touchSwipe(page, selector, dx, dy, { steps, stepDelayMs: slow ? 20 : 0 });
}

/** Browser-hit-tested drag by screen coordinates (#10715: start outside the
 * chat panel so a full-screen backdrop would swallow a from-element drag). */
async function screenDrag(page, { startX, startY, endX, endY, steps = 12, slow = false }) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const x = startX + ((endX - startX) * i) / steps;
    const y = startY + ((endY - startY) * i) / steps;
    await page.mouse.move(x, y);
    if (slow) await page.waitForTimeout(20);
  }
  await page.mouse.up();
}

// LEFT swipe → next/older conversation (index + 1); RIGHT swipe → prev/newer
// (index - 1). The per-step waits let the swipe-jank rAF sampler tick across the
// drag so the telemetry window is non-empty.
const swipeForward = (page) => drag(page, "#continuous-thread", -180, 4, { steps: 14, slow: true });
const swipeBack = (page) => drag(page, "#continuous-thread", 180, 4, { steps: 14, slow: true });
const newConversation = (page) => page.evaluate(() => window.__convNav?.newConversation?.());

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "conversation-swipe-fixture.tsx"),
      outDir,
      htmlName: "conversation-swipe.html",
      title: "conversation swipe e2e",
      plugins: [
        stubPromptSuggestions(join(here, "usePromptSuggestions.stub.ts")),
        stubElizaCore(),
        stubNodeBuiltins(),
      ],
      processShim: true,
      background: "#16121c",
    },
    context: {
      viewport: { width: 420, height: 820 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    },
    record: { name: "conversation-swipe-interleaving.webm" },
    waitFor: '[data-testid="chat-sheet"]',
  },
  async ({ page, gate, snap, errors }) => {
    const { assert } = gate;

    /** Assert the full interleaving invariant set for the current overlay state. */
    async function assertInvariants(label, { expectIndex } = {}) {
      const { domActiveId, domIndex, harness } = await navState(page);
      assert(!!harness, `[${label}] harness state readable`);
      if (!harness) return;
      const inList = harness.ids.includes(harness.activeId);
      assert(inList, `[${label}] active id (${harness.activeId}) ∈ list`);
      assert(
        domIndex === harness.index && harness.index === harness.ids.indexOf(harness.activeId),
        `[${label}] dom index ${domIndex} == active position ${harness.index}`,
      );
      assert(
        domActiveId === harness.activeId,
        `[${label}] dom active id (${domActiveId}) == ${harness.activeId}`,
      );
      assert(
        harness.hasPrev === harness.index > 0,
        `[${label}] hasPrev (${harness.hasPrev}) consistent with index ${harness.index}`,
      );
      assert(
        harness.hasNext === (harness.index >= 0 && harness.index < harness.ids.length - 1),
        `[${label}] hasNext (${harness.hasNext}) consistent with index ${harness.index}`,
      );
      if (typeof expectIndex === "number") {
        assert(harness.index === expectIndex, `[${label}] index is ${expectIndex} (got ${harness.index})`);
      }
      return harness;
    }

    await page.waitForSelector('[data-testid="home-launcher-surface"]');
    await page.waitForTimeout(600);

    // #10715: first open only to HALF so there is visible launcher/home
    // background above the chat panel. A horizontal drag there must hit the REAL
    // HomeLauncherSurface underneath the visual scrim, not the chat backdrop.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
    await page.waitForTimeout(450);
    assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) === "open",
      "chat sheet opens before background pass-through test",
    );
    assert(
      (await page.getByTestId("home-launcher-surface").getAttribute("data-page")) === "home",
      "background rail starts on Home",
    );
    await screenDrag(page, { startX: 360, startY: 128, endX: 58, endY: 128, steps: 14, slow: true });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="home-launcher-surface"]')?.getAttribute("data-page") ===
        "launcher",
    );
    assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) === "open",
      "background swipe pages the launcher while chat remains open",
    );
    await snap(page, "00-background-swipe-passthrough");

    await page.mouse.click(210, 128);
    await page.waitForTimeout(450);
    assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) === "closed",
      "outside background tap collapses the chat",
    );
    await snap(page, "01-background-tap-collapse");

    // Open the sheet to FULL so the thread (the swipe surface) is mounted + bound.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
    await page.waitForTimeout(450);
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
    await page.waitForTimeout(450);
    assert(
      (await page.locator("#continuous-thread").count()) === 1,
      "thread (swipe surface) is mounted with the sheet open",
    );
    await snap(page, "00-open-newest");

    // Start state: active on the NEWEST (index 0); first swipe-back is a boundary no-op.
    let s = await assertInvariants("start", { expectIndex: 0 });
    assert(s?.index === 0, "START: active on the newest conversation (index 0)");
    assert(s?.hasPrev === false, "START: index-0 has no newer neighbour (hasPrev false)");

    // 1. swipe-back at index 0 → BOUNDARY NO-OP
    await swipeBack(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("swipe-back@0", { expectIndex: 0 });
    assert(s?.index === 0, "STEP1 swipe-back at index 0 is a no-op (still index 0)");
    await snap(page, "01-swipe-back-noop");

    // 2. new conversation → lands at index 0, list grows
    const beforeNewLen = s?.ids.length ?? 0;
    await newConversation(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("after-new", { expectIndex: 0 });
    assert(s?.index === 0, "STEP2 new conversation lands at index 0");
    assert((s?.ids.length ?? 0) === beforeNewLen + 1, "STEP2 the new conversation grew the list by one");
    assert(s?.activeId === "new-0", "STEP2 active id is the new conversation");
    await snap(page, "02-new-conversation-index0");

    // 3. swipe-forward → moves toward the older neighbour (index + 1)
    const beforeFwd = s?.activeId;
    await swipeForward(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("after-forward", { expectIndex: 1 });
    assert(s?.index === 1, "STEP3 swipe-forward moves to index 1 (older neighbour)");
    assert(s?.activeId !== beforeFwd, "STEP3 the active conversation actually changed");
    await snap(page, "03-swipe-forward");

    // 4. new conversation again → back to index 0
    await newConversation(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("after-new-2", { expectIndex: 0 });
    assert(s?.index === 0, "STEP4 second new conversation lands at index 0 again");
    assert(s?.activeId === "new-1", "STEP4 active id is the second new conversation");
    await snap(page, "04-new-conversation-2");

    // 5. swipe-forward → index 1
    await swipeForward(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("forward-2", { expectIndex: 1 });
    assert(s?.index === 1, "STEP5 swipe-forward to index 1");
    await snap(page, "05-swipe-forward-2");

    // 6. swipe-back → back toward the newer neighbour (index 0)
    await swipeBack(page);
    await page.waitForTimeout(250);
    s = await assertInvariants("back-to-0", { expectIndex: 0 });
    assert(s?.index === 0, "STEP6 swipe-back returns to index 0 (newer neighbour)");
    await snap(page, "06-swipe-back");

    // Telemetry: a real swipe gesture must have emitted the jank event (#9954).
    const jankCount = await page.evaluate(() => window.__convNav?.swipeJankEvents?.() ?? 0);
    assert(jankCount > 0, `conversation-swipe-jank telemetry fired during real gestures (saw ${jankCount})`);

    assert(errors.length === 0, `no page errors (saw ${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  },
);

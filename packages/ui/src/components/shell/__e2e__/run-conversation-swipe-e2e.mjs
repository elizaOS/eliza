/**
 * Real-browser conversation-swipe INTERLEAVING e2e + video capture (#9954).
 *
 * Bundles conversation-swipe-fixture.tsx — which mounts the REAL
 * ContinuousChatOverlay over a stateful controller whose conversation list +
 * active id actually mutate (new conversation prepends at index 0; a swipe
 * re-resolves the adjacent chat through the latest state) — and drives the named
 * interleaving with REAL pointer gestures:
 *
 *   swipe-back → new → swipe-forward → new → forward → swipe-back
 *
 * After every step it asserts the interleaving invariants from the overlay's own
 * data-conversation-id / data-conversation-index DOM, NOT just an error count:
 *   - the active id is in the list,
 *   - the rendered index matches the active id's position,
 *   - hasPrev/hasNext are consistent with the index,
 *   - a new conversation lands at index 0,
 *   - a swipe at the index-0 boundary is a no-op.
 * It also asserts the swipe-jank telemetry event fired during a real gesture.
 *
 * Records a continuous .webm of the whole sequence. Mechanics (esbuild stubs,
 * fixture bundling, the Chromium orchestrator + assert gate + snapper + video
 * rename + exit) come from the shared e2e-runner.
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
const navState = (p) =>
  p.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]');
    const harness = window.__convNav?.state?.() ?? null;
    return {
      domActiveId: sheet?.getAttribute("data-conversation-id") ?? null,
      domIndex: Number(sheet?.getAttribute("data-conversation-index") ?? "NaN"),
      harness,
    };
  });

/** Assert the full interleaving invariant set for the current overlay state. */
async function assertInvariants(gate, p, label, { expectIndex } = {}) {
  const { domActiveId, domIndex, harness } = await navState(p);
  gate.assert(!!harness, `[${label}] harness state readable`);
  if (!harness) return;
  const inList = harness.ids.includes(harness.activeId);
  gate.assert(inList, `[${label}] active id (${harness.activeId}) ∈ list`);
  // The overlay's reported index must equal the active id's real position.
  gate.assert(
    domIndex === harness.index &&
      harness.index === harness.ids.indexOf(harness.activeId),
    `[${label}] dom index ${domIndex} == active position ${harness.index}`,
  );
  gate.assert(
    domActiveId === harness.activeId,
    `[${label}] dom active id (${domActiveId}) == ${harness.activeId}`,
  );
  // hasPrev/hasNext must be consistent with the index in a most-recent-first list.
  gate.assert(
    harness.hasPrev === harness.index > 0,
    `[${label}] hasPrev (${harness.hasPrev}) consistent with index ${harness.index}`,
  );
  gate.assert(
    harness.hasNext ===
      (harness.index >= 0 && harness.index < harness.ids.length - 1),
    `[${label}] hasNext (${harness.hasNext}) consistent with index ${harness.index}`,
  );
  if (typeof expectIndex === "number") {
    gate.assert(
      harness.index === expectIndex,
      `[${label}] index is ${expectIndex} (got ${harness.index})`,
    );
  }
  return harness;
}

/**
 * Drive a REAL touch drag from an element's centre by (dx, dy) via CDP
 * Input.dispatchTouchEvent (the shared #10722 helper). This drives the swipe the
 * way a finger does — through hit-testing, `touch-action`, and implicit pointer
 * capture — not a fabricated PointerEvent inside page.evaluate.
 */
async function drag(p, selector, dx, dy, { steps = 12, slow = false } = {}) {
  await touchSwipe(p, selector, dx, dy, {
    steps,
    stepDelayMs: slow ? 20 : 0,
  });
}

/** Browser-hit-tested drag by screen coordinates. Used for #10715: the pointer
 * starts outside the chat panel, so a full-screen backdrop would swallow it. */
async function screenDrag(
  p,
  { startX, startY, endX, endY, steps = 12, slow = false },
) {
  await p.mouse.move(startX, startY);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const x = startX + ((endX - startX) * i) / steps;
    const y = startY + ((endY - startY) * i) / steps;
    await p.mouse.move(x, y);
    if (slow) await p.waitForTimeout(20);
  }
  await p.mouse.up();
}

// LEFT swipe (clientX decreases) → next/older conversation (index + 1). The
// per-step waits let the swipe-jank FrameBudgetSampler's rAF actually tick
// across the drag (a back-to-back synthetic burst can commit before a single
// frame delta lands), so the telemetry window is non-empty.
const swipeForward = (p) =>
  drag(p, "#continuous-thread", -180, 4, { steps: 14, slow: true });
// RIGHT swipe (clientX increases) → prev/newer conversation (index - 1).
const swipeBack = (p) =>
  drag(p, "#continuous-thread", 180, 4, { steps: 14, slow: true });

const newConversation = (p) =>
  p.evaluate(() => window.__convNav?.newConversation?.());

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
    label: "CONVERSATION-SWIPE E2E",
  },
  async ({ page, gate, snap, errors }) => {
    await page.waitForSelector('[data-testid="home-launcher-surface"]');
    await page.waitForTimeout(600);

    // #10715: first open only to HALF so there is visible launcher/home
    // background above the chat panel. A horizontal drag that starts there must
    // hit the REAL HomeLauncherSurface underneath the visual scrim, not the chat
    // backdrop.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, {
      steps: 6,
    });
    await page.waitForTimeout(450);
    gate.assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
        "open",
      "chat sheet opens before background pass-through test",
    );
    gate.assert(
      (await page
        .getByTestId("home-launcher-surface")
        .getAttribute("data-page")) === "home",
      "background rail starts on Home",
    );
    await screenDrag(page, {
      startX: 360,
      startY: 128,
      endX: 58,
      endY: 128,
      steps: 14,
      slow: true,
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="home-launcher-surface"]')
          ?.getAttribute("data-page") === "launcher",
    );
    gate.assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
        "open",
      "background swipe pages the launcher while chat remains open",
    );
    await snap(page, "background-swipe-passthrough");

    await page.mouse.click(210, 128);
    await page.waitForTimeout(450);
    gate.assert(
      (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
        "closed",
      "outside background tap collapses the chat",
    );
    await snap(page, "background-tap-collapse");

    // Open the sheet to FULL so the thread (the swipe surface) is mounted +
    // bound. Two pull-ups from collapsed step collapsed → half → full.
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, {
      steps: 6,
    });
    await page.waitForTimeout(450);
    await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, {
      steps: 6,
    });
    await page.waitForTimeout(450);
    gate.assert(
      (await page.locator("#continuous-thread").count()) === 1,
      "thread (swipe surface) is mounted with the sheet open",
    );
    await snap(page, "open-newest");

    // Start state: active on the NEWEST (index 0). The first "swipe back" toward
    // a newer chat is therefore a boundary no-op.
    let s = await assertInvariants(gate, page, "start", { expectIndex: 0 });
    gate.assert(
      s?.index === 0,
      "START: active on the newest conversation (index 0)",
    );
    gate.assert(
      s?.hasPrev === false,
      "START: index-0 has no newer neighbour (hasPrev false)",
    );

    // ── 1. swipe-back at index 0 → BOUNDARY NO-OP ────────────────────────────
    await swipeBack(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "swipe-back@0", { expectIndex: 0 });
    gate.assert(
      s?.index === 0,
      "STEP1 swipe-back at index 0 is a no-op (still index 0)",
    );
    await snap(page, "swipe-back-noop");

    // ── 2. new conversation → lands at index 0, list grows ───────────────────
    const beforeNewLen = s?.ids.length ?? 0;
    await newConversation(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "after-new", { expectIndex: 0 });
    gate.assert(s?.index === 0, "STEP2 new conversation lands at index 0");
    gate.assert(
      (s?.ids.length ?? 0) === beforeNewLen + 1,
      "STEP2 the new conversation grew the list by one",
    );
    gate.assert(s?.activeId === "new-0", "STEP2 active id is the new conversation");
    await snap(page, "new-conversation-index0");

    // ── 3. swipe-forward → moves toward the older neighbour (index + 1) ──────
    const beforeFwd = s?.activeId;
    await swipeForward(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "after-forward", { expectIndex: 1 });
    gate.assert(
      s?.index === 1,
      "STEP3 swipe-forward moves to index 1 (older neighbour)",
    );
    gate.assert(
      s?.activeId !== beforeFwd,
      "STEP3 the active conversation actually changed",
    );
    await snap(page, "swipe-forward");

    // ── 4. new conversation again → back to index 0 ──────────────────────────
    await newConversation(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "after-new-2", { expectIndex: 0 });
    gate.assert(
      s?.index === 0,
      "STEP4 second new conversation lands at index 0 again",
    );
    gate.assert(
      s?.activeId === "new-1",
      "STEP4 active id is the second new conversation",
    );
    await snap(page, "new-conversation-2");

    // ── 5. swipe-forward → index 1 ───────────────────────────────────────────
    await swipeForward(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "forward-2", { expectIndex: 1 });
    gate.assert(s?.index === 1, "STEP5 swipe-forward to index 1");
    await snap(page, "swipe-forward-2");

    // ── 6. swipe-back → back toward the newer neighbour (index 0) ────────────
    await swipeBack(page);
    await page.waitForTimeout(250);
    s = await assertInvariants(gate, page, "back-to-0", { expectIndex: 0 });
    gate.assert(
      s?.index === 0,
      "STEP6 swipe-back returns to index 0 (newer neighbour)",
    );
    await snap(page, "swipe-back");

    // ── Telemetry: a real swipe gesture must have emitted the jank event (#9954)
    const jankCount = await page.evaluate(
      () => window.__convNav?.swipeJankEvents?.() ?? 0,
    );
    gate.assert(
      jankCount > 0,
      `conversation-swipe-jank telemetry fired during real gestures (saw ${jankCount})`,
    );

    gate.assert(errors.length === 0, `no page errors (saw ${errors.length})`);
    if (errors.length) console.log(errors.join("\n"));
  },
);

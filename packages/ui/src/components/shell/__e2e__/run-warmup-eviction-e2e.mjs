/**
 * Real-browser e2e for #11670 — a user message sent during local-model warm-up
 * must never be silently evicted from the thread. Mounts the REAL useChatSend
 * pipeline + ContinuousChatOverlay (warm-up 503 simulated at the client-API
 * boundary) and drives:
 *
 *   1. Send while the agent 503s every turn (warm-up window).
 *   2. Assert the optimistic bubble renders, then SURVIVES the post-turn
 *      reconcile (pre-fix it vanished), with a retryable failed turn + Retry chip.
 *   3. Mark the model ready, click Retry, assert delivery exactly once + reply.
 *
 * Mechanics come from the shared e2e-runner.
 * Run: bun run --cwd packages/ui test:warmup-eviction-e2e
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-warmup-eviction");

const userBubbles = (p, text) =>
  p.locator('[data-testid="thread-line"][data-role="user"]', { hasText: text }).count();
const retryChips = (p) => p.getByTestId("thread-line-retry").count();
const assistantWithText = (p, text) =>
  p.locator('[data-testid="thread-line"][data-role="assistant"]', { hasText: text }).count();

const MESSAGE = "hello while you warm up";

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "warmup-eviction-fixture.tsx"),
      outDir,
      htmlName: "warmup-eviction.html",
      title: "warmup eviction e2e",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
      processShim: true,
      background: "#0a0d16",
    },
    context: { viewport: { width: 430, height: 932 } },
    record: { name: "warmup-eviction.webm" },
    waitFor: '[data-testid="chat-sheet"]',
    passMessage: `\nPASS — screenshots in ${outDir}`,
  },
  async ({ page, gate, snap, logs, errors }) => {
    const { assert } = gate;

    // 1) Send during the warm-up window (every turn 503s, nothing persisted).
    await page.getByTestId("chat-composer-textarea").click();
    await page.getByTestId("chat-composer-textarea").fill(MESSAGE);
    await page.keyboard.press("Enter");

    // Optimistic bubble is on screen while the send is in flight.
    await page.waitForSelector('[data-testid="thread-line"][data-role="user"]');
    assert((await userBubbles(page, MESSAGE)) === 1, "optimistic user bubble renders on send");
    await snap(page, "optimistic-bubble-in-flight");

    // 2) Let the 503 + post-turn reconcile settle. Pre-fix: the reload
    //    full-replaced the thread with the (empty) server truth and it vanished.
    await page.waitForTimeout(2200);
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "user bubble SURVIVES the warm-up 503 + reconcile reload (#11670)",
    );
    assert((await retryChips(page)) === 1, "a retryable failed assistant turn (Retry chip) is attached");
    assert(
      (await assistantWithText(page, "didn't reach the agent")) === 1,
      "the failed turn explains the message did not reach the agent",
    );
    await snap(page, "survived-with-retry");

    // 3) Model comes online → one tap on Retry delivers the turn exactly once.
    await page.evaluate(() => window.__setModelReady(true));
    await page.getByTestId("thread-line-retry").click();
    await page.waitForSelector('[data-testid="thread-line"][data-role="assistant"]');
    // Wait for the reply + the post-turn reconcile (server truth now holds it).
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="thread-line"][data-role="assistant"]'),
        ).some((el) => el.textContent?.includes("I'm awake now")),
      undefined,
      { timeout: 8000 },
    );
    await page.waitForTimeout(600);
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "retry delivers the message exactly once (no duplicate bubble)",
    );
    assert((await assistantWithText(page, "I'm awake now")) === 1, "the agent's reply lands after retry");
    assert((await retryChips(page)) === 0, "the failed turn is reconciled away once the turn persisted");
    await snap(page, "delivered-after-retry");

    await writeFile(join(outDir, "console.log"), `${logs.join("\n")}\n`, "utf8");
    assert(errors.length === 0, `no page errors (got: ${errors.join()})`);
  },
);

/**
 * Real-browser e2e for #18045 — the first shared-agent turn's named
 * cache-warming 503s must be absorbed inside one pending send, never surfaced
 * as user-visible failures, and the canonical `insufficient_credits` 402 must
 * render the terminal out-of-credits turn instead of a retryable failure.
 *
 * Mounts the REAL useChatSend → streamChatEndpoint → rawRequest pipeline +
 * ChatOverlay, with the server simulated at the transport boundary, and
 * drives:
 *
 *   1. Send while the server replays the exact staging sequence —
 *      `agent_cache_warming` 503, `shared_runtime_cache_warming` 503 (both
 *      `Retry-After: 1`), then the real streamed reply.
 *   2. Assert the optimistic bubble stays pending across both barriers with
 *      NO Retry chip and NO error notice, and the first non-warming response
 *      lands as the reply (pre-fix: the turn failed with a Retry chip).
 *   3. Reload with `?scenario=credits`: assert the 402 renders the terminal
 *      out-of-credits turn with the server's message and no Retry chip.
 *
 * Mechanics come from the shared e2e-runner.
 * Run: bun run --cwd packages/ui test:warming-absorption-e2e
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
const outDir = join(here, "output-warming-absorption");

const userBubbles = (p, text) =>
  p
    .locator('[data-testid="thread-line"][data-role="user"]', { hasText: text })
    .count();
const retryChips = (p) => p.getByTestId("thread-line-retry").count();
const assistantWithText = (p, text) =>
  p
    .locator('[data-testid="thread-line"][data-role="assistant"]', {
      hasText: text,
    })
    .count();

const MESSAGE = "first message to a fresh shared agent";
const REPLY = "caches warmed while your send stayed pending";
const CREDITS_MESSAGE = "out of credits";

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "warming-absorption-fixture.tsx"),
      outDir,
      htmlName: "warming-absorption.html",
      title: "warming absorption e2e",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
      processShim: true,
      background: "#0a0d16",
    },
    context: { viewport: { width: 430, height: 932 } },
    record: { name: "warming-absorption.webm" },
    waitFor: '[data-testid="chat-sheet"]',
    passMessage: `\nPASS — screenshots in ${outDir}`,
  },
  async ({ page, gate, snap, logs, errors }) => {
    const { assert } = gate;

    // 1) Send the first turn; the transport 503s twice with the named
    //    warming barriers before streaming the reply.
    await page.getByTestId("chat-composer-textarea").click();
    await page.getByTestId("chat-composer-textarea").fill(MESSAGE);
    await page.keyboard.press("Enter");

    await page.waitForSelector('[data-testid="thread-line"][data-role="user"]');
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "optimistic user bubble renders on send",
    );
    // Mid-absorption: one warming 503 has already been answered, the retry
    // wait is in flight — the turn must still look pending, not failed.
    await page.waitForTimeout(1200);
    assert(
      (await retryChips(page)) === 0,
      "no Retry chip while the warming barriers are being absorbed",
    );
    await snap(page, "pending-through-warming-503s");

    // 2) The first non-warming response lands as the reply of the SAME turn.
    await page.waitForFunction(
      (reply) =>
        Array.from(
          document.querySelectorAll(
            '[data-testid="thread-line"][data-role="assistant"]',
          ),
        ).some((el) => el.textContent?.includes(reply)),
      REPLY,
      { timeout: 15000 },
    );
    await page.waitForTimeout(400);
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "user bubble delivered exactly once (same clientMessageId across retries)",
    );
    assert(
      (await assistantWithText(page, REPLY)) === 1,
      "first non-warming response is the turn's reply",
    );
    assert(
      (await retryChips(page)) === 0,
      "the warm-up never became a user-visible failure (#18045)",
    );
    assert(
      (await page.getByTestId("fixture-notice").count()) === 0,
      "no error notice was raised for the absorbed warm-up",
    );
    await snap(page, "reply-after-absorption");

    // 3) The canonical 402 is terminal: out-of-credits turn, no Retry chip.
    await page.goto(`${page.url().split("?")[0]}?scenario=credits`);
    await page.waitForSelector('[data-testid="chat-sheet"]');
    await page.getByTestId("chat-composer-textarea").click();
    await page.getByTestId("chat-composer-textarea").fill(MESSAGE);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (needle) =>
        Array.from(
          document.querySelectorAll(
            '[data-testid="thread-line"][data-role="assistant"]',
          ),
        ).some((el) => el.textContent?.toLowerCase().includes(needle)),
      CREDITS_MESSAGE,
      { timeout: 10000 },
    );
    assert(
      (await retryChips(page)) === 0,
      "insufficient_credits renders terminal (no Retry chip that re-hits the empty balance)",
    );
    assert(
      (await page.getByTestId("chat-insufficient-credits-add").count()) === 1,
      "insufficient_credits renders the structured out-of-credits gate with the Add credits CTA",
    );
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "the user bubble survives the 402",
    );
    await snap(page, "credits-gate-terminal");

    await writeFile(join(outDir, "console.log"), `${logs.join("\n")}\n`, "utf8");
    assert(errors.length === 0, `no page errors (got: ${errors.join()})`);
  },
);

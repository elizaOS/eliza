/**
 * Real-browser e2e for #18045 — the first shared-agent turn's named
 * cache-warming 503s must be absorbed inside one pending send, never surfaced
 * as user-visible failures, the canonical `insufficient_credits` 402 must
 * render terminally, and an independently stale history load must preserve a
 * just-rekeyed turn until server history converges.
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
 *      lands as the reply even when the required history refresh temporarily
 *      omits its receipt-backed rows (pre-fix: the completed turn vanished).
 *   3. Reload with `?scenario=credits`: assert the 402 renders the terminal
 *      out-of-credits turn with the server's message and no Retry chip.
 *   4. Reload with `?scenario=rekey-race`: start history GET #2 before send,
 *      rekey on the third POST's durable receipts, then release stale history
 *      and prove a final durable GET converges without duplicate rows.
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
const OLDER_USER = "Earlier shared-agent question";
const OLDER_REPLY = "Earlier shared-agent answer";
const CREDITS_MESSAGE = "out of credits";
const DURABLE_USER_ID = "srv-u-1";
const DURABLE_ASSISTANT_ID = "srv-a-1";

const fixtureSignals = (p) => p.getByTestId("fixture-signals");
const signalAttribute = (p, name) => fixtureSignals(p).getAttribute(name);
const clientMessageIds = async (p) =>
  JSON.parse((await signalAttribute(p, "data-client-message-ids")) ?? "[]");

async function assertSingleRetriedSendIdentity(page, assert, label) {
  const ids = await clientMessageIds(page);
  assert(
    (await signalAttribute(page, "data-stream-posts")) === "3",
    `${label}: exactly three stream POST attempts`,
  );
  assert(ids.length === 3, `${label}: every POST exposes its clientMessageId`);
  assert(
    ids.every((id) => typeof id === "string" && id.length > 0),
    `${label}: every clientMessageId is non-empty`,
  );
  assert(
    new Set(ids).size === 1,
    `${label}: all retries reuse one logical clientMessageId`,
  );
  return ids;
}

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
      (await assistantWithText(page, OLDER_REPLY)) === 1,
      "stale history rows are retained without replacing the completed turn",
    );
    assert(
      (await retryChips(page)) === 0,
      "the warm-up never became a user-visible failure (#18045)",
    );
    assert(
      (await page.getByTestId("fixture-notice").count()) === 0,
      "no error notice was raised for the absorbed warm-up",
    );
    await assertSingleRetriedSendIdentity(page, assert, "warming leg");
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

    // 4) Regression #27685: an independent loader owns GET #2 before the send.
    //    Its stale response is withheld until the terminal SSE has rekeyed both
    //    optimistic rows, then a third GET proves durable convergence.
    await page.goto(`${page.url().split("?")[0]}?scenario=rekey-race`);
    await page.waitForSelector('[data-testid="chat-sheet"]');
    await page.waitForFunction(
      () => {
        const signals = document.querySelector(
          '[data-testid="fixture-signals"]',
        );
        return (
          signals?.getAttribute("data-race-phase") === "stale-pending" &&
          signals.getAttribute("data-history-gets") === "2" &&
          signals.getAttribute("data-stale-history-state") === "pending"
        );
      },
      undefined,
      { timeout: 10000 },
    );

    await page.getByTestId("chat-composer-textarea").click();
    await page.getByTestId("chat-composer-textarea").fill(MESSAGE);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      ({ userId, assistantId }) => {
        const signals = document.querySelector(
          '[data-testid="fixture-signals"]',
        );
        return (
          signals?.getAttribute("data-turn-user-id") === userId &&
          signals.getAttribute("data-turn-assistant-id") === assistantId &&
          signals.getAttribute("data-stream-posts") === "3"
        );
      },
      { userId: DURABLE_USER_ID, assistantId: DURABLE_ASSISTANT_ID },
      { timeout: 15000 },
    );

    const raceClientMessageIds = await assertSingleRetriedSendIdentity(
      page,
      assert,
      "rekey-race leg",
    );
    assert(
      (await signalAttribute(page, "data-stale-history-state")) === "pending",
      "durable ids are visible before the stale GET is released",
    );
    assert(
      (await retryChips(page)) === 0,
      "rekey-race warming retries never surface a Retry chip",
    );
    assert(
      (await page.getByTestId("fixture-notice").count()) === 0,
      "rekey-race warming retries raise no error notice",
    );
    await snap(page, "durable-ids-before-stale-release");

    await page
      .getByTestId("fixture-release-stale-history")
      .evaluate((button) => button.click());
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="fixture-signals"]')
          ?.getAttribute("data-race-phase") === "stale-committed",
      undefined,
      { timeout: 10000 },
    );
    assert(
      (await userBubbles(page, OLDER_USER)) === 1,
      "older user history remains after the stale GET commits",
    );
    assert(
      (await assistantWithText(page, OLDER_REPLY)) === 1,
      "older assistant history remains after the stale GET commits",
    );
    assert(
      (await userBubbles(page, MESSAGE)) === 1,
      "rekeyed user row survives the independently stale GET exactly once",
    );
    assert(
      (await assistantWithText(page, REPLY)) === 1,
      "rekeyed assistant row survives the independently stale GET exactly once",
    );
    await snap(page, "stale-history-preserves-rekeyed-turn");

    await page
      .getByTestId("fixture-converge-durable-history")
      .evaluate((button) => button.click());
    await page.waitForFunction(
      () => {
        const signals = document.querySelector(
          '[data-testid="fixture-signals"]',
        );
        return (
          signals?.getAttribute("data-race-phase") === "converged" &&
          signals.getAttribute("data-history-gets") === "3"
        );
      },
      undefined,
      { timeout: 10000 },
    );
    assert(
      (await signalAttribute(page, "data-turn-user-count")) === "1" &&
        (await signalAttribute(page, "data-turn-user-id")) === DURABLE_USER_ID,
      "durable convergence has exactly one user row",
    );
    assert(
      (await signalAttribute(page, "data-turn-assistant-count")) === "1" &&
        (await signalAttribute(page, "data-turn-assistant-id")) ===
          DURABLE_ASSISTANT_ID,
      "durable convergence has exactly one assistant row",
    );
    assert(
      (await userBubbles(page, MESSAGE)) === 1 &&
        (await assistantWithText(page, REPLY)) === 1,
      "rendered durable turn converges without duplicate bubbles",
    );
    assert(
      (await retryChips(page)) === 0,
      "durable convergence retains no Retry chip",
    );
    await snap(page, "durable-history-converged-once");

    const messageIds = JSON.parse(
      (await signalAttribute(page, "data-message-ids")) ?? "[]",
    );
    const observedStreamPosts = Number(
      await signalAttribute(page, "data-stream-posts"),
    );
    const observedHistoryGets = Number(
      await signalAttribute(page, "data-history-gets"),
    );
    const observedTurnUserCount = Number(
      await signalAttribute(page, "data-turn-user-count"),
    );
    const observedTurnAssistantCount = Number(
      await signalAttribute(page, "data-turn-assistant-count"),
    );
    await writeFile(
      join(outDir, "rekey-race-signals.json"),
      `${JSON.stringify(
        {
          streamPosts: observedStreamPosts,
          clientMessageIds: raceClientMessageIds,
          historyGets: observedHistoryGets,
          staleHistoryState: await signalAttribute(
            page,
            "data-stale-history-state",
          ),
          racePhase: await signalAttribute(page, "data-race-phase"),
          messageIds,
          turnUserCount: observedTurnUserCount,
          turnAssistantCount: observedTurnAssistantCount,
          pageErrors: errors,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(outDir, "console.log"),
      `${logs.join("\n")}\n`,
      "utf8",
    );
    assert(errors.length === 0, `no page errors (got: ${errors.join()})`);
  },
);

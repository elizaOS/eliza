/**
 * Playwright wrapper for the onboarding liveness contract (#14359): drive one
 * post-onboarding chat turn through the real UI and assert the rendered reply
 * came from a real model. The surface-agnostic rule (empty / stub-marker →
 * fail) lives in the dependency-free `liveness-contract.mjs`; this file only
 * adds the DOM driving so browser-based onboarding lanes (cloud-live and the
 * web/desktop paths) end the same way: send a message, wait for the assistant
 * reply, assert liveness. The timed variant additionally waits for the thread
 * to settle, re-reads the same fresh row, and measures from initiation of the
 * UI send action through final validation; it is full-turn latency, not
 * first-token latency.
 *
 * Reply selection is fail-closed by construction (#16936 review): the assistant
 * row count is snapshotted before send, only rows that did not exist before the
 * send are considered, and — when a challenge token is provided — a row counts
 * only once it contains that run-unique token. A pending status row, the
 * first-run greeting, a cached reply, or a wrong-code answer can never satisfy
 * the wait, whatever the chat surface renders inside the row.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import {
  assertLiveChallengeReply,
  assertLiveReply,
} from "./liveness-contract.mjs";

export {
  assertLiveChallengeReply,
  assertLiveReply,
  buildLivenessChallenge,
  extractLivenessChallengeToken,
  isLiveReply,
  LIVENESS_CHALLENGE_PREFIX,
  LivenessAssertionError,
  STUB_FIXTURE_MARKER,
} from "./liveness-contract.mjs";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
const ASSISTANT_MESSAGE_SELECTOR =
  '[data-role="assistant"], [data-testid="chat-message-assistant"], [data-testid="thread-line"][data-role="assistant"]';

const DEFAULT_PROMPT = "In one short sentence, say hello.";
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;

export interface LivenessChatOptions {
  /** Prompt to send; defaults to a short, tool-free hello. */
  prompt?: string;
  /**
   * Run-unique challenge token the new assistant row must echo (from
   * `extractLivenessChallengeToken`). When set, the wait only accepts a row
   * containing the token; without it, the first non-empty new row is accepted.
   */
  challengeToken?: string;
  /** How long to wait for the assistant reply to render. */
  replyTimeoutMs?: number;
  /** Lane name used to attribute a liveness failure. */
  label?: string;
}

export interface TimedLivenessReply {
  /** Validated, trimmed assistant reply. Never persist this in CI metadata. */
  reply: string;
  /** Composer send click to the settled, validated assistant turn. */
  firstTurnLatencyMs: number;
}

interface RenderedReplyMeasurement {
  reply: string;
  sendActionStartedAt: number;
}

function chatComposer(page: Page): Locator {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page): Locator {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

async function acceptedReplyText(
  row: Locator,
  challengeToken: string | undefined,
): Promise<string> {
  if ((await row.getAttribute("data-failure"))?.trim()) return "";
  if ((await row.locator('[data-testid="thread-line-retry"]').count()) > 0)
    return "";
  // Mirror the iOS driver's classification: a row whose overlay body is
  // explicitly in the status phase is a pending placeholder. A row with no
  // overlay marker is a plain chat surface, where the typing indicator renders
  // as a sibling and any non-empty matched row is assistant content.
  const overlayBodies = await row
    .locator('[data-testid="overlay-assistant-turn-body"]')
    .count();
  if (overlayBodies > 0) {
    const replyBodies = await row
      .locator(
        '[data-testid="overlay-assistant-turn-body"][data-phase="reply"]',
      )
      .count();
    if (replyBodies === 0) return "";
  }
  const text = (await row.textContent())?.trim() ?? "";
  if (!text) return "";
  if (challengeToken && !text.toLowerCase().includes(challengeToken)) return "";
  return text;
}

/**
 * Send one chat turn on the already-open chat surface and return the raw
 * rendered assistant reply text from a row that did not exist before the send.
 * Assumes the composer is visible (the caller has navigated to /chat
 * post-onboarding). Kept separate from the assertion so a caller can inspect
 * the reply before enforcing the contract.
 */
async function sendChatAndMeasureRenderedReply(
  page: Page,
  options: LivenessChatOptions = {},
  waitForSettledTurn: boolean,
): Promise<RenderedReplyMeasurement> {
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const composer = chatComposer(page);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  const assistantRows = page.locator(ASSISTANT_MESSAGE_SELECTOR);
  const priorCount = await assistantRows.count();
  await composer.fill(options.prompt ?? DEFAULT_PROMPT);
  await expect(chatSendButton(page)).toBeEnabled();
  const sendStartedAt = performance.now();
  await chatSendButton(page).click();

  // Only rows beyond the pre-send snapshot can satisfy the turn: the pre-existing
  // greeting or a cached reply must never be read as this run's answer. A row
  // counts only when it is not a pending placeholder — the overlay publishes
  // `data-phase="status"` while the "Thinking"/"Running …" label occupies the
  // row — and, when a challenge token is set, when the row echoes it: a fresh
  // random token cannot appear in status chrome or any pre-send text. The
  // transcript only appends during a turn, so indices ≥ the snapshot are
  // exactly this run's rows.
  const token = options.challengeToken?.trim().toLowerCase();
  const replyMatch = { text: "", rowIndex: -1 };
  await expect
    .poll(
      async () => {
        const count = await assistantRows.count();
        for (let i = priorCount; i < count; i += 1) {
          const row = assistantRows.nth(i);
          const text = await acceptedReplyText(row, token);
          if (!text) continue;
          replyMatch.text = text;
          replyMatch.rowIndex = i;
          return text;
        }
        return "";
      },
      {
        timeout: replyTimeoutMs,
        message: token
          ? `assistant reply echoing challenge token appeared in a new row${options.label ? ` (${options.label})` : ""}`
          : `assistant reply appeared in a new row${options.label ? ` (${options.label})` : ""}`,
      },
    )
    .toMatch(/\S/);

  if (!replyMatch.text || replyMatch.rowIndex < priorCount) {
    throw new Error("liveness reply poll ended without a reply");
  }

  let measuredReply = replyMatch.text;
  if (waitForSettledTurn) {
    // `data-phase="reply"` flips when the first content renders, so it cannot
    // be the end boundary for a conservatively named first-turn metric. The
    // overlay thread content owns the authoritative responding state. Only the
    // timed Cloud lane opts into this overlay-specific boundary; the historic
    // string APIs remain usable by plain chat surfaces.
    const remainingTimeoutMs = Math.max(
      1,
      Math.ceil(sendStartedAt + replyTimeoutMs - performance.now()),
    );
    await expect(
      page
        .getByTestId("chat-thread-scroll")
        .locator('[data-slot="message-scroller-content"][aria-busy="false"]')
        .first(),
    ).toBeVisible({ timeout: remainingTimeoutMs });
    const settledReply = await acceptedReplyText(
      assistantRows.nth(replyMatch.rowIndex),
      token,
    );
    if (!settledReply) {
      throw new Error(
        "fresh assistant row was empty or invalid after the turn settled",
      );
    }
    measuredReply = settledReply;
  }
  return {
    reply: measuredReply,
    sendActionStartedAt: sendStartedAt,
  };
}

export async function sendChatAndReadReply(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<string> {
  return (await sendChatAndMeasureRenderedReply(page, options, false)).reply;
}

/**
 * End an onboarding lane with the liveness contract: send a real chat turn and
 * assert the reply is non-empty and free of the stub fixture marker — and, when
 * `challengeToken` is provided, that it echoes this run's token. Throws (fails
 * the test) on any of those failures. Returns the validated reply so a caller
 * can attach it as evidence.
 */
export async function assertOnboardingLiveness(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<string> {
  const reply = await sendChatAndReadReply(page, options);
  return options.challengeToken
    ? assertLiveChallengeReply(reply, {
        challengeToken: options.challengeToken,
        label: options.label,
      })
    : assertLiveReply(reply, { label: options.label });
}

/**
 * Apply the onboarding liveness contract and separately return full-turn
 * latency. The duration starts immediately before the composer send click and
 * ends only after the overlay reports idle, the same fresh assistant row is
 * re-read, and its settled text passes the liveness contract. It does not claim
 * transport first-token timing.
 */
export async function assertOnboardingLivenessWithTiming(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<TimedLivenessReply> {
  const measured = await sendChatAndMeasureRenderedReply(page, options, true);
  const reply = options.challengeToken
    ? assertLiveChallengeReply(measured.reply, {
        challengeToken: options.challengeToken,
        label: options.label,
      })
    : assertLiveReply(measured.reply, { label: options.label });
  return {
    reply,
    firstTurnLatencyMs: Math.ceil(
      performance.now() - measured.sendActionStartedAt,
    ),
  };
}

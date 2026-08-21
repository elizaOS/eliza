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
 * Reply selection is fail-closed by construction (#16936 review). Strict
 * challenge callers require the fresh assistant row to echo their token. The
 * Cloud continuity lane instead anchors on the run-unique token in the exact
 * user row, then accepts only a valid assistant row that follows it before any
 * later user turn. A pending status row, first-run greeting, cached reply, or
 * unrelated answer cannot satisfy either mode.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import {
  assertLiveChallengeReply,
  assertLiveReply,
  findAnchoredLiveTurn,
} from "./liveness-contract.mjs";

export {
  assertLiveChallengeReply,
  assertLiveReply,
  buildLivenessChallenge,
  extractLivenessChallengeToken,
  findAnchoredLiveTurn,
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
  /**
   * Run-unique token present in the exact user row that owns the reply. Unlike
   * `challengeToken`, this binds by transcript order and does not require the
   * model to copy the token into its answer.
   */
  turnAnchorToken?: string;
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

export interface LivenessThreadLine {
  role: string;
  text: string;
  failureKind: string;
  hasRetry: boolean;
  phase: string | null;
}

/** Read only the in-memory row fields needed to bind a reply to a user turn. */
export async function readLivenessThreadLines(
  page: Page,
): Promise<LivenessThreadLine[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="thread-line"]'),
    ).map((row) => ({
      role: row.dataset.role ?? "",
      text: row.textContent ?? "",
      failureKind: row.dataset.failure ?? "",
      hasRetry: Boolean(row.querySelector('[data-testid="thread-line-retry"]')),
      phase:
        row.querySelector<HTMLElement>(
          '[data-testid="overlay-assistant-turn-body"]',
        )?.dataset.phase ?? null,
    })),
  );
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

  // Without a user-row anchor, only assistant rows beyond the pre-send snapshot
  // can satisfy the turn. With an anchor, DOM order supplies the stronger
  // binding: the exact token-bearing user row must precede the accepted reply.
  // In both modes `data-phase="status"`, structured failures, Retry rows, and
  // empty content remain ineligible.
  const token = options.challengeToken?.trim().toLowerCase();
  const turnAnchorToken = options.turnAnchorToken?.trim().toLowerCase();
  const replyMatch = { text: "", rowIndex: -1, threadRowIndex: -1 };
  await expect
    .poll(
      async () => {
        if (turnAnchorToken) {
          const anchored = findAnchoredLiveTurn(
            await readLivenessThreadLines(page),
            { anchorToken: turnAnchorToken },
          );
          if (!anchored) return "";
          if (token && !anchored.reply.toLowerCase().includes(token)) return "";
          replyMatch.text = anchored.reply;
          replyMatch.threadRowIndex = anchored.assistantLineIndex;
          return anchored.reply;
        }
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
          : turnAnchorToken
            ? `assistant reply appeared after the exact token-bearing user row${options.label ? ` (${options.label})` : ""}`
            : `assistant reply appeared in a new row${options.label ? ` (${options.label})` : ""}`,
      },
    )
    .toMatch(/\S/);

  if (
    !replyMatch.text ||
    (turnAnchorToken
      ? replyMatch.threadRowIndex < 0
      : replyMatch.rowIndex < priorCount)
  ) {
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
    const settledReply = turnAnchorToken
      ? (findAnchoredLiveTurn(await readLivenessThreadLines(page), {
          anchorToken: turnAnchorToken,
        })?.reply ?? "")
      : await acceptedReplyText(assistantRows.nth(replyMatch.rowIndex), token);
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

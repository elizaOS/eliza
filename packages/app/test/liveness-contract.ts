/**
 * Playwright wrapper for the onboarding liveness contract (#14359): drive one
 * post-onboarding chat turn through the real UI and assert the rendered reply
 * came from a real model. The surface-agnostic rule (empty / stub-marker →
 * fail) lives in the dependency-free `liveness-contract.mjs`; this file only
 * adds the DOM driving so browser-based onboarding lanes (cloud-live and the
 * web/desktop paths) end the same way: send a message, wait for the assistant
 * reply, assert liveness.
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

function chatComposer(page: Page): Locator {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page): Locator {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

/**
 * Send one chat turn on the already-open chat surface and return the raw
 * rendered assistant reply text from a row that did not exist before the send.
 * Assumes the composer is visible (the caller has navigated to /chat
 * post-onboarding). Kept separate from the assertion so a caller can inspect
 * the reply before enforcing the contract.
 */
export async function sendChatAndReadReply(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<string> {
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const composer = chatComposer(page);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  const assistantRows = page.locator(ASSISTANT_MESSAGE_SELECTOR);
  const priorCount = await assistantRows.count();
  await composer.fill(options.prompt ?? DEFAULT_PROMPT);
  await expect(chatSendButton(page)).toBeEnabled();
  await chatSendButton(page).click();

  // Only rows beyond the pre-send snapshot can satisfy the turn: the pre-existing
  // greeting or a cached reply must never be read as this run's answer. When a
  // challenge token is set, additionally require the row to echo it — a pending
  // status row ("Thinking", "Thinking · 1s", "Replying") or a streaming prefix
  // cannot contain a fresh random token, so the poll keeps waiting.
  const token = options.challengeToken?.trim().toLowerCase();
  let replyText: string | null = null;
  await expect
    .poll(
      async () => {
        const count = await assistantRows.count();
        for (let i = priorCount; i < count; i += 1) {
          const text = (await assistantRows.nth(i).textContent())?.trim() ?? "";
          if (!text) continue;
          if (token && !text.toLowerCase().includes(token)) continue;
          replyText = text;
          return text;
        }
        return "";
      },
      {
        timeout: replyTimeoutMs,
        message: token
          ? `assistant reply echoing challenge token appeared in a new row${options.label ? ` (${options.label})` : ""}`
          : "assistant reply appeared in a new row",
      },
    )
    .toMatch(/\S/);
  // The poll's winning element and the returned text are the same value; never
  // re-resolve a locator after the wait (the row may have kept streaming).
  if (replyText === null)
    throw new Error("liveness reply poll ended without a reply");
  return replyText;
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

/**
 * Playwright wrapper for the onboarding liveness contract (#14359): drive one
 * post-onboarding chat turn through the real UI and assert the rendered reply
 * came from a real model. The surface-agnostic rule (empty / stub-marker →
 * fail) lives in the dependency-free `liveness-contract.mjs`; this file only
 * adds the DOM driving so browser-based onboarding lanes (cloud-live and the
 * web/desktop paths) end the same way: send a message, wait for the assistant
 * reply, assert liveness.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { assertLiveReply } from "./liveness-contract.mjs";

export {
  assertLiveReply,
  isLiveReply,
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
 * rendered assistant reply text. Assumes the composer is visible (the caller
 * has navigated to /chat post-onboarding). Kept separate from the assertion so
 * a caller can inspect the reply before enforcing the contract.
 */
export async function sendChatAndReadReply(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<string> {
  const composer = chatComposer(page);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.fill(options.prompt ?? DEFAULT_PROMPT);
  await expect(chatSendButton(page)).toBeEnabled();
  await chatSendButton(page).click();

  const assistant = page.locator(ASSISTANT_MESSAGE_SELECTOR).last();
  await expect(assistant).toBeVisible({
    timeout: options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
  });
  return (await assistant.textContent())?.trim() ?? "";
}

/**
 * End an onboarding lane with the liveness contract: send a real chat turn and
 * assert the reply is non-empty and free of the stub fixture marker. Throws
 * (fails the test) when the reply is empty or stubbed. Returns the validated
 * reply so a caller can attach it as evidence.
 */
export async function assertOnboardingLiveness(
  page: Page,
  options: LivenessChatOptions = {},
): Promise<string> {
  const reply = await sendChatAndReadReply(page, options);
  return assertLiveReply(reply, { label: options.label });
}

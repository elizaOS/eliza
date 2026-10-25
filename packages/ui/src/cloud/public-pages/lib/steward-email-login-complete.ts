/**
 * Token-free, same-origin notification that a Steward magic-link callback
 * established the shared browser session in another tab.
 */

import { sanitizeLoginReturnTo } from "./login-return-to";

export const STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE =
  "eliza-steward-email-login-complete";
export const STEWARD_EMAIL_LOGIN_COMPLETE_CHANNEL =
  "eliza-steward-email-login-complete";

export type StewardEmailLoginCompleteMessage = {
  type: typeof STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE;
  email: string;
  destination: string;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isStewardEmailLoginCompleteMessage(
  data: unknown,
  expectedEmail?: string,
): data is StewardEmailLoginCompleteMessage {
  if (!data || typeof data !== "object") return false;
  const message = data as {
    type?: unknown;
    email?: unknown;
    destination?: unknown;
  };
  if (message.type !== STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE) return false;
  if (typeof message.email !== "string" || !normalizeEmail(message.email)) {
    return false;
  }
  if (
    typeof message.destination !== "string" ||
    !sanitizeLoginReturnTo(message.destination.trim())
  ) {
    return false;
  }
  return (
    expectedEmail === undefined ||
    normalizeEmail(message.email) === normalizeEmail(expectedEmail)
  );
}

export function publishStewardEmailLoginComplete(
  email: string,
  destination: string,
): void {
  const normalizedEmail = normalizeEmail(email);
  const trimmedDestination = destination.trim();
  if (
    !normalizedEmail ||
    !sanitizeLoginReturnTo(trimmedDestination) ||
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return;
  }

  try {
    const channel = new BroadcastChannel(STEWARD_EMAIL_LOGIN_COMPLETE_CHANNEL);
    channel.postMessage({
      type: STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
      email: normalizedEmail,
      destination: trimmedDestination,
    } satisfies StewardEmailLoginCompleteMessage);
    channel.close();
  } catch (error) {
    void error;
    // error-policy:J6 this signal is best-effort; the callback still redirects.
  }
}

export function subscribeStewardEmailLoginComplete(
  expectedEmail: string,
  onComplete: (message: StewardEmailLoginCompleteMessage) => void,
): () => void {
  if (
    !normalizeEmail(expectedEmail) ||
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => {};
  }

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(STEWARD_EMAIL_LOGIN_COMPLETE_CHANNEL);
  } catch (error) {
    void error;
    // error-policy:J5 authoritative challenge polling observes the same
    // completion when this optional low-latency transport is unavailable.
    return () => {};
  }

  const handler = (event: MessageEvent) => {
    if (!isStewardEmailLoginCompleteMessage(event.data, expectedEmail)) return;
    onComplete(event.data);
  };
  channel.addEventListener("message", handler);

  return () => {
    try {
      channel.removeEventListener("message", handler);
      channel.close();
    } catch (error) {
      void error;
      // error-policy:J6 teardown only.
    }
  };
}

/**
 * Classifies chat-send failures and reconciles optimistic turns with reloaded
 * server history. Keeping this policy outside the React hook makes every send
 * entry point use the same user-visible notice and persistence check.
 */

import type { ConversationMessage } from "../api";

const VALIDATION_FAILURE_STATUSES: ReadonlySet<number> = new Set([
  400, 413, 415, 422,
]);

export function getSendValidationFailureMessage(err: unknown): string | null {
  const status = (err as { status?: number }).status;
  if (typeof status !== "number" || !VALIDATION_FAILURE_STATUSES.has(status)) {
    return null;
  }
  const message = err instanceof Error ? err.message.trim() : "";
  if (!message || /^HTTP \d+$/i.test(message)) return null;
  return message;
}

export function buildSendFailureNotice(err: unknown): string {
  const status = (err as { status?: number }).status;
  const kind = (err as { kind?: string }).kind;
  if (status === 401 || status === 403) {
    return "Your session expired — sign in again and resend your message.";
  }
  if (status === 429) {
    return "The agent is busy right now — wait a few seconds and resend.";
  }
  if (status === 503 || status === 502) {
    return "The agent is still waking up — give it a moment and resend.";
  }
  const validationMessage = getSendValidationFailureMessage(err);
  if (validationMessage !== null) {
    return `The agent couldn't accept that message: ${validationMessage}.`;
  }
  if (kind === "timeout") {
    return "The agent took too long to respond — give it a moment and resend.";
  }
  if (kind === "network") {
    return "Couldn't reach the agent — check your connection and resend.";
  }
  return "That message didn't go through — please resend.";
}

export const UNDELIVERED_TURN_NOTICE =
  "That message didn't reach the agent — it may still be starting up. Retry in a moment.";

export function resolveAbortRoomId(
  conversationId: string,
  knownRoomId: string | null | undefined,
  cachedRoomId: string | null | undefined,
): string {
  return knownRoomId?.trim() || cachedRoomId?.trim() || conversationId;
}

const SENT_TURN_MATCH_SLACK_MS = 60_000;

export function sentUserTurnPresent(
  messages: readonly ConversationMessage[],
  sentText: string,
  sentAt: number,
): boolean {
  const text = sentText.trim();
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.timestamp >= sentAt - SENT_TURN_MATCH_SLACK_MS &&
      message.text.trim() === text,
  );
}

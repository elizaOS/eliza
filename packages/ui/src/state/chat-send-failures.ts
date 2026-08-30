/**
 * Classifies chat-send failures and reconciles optimistic turns with reloaded
 * server history. Keeping this policy outside the React hook makes every send
 * entry point use the same user-visible notice and persistence check.
 */

import type { ConversationMessage } from "../api";

const VALIDATION_FAILURE_STATUSES: ReadonlySet<number> = new Set([
  400, 413, 415, 422,
]);

interface SendFailureMetadata {
  status: unknown;
  kind: unknown;
  message: string;
}

function readFailureProperty(
  failure: unknown,
  property: "status" | "kind",
): unknown {
  if (
    failure === null ||
    (typeof failure !== "object" && typeof failure !== "function")
  ) {
    return undefined;
  }

  try {
    return Reflect.get(failure, property);
  } catch {
    // error-policy:J3 Rejection values are untrusted and hostile getters fail closed.
    return undefined;
  }
}

function readFailureMetadata(failure: unknown): SendFailureMetadata {
  let message = "";
  try {
    if (failure instanceof Error && typeof failure.message === "string") {
      message = failure.message.trim();
    }
  } catch {
    // error-policy:J3 A hostile Error prototype or message getter fails closed.
    message = "";
  }

  return {
    status: readFailureProperty(failure, "status"),
    kind: readFailureProperty(failure, "kind"),
    message,
  };
}

function validationFailureMessage({
  status,
  message,
}: SendFailureMetadata): string | null {
  if (typeof status !== "number" || !VALIDATION_FAILURE_STATUSES.has(status)) {
    return null;
  }
  if (!message || /^HTTP \d+$/i.test(message)) return null;
  return message;
}

export function getSendValidationFailureMessage(err: unknown): string | null {
  return validationFailureMessage(readFailureMetadata(err));
}

export function buildSendFailureNotice(err: unknown): string {
  const metadata = readFailureMetadata(err);
  const { status, kind } = metadata;
  if (status === 401 || status === 403) {
    return "Your session expired — sign in again and resend your message.";
  }
  if (status === 429) {
    return "The agent is busy right now — wait a few seconds and resend.";
  }
  if (status === 503 || status === 502) {
    return "The agent is still waking up — give it a moment and resend.";
  }
  const validationMessage = validationFailureMessage(metadata);
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

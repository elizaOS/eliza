/** Normalizes Twilio call lifecycle receipts and identifies terminal outcomes. */

export const TWILIO_CALL_STATUSES = [
  "requesting",
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
  "hangup-requested",
  "provider-error",
] as const;

export type TwilioCallStatus = (typeof TWILIO_CALL_STATUSES)[number];

const providerStatuses = new Set<TwilioCallStatus>([
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

const terminalStatuses = new Set<TwilioCallStatus>([
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
  "provider-error",
]);

export function normalizeTwilioProviderCallStatus(
  value: string,
): TwilioCallStatus | null {
  const normalized = value.trim().toLowerCase() as TwilioCallStatus;
  return providerStatuses.has(normalized) ? normalized : null;
}

export function isTerminalTwilioCallStatus(status: string): boolean {
  return terminalStatuses.has(status as TwilioCallStatus);
}

export function parseTwilioSequenceNumber(
  value: string | undefined,
): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

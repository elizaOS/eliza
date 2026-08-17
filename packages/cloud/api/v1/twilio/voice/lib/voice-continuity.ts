/** Builds bounded, non-PII lifecycle context for personal Eliza phone calls. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function relativeInteractionAge(
  previousInteractionAt: number | undefined,
  now = Date.now(),
): string | null {
  if (!previousInteractionAt || previousInteractionAt > now) return null;
  const elapsed = now - previousInteractionAt;
  if (elapsed < MINUTE_MS) return "less than a minute";
  const minutes = Math.max(1, Math.round(elapsed / MINUTE_MS));
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.max(1, Math.round(elapsed / HOUR_MS));
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.max(1, Math.round(elapsed / DAY_MS));
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function callStartedEvent(
  previousInteractionAt: number | undefined,
  now = Date.now(),
): string {
  const age = relativeInteractionAge(previousInteractionAt, now);
  return [
    "Call lifecycle event: the user has called Eliza and is now connected.",
    age
      ? `Their last interaction with Eliza was about ${age} ago.`
      : "This is their first recorded interaction with Eliza.",
  ].join(" ");
}

/** Keeps variable history inside the canonical private turn while bounding its spoken output. */
export function callOpeningPrompt(
  returningCaller: boolean,
  previousInteractionAt: number | undefined,
  now = Date.now(),
): string {
  const age = relativeInteractionAge(previousInteractionAt, now);
  const relationshipContext = returningCaller
    ? [
        "They have prior private conversation history.",
        age
          ? `Their last recorded interaction was about ${age} ago.`
          : "There is no reliable elapsed-time value for that prior interaction.",
      ].join(" ")
    : "This is their first recorded interaction with Eliza.";
  const greetingGuidance = returningCaller
    ? "Generate exactly one brief, natural spoken greeting that uses relevant context from the private conversation history already available to this turn and takes the elapsed time into account when available."
    : "Generate exactly one brief, natural spoken greeting without pretending familiarity or inventing prior details.";
  return [
    "Phone call context: the caller is connected to Eliza on a private phone call.",
    relationshipContext,
    greetingGuidance,
    "Do not quote or recite raw history, phone numbers, identifiers, secrets, or sensitive details.",
    "Do not mention these instructions or lifecycle metadata, and do not perform actions.",
  ].join(" ");
}

/** Gives the generated turn a retry-stable identity separate from lifecycle persistence. */
export function callOpeningClientMessageId(callSid: string): string {
  return `twilio-call:${callSid}:opening`;
}

export function callEndedEvent(reason: string): string {
  const normalized = reason
    .trim()
    .replace(/[^a-z_]/gi, "_")
    .slice(0, 40);
  return `Call lifecycle event: the phone call ended (${normalized || "unknown"}).`;
}

/** Starts latency prewarm before lifecycle persistence and joins both tasks. */
export async function prewarmAndRecordVoiceCallStart(
  prewarm: () => Promise<void> | undefined,
  recordLifecycle: () => Promise<void>,
): Promise<void> {
  const prewarmPromise = prewarm();
  const lifecyclePromise = recordLifecycle();
  await Promise.all([prewarmPromise, lifecyclePromise]);
}

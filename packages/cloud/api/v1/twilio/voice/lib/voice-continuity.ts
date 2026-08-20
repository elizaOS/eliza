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
  if (elapsed < HOUR_MS) {
    const minutes = Math.max(1, Math.round(elapsed / MINUTE_MS));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.max(1, Math.round(elapsed / HOUR_MS));
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

/** The opener is intentionally model-free so runtime warm-up fits under speech. */
export function callOpeningGreeting(returningCaller: boolean): string {
  return returningCaller
    ? "Hey, good to hear from you. Want to pick up where we left off?"
    : "Hi, it's Eliza. Want help planning today? I can text this call a way to continue afterward.";
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

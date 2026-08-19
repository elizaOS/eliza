/**
 * Preserves the user's first real request across sign-in and provisioning so
 * onboarding can return them to useful work instead of discarding their turn.
 */

const PENDING_FIRST_INTENT_KEY = "elizaos:first-run-pending-intent";
const MAX_PENDING_INTENT_LENGTH = 4_000;
const PENDING_FIRST_INTENT_TTL_MS = 30 * 60 * 1_000;

/** Save the latest real onboarding utterance; setup-choice tokens never call this. */
export function persistPendingFirstIntent(
  text: string,
  now: () => number = Date.now,
): boolean {
  if (typeof window === "undefined") return false;
  const normalized = text.trim().slice(0, MAX_PENDING_INTENT_LENGTH);
  if (!normalized) return false;
  try {
    window.sessionStorage.setItem(
      PENDING_FIRST_INTENT_KEY,
      JSON.stringify({ savedAt: now(), text: normalized }),
    );
    return true;
  } catch {
    // error-policy:J4 storage can be unavailable in private mode; onboarding
    // remains usable, but cannot promise automatic intent restoration.
    return false;
  }
}

/** Read and remove the pending request exactly once after setup completes. */
export function consumePendingFirstIntent(
  now: () => number = Date.now,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const serialized = window.sessionStorage.getItem(PENDING_FIRST_INTENT_KEY);
    if (!serialized) return null;
    const pending: unknown = JSON.parse(serialized);
    const record =
      pending && typeof pending === "object" && !Array.isArray(pending)
        ? (pending as Record<string, unknown>)
        : null;
    const savedAt = record?.savedAt;
    const text = record?.text;
    const currentTime = now();
    if (
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      typeof text !== "string" ||
      savedAt > currentTime ||
      currentTime - savedAt > PENDING_FIRST_INTENT_TTL_MS
    ) {
      window.sessionStorage.removeItem(PENDING_FIRST_INTENT_KEY);
      return null;
    }
    window.sessionStorage.removeItem(PENDING_FIRST_INTENT_KEY);
    return text.trim() || null;
  } catch {
    // error-policy:J3 unavailable or malformed storage is an explicit absence;
    // never invent a request on the user's behalf.
    return null;
  }
}

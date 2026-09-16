/**
 * Persists complete pre-agent requests until onboarding releases the real chat
 * composer. The durable copy survives native OAuth WebView eviction and is
 * removed atomically when the composer consumes it.
 */

import { shellLocalStorage } from "../surface-realm-channel";

const PENDING_FIRST_RUN_TEXT_STORAGE_KEY = "eliza:first-run:pending-text";
type PendingFirstRunTextReleaseHandler = () => void;
let releaseHandler: PendingFirstRunTextReleaseHandler | null = null;
type PendingTextConsumer = (text: string, acknowledge: () => void) => void;
let consumer: PendingTextConsumer | null = null;
let releasedRequests: readonly string[] | null = null;

function deliverPendingRequests(): void {
  if (!consumer) return;
  const requests = releasedRequests ?? readPendingFirstRunText();
  if (requests.length === 0) return;
  releasedRequests = requests;
  consumer(requests.join("\n\n"), () => {
    // An older render must not acknowledge a newer producer's request batch.
    if (releasedRequests !== requests) return;
    clearPendingFirstRunText();
  });
}

/** Retain the authoritative in-memory batch until a mounted composer commits it. */
export function handoffPendingFirstRunText(requests: readonly string[]): void {
  if (requests.length === 0) return;
  releasedRequests = [...requests];
  writePendingFirstRunText(requests);
  deliverPendingRequests();
}

/** Register only after setup completes; remounts retry an unacknowledged batch. */
export function registerPendingFirstRunTextConsumer(
  next: PendingTextConsumer,
): () => void {
  consumer = next;
  deliverPendingRequests();
  return () => {
    if (consumer === next) consumer = null;
  };
}

function parsePendingText(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new TypeError("invalid pending first-run text payload");
  }
  return parsed;
}

/** Read the complete ordered pending requests without consuming them. */
export function readPendingFirstRunText(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parsePendingText(
      window.localStorage.getItem(PENDING_FIRST_RUN_TEXT_STORAGE_KEY),
    );
  } catch {
    // error-policy:J3 corrupt persisted input is explicitly invalid, never a
    // partially recovered request list.
    clearPendingFirstRunText();
    return [];
  }
}

/** Replace the durable copy with the complete ordered in-memory requests. */
export function writePendingFirstRunText(requests: readonly string[]): void {
  if (typeof window === "undefined") return;
  if (requests.length === 0) {
    clearPendingFirstRunText();
    return;
  }
  if (!requests.every((entry) => entry.length > 0)) {
    throw new TypeError("pending first-run text entries must be non-empty");
  }
  try {
    shellLocalStorage.setItem(
      PENDING_FIRST_RUN_TEXT_STORAGE_KEY,
      JSON.stringify(requests),
    );
  } catch {
    // error-policy:J4 storage rejection leaves the complete in-memory copy in
    // the conductor; the current session remains lossless and visibly active.
  }
}

/** Return the ordered requests and clear their durable copy exactly once. */
export function takePendingFirstRunText(): string[] {
  const requests = readPendingFirstRunText();
  clearPendingFirstRunText();
  return requests;
}

/**
 * Registers the active conductor's in-memory release seam. The durable fallback
 * below covers a cold shell where the conductor has already unmounted.
 */
export function setPendingFirstRunTextReleaseHandler(
  handler: PendingFirstRunTextReleaseHandler | null,
): void {
  releaseHandler = handler;
}

/** Release every queued request to the real composer exactly once. */
export function releasePendingFirstRunText(): void {
  if (releaseHandler) {
    releaseHandler();
    return;
  }
  handoffPendingFirstRunText(releasedRequests ?? readPendingFirstRunText());
}

export function clearPendingFirstRunText(): void {
  releasedRequests = null;
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(PENDING_FIRST_RUN_TEXT_STORAGE_KEY);
  } catch {
    // error-policy:J6 best-effort teardown; a rejecting storage surface cannot
    // provide a durable value on the next read either.
  }
}

export const __TEST_ONLY__ = { PENDING_FIRST_RUN_TEXT_STORAGE_KEY };

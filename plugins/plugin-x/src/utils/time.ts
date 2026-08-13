/**
 * Normalizes X/Twitter timestamps to epoch milliseconds, inferring the source
 * unit (seconds / millis / micros) from digit count so tweet times from
 * different API surfaces compare correctly.
 *
 * Missing values (`undefined` or `0`) are distinct from unusable values
 * (`NaN`, `Infinity`, negatives). Age filters and memory writers must not
 * treat a corrupt `created_at` as “just now”.
 */
import { ElizaError } from "@elizaos/core";

const MAX_EPOCH_MS = 9_999_999_999_999;

/** True when a tweet timestamp is present but cannot be normalized. */
export function isInvalidTweetTimestamp(ts: number | undefined): boolean {
  return ts !== undefined && ts !== 0 && parseEpochMs(ts) === undefined;
}

/**
 * Normalize a tweet timestamp to epoch milliseconds.
 * Returns `undefined` for missing (`undefined`/`0`) and for unusable values.
 */
export function parseEpochMs(ts: number | undefined): number | undefined {
  if (ts === undefined || ts === 0) return undefined;
  if (!Number.isFinite(ts) || ts < 0) return undefined;

  const digits = Math.floor(Math.log10(ts)) + 1;

  if (digits <= 12) {
    return ts * 1000;
  }
  if (digits === 13) {
    return ts;
  }
  if (digits === 16) {
    return Math.floor(ts / 1000);
  }

  let scaled = ts;
  while (scaled > MAX_EPOCH_MS) {
    scaled = Math.floor(scaled / 1000);
  }
  return scaled;
}

/**
 * Normalize a tweet timestamp to epoch milliseconds.
 * Missing values fall back to now. Unusable values throw.
 */
export function getEpochMs(ts: number | undefined): number {
  const parsed = parseEpochMs(ts);
  if (parsed !== undefined) return parsed;
  if (ts === undefined || ts === 0) return Date.now();
  throw new ElizaError("Invalid tweet timestamp", {
    code: "X_INVALID_TWEET_TIMESTAMP",
    context: { timestamp: ts },
    severity: "fatal",
  });
}

/**
 * Browser-host support for the structural OS-intent authority: persistent
 * successful-intent dedupe, hash-boundary decoding, and a composer-prefill
 * event that keeps untrusted launch text reviewable instead of auto-sending it.
 */

import { decodeDeepLinkIntent, type IntentDecodeResult } from "./decode";
import type { AppliedIntentRecord } from "./dedupe";

const DEDUPE_STORAGE_KEY = "eliza:os-intent:applied:v1";
export const OS_INTENT_COMPOSER_PREFILL_EVENT =
  "eliza:os-intent:composer-prefill";

export interface OsIntentComposerPrefillDetail {
  text: string;
}

function isAppliedIntentRecord(value: unknown): value is AppliedIntentRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { intentId?: unknown }).intentId === "string" &&
    (value as { intentId: string }).intentId.length > 0 &&
    typeof (value as { appliedAt?: unknown }).appliedAt === "number" &&
    Number.isFinite((value as { appliedAt: number }).appliedAt)
  );
}

export function loadOsIntentDedupeSnapshot(): AppliedIntentRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(DEDUPE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAppliedIntentRecord) : [];
  } catch {
    // error-policy:J3 corrupt or unavailable browser storage is rejected rather
    // than interpreted as a valid record. The live in-memory store still works.
    return [];
  }
}

export function saveOsIntentDedupeSnapshot(
  records: readonly AppliedIntentRecord[],
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(DEDUPE_STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    // error-policy:J4 storage-unavailable degrade: the current owner retains
    // in-memory dedupe, while the caller visibly reports that restored-session
    // dedupe is unavailable.
    return false;
  }
}

/** Decode the hash route emitted by app-shell deep-link routing. */
export function decodeOsIntentFromHash(hash: string): IntentDecodeResult {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const [route = "", query = ""] = normalized.split("?");
  return decodeDeepLinkIntent(
    `elizaos://${route.replace(/^\/+|\/+$/g, "")}${query ? `?${query}` : ""}`,
  );
}

export function dispatchOsIntentComposerPrefill(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OsIntentComposerPrefillDetail>(
      OS_INTENT_COMPOSER_PREFILL_EVENT,
      { detail: { text } },
    ),
  );
}

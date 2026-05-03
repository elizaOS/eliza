/**
 * Pure key-generator for new API keys.
 *
 * Domain helper — no DI, no I/O, deterministic given Web Crypto's RNG. Used by
 * `IssueApiKeyUseCase` to derive `key`, `key_hash`, `key_prefix` from a single
 * source of truth before persisting.
 */

import crypto from "node:crypto";
import type { GeneratedApiKey } from "@/lib/domain/api-key/api-key";

/** First N characters of the plaintext key surfaced to admins / dashboards. */
export const API_KEY_PREFIX_LENGTH = 12;

export function generateApiKey(): GeneratedApiKey {
  const randomBytes = crypto.randomBytes(32).toString("hex");
  const key = `eliza_${randomBytes}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const prefix = key.substring(0, API_KEY_PREFIX_LENGTH);
  return { key, hash, prefix };
}

/** Hash a plaintext key — used by `ValidateApiKeyUseCase` to compute the
 *  lookup key without persisting plaintext. */
export function hashApiKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

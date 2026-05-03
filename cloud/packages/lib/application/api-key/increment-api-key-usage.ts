/**
 * IncrementApiKeyUsageUseCase — bumps usage_count + last_used_at with
 * per-process debouncing.
 *
 * Without debouncing every authenticated request triggers a DB write — on
 * inference hot paths (`/v1/messages`, `/v1/chat/completions`) that's an
 * extra round-trip per request, for telemetry that doesn't need
 * single-request precision. We coalesce writes to once per minute per key.
 *
 * The dedup map lives at module scope so it survives across requests in the
 * same Worker isolate. It only holds primitives (string keys, number
 * timestamps), so it's safe to share — the CF "no I/O across requests"
 * rule applies to I/O objects, not plain data.
 */

import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

const DEBOUNCE_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

const lastIncrementByKeyId = new Map<string, number>();

function pruneIfNeeded(now: number): void {
  if (lastIncrementByKeyId.size <= MAX_TRACKED_KEYS) return;
  const cutoff = now - DEBOUNCE_MS * 2;
  for (const [keyId, ts] of lastIncrementByKeyId) {
    if (ts < cutoff) lastIncrementByKeyId.delete(keyId);
  }
}

export class IncrementApiKeyUsageUseCase {
  constructor(private readonly apiKeys: ApiKeyRepository) {}

  async execute(apiKeyId: string): Promise<void> {
    const now = Date.now();
    const last = lastIncrementByKeyId.get(apiKeyId) ?? 0;
    if (now - last < DEBOUNCE_MS) return;

    lastIncrementByKeyId.set(apiKeyId, now);
    pruneIfNeeded(now);
    await this.apiKeys.incrementUsage(apiKeyId);
  }
}

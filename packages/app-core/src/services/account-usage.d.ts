/**
 * Account usage probes + local JSONL counters.
 *
 * Two responsibilities:
 *  1. Probe provider usage APIs (`pollAnthropicUsage`, `pollCodexUsage`)
 *     to populate the `LinkedAccountUsage` snapshot on each account.
 *  2. Maintain append-only JSONL counters per `(providerId, accountId, day)`
 *     so we can answer "calls made today / tokens used / errors" without
 *     re-reading every trajectory.
 *
 * The probes throw on HTTP error so the caller can decide whether to mark
 * the account as `rate-limited` / `needs-reauth` / `invalid`. The counters
 * are best-effort and synchronous — at our scale appendFileSync is fine.
 */
import type { LinkedAccountUsage } from "@elizaos/shared";
/**
 * Snapshot returned by the provider usage probes. Mirrors
 * {@link LinkedAccountUsage} but without `refreshedAt` being optional —
 * the probe is the thing that stamps it.
 */
export interface UsageSnapshot extends LinkedAccountUsage {
    refreshedAt: number;
}
export interface UsageEntry {
    ts: number;
    tokens?: number;
    latencyMs?: number;
    ok: boolean;
    model?: string;
    errorCode?: string;
}
type FetchLike = typeof fetch;
/**
 * Probe Anthropic's OAuth usage endpoint.
 *
 * Endpoint: `GET https://api.anthropic.com/api/oauth/usage`
 * Headers : `Authorization: Bearer <accessToken>`,
 *           `anthropic-beta: oauth-2025-04-20`,
 *           `Content-Type: application/json`
 *
 * Handles both legacy flat (`five_hour_utilization`) and new nested
 * (`five_hour: { utilization }`) response shapes. Throws on any HTTP
 * error with the status code included in the message.
 */
export declare function pollAnthropicUsage(accessToken: string, fetchImpl?: FetchLike): Promise<UsageSnapshot>;
/**
 * Probe Codex / ChatGPT's usage endpoint.
 *
 * Endpoint: `GET https://chatgpt.com/backend-api/wham/usage`
 * Headers : `Authorization: Bearer <accessToken>`,
 *           `ChatGPT-Account-Id: <openAIAccountId>`,
 *           `User-Agent: codex-cli`
 *
 * `used_percent` is already on the 0..100 scale. `reset_at` is epoch
 * seconds. Codex has no weekly equivalent, so `weeklyPct` stays undefined.
 */
export declare function pollCodexUsage(accessToken: string, accountId: string, fetchImpl?: FetchLike): Promise<UsageSnapshot>;
/**
 * Append a usage entry for the given `(providerId, accountId)` pair.
 * One line per call, written synchronously with mode 0o600. The day
 * directory is created on demand.
 */
export declare function recordCall(providerId: string, accountId: string, entry: Omit<UsageEntry, "ts">): void;
export interface DailyCounters {
    calls: number;
    tokens: number;
    errors: number;
}
/**
 * Read today's JSONL and aggregate `(calls, tokens, errors)`. Lines that
 * fail to parse are skipped silently (best-effort).
 */
export declare function readTodayCounters(providerId: string, accountId: string): DailyCounters;
export {};
//# sourceMappingURL=account-usage.d.ts.map
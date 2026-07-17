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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchCodexUsage } from "@elizaos/auth/codex-usage";
import { resolveStateDir } from "@elizaos/core";
import type { LinkedAccountUsage } from "@elizaos/shared/contracts/service-routing";

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

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
type FetchLike = typeof fetch;

function utilizationToPct(
  value: unknown,
  scaleFractional = true,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // Legacy flat fields used fractions, while current nested fields and limits
  // report percentage points (including 1.0 meaning 1%, not 100%).
  const percent =
    scaleFractional && value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

function normalizeResetTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: epoch seconds vs ms. Seconds will be ~1.7e9 today; ms is ~1.7e12.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface AnthropicUsageWindow {
  utilization?: number;
  resets_at?: string | number;
}

interface AnthropicUsageLimitScope {
  model?: { display_name?: string };
}

interface AnthropicUsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | number;
  scope?: AnthropicUsageLimitScope;
}

interface AnthropicUsagePayload {
  five_hour_utilization?: number;
  five_hour_resets_at?: string | number;
  seven_day_utilization?: number;
  seven_day_resets_at?: string | number;
  five_hour?: AnthropicUsageWindow;
  seven_day?: AnthropicUsageWindow;
  limits?: AnthropicUsageLimit[];
}

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
export async function pollAnthropicUsage(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  const res = await fetchImpl(ANTHROPIC_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic usage probe failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as AnthropicUsagePayload;

  const fiveHour = payload.five_hour;
  const sevenDay = payload.seven_day;
  const weeklyModelBuckets: NonNullable<UsageSnapshot["weeklyModelBuckets"]> =
    {};
  // The `limits` array is the least ambiguous part of the payload: its field
  // is literally named `percent` (0..100 percentage points). Prefer it as the
  // primary source for session/weekly percentages, cross-checked against a
  // live redacted payload (see account-usage.test.ts "parses the live 2026-07
  // payload"): `seven_day.utilization: 9.0` matches `weekly_all.percent: 9`,
  // confirming the nested windows also report percentage points, NOT
  // fractions. Only the legacy flat fields were fractional.
  let sessionLimitPct: number | undefined;
  let weeklyLimitPct: number | undefined;
  let weeklyLimitResetsAt: number | undefined;
  if (Array.isArray(payload.limits)) {
    for (const limit of payload.limits) {
      if (limit.kind === "session" && limit.group === "session") {
        sessionLimitPct ??= utilizationToPct(limit.percent, false);
        continue;
      }
      if (limit.kind === "weekly_all" && limit.group === "weekly") {
        weeklyLimitPct ??= utilizationToPct(limit.percent, false);
        weeklyLimitResetsAt ??= normalizeResetTimestamp(limit.resets_at);
        continue;
      }
      if (limit.kind !== "weekly_scoped" || limit.group !== "weekly") {
        continue;
      }
      const pct = utilizationToPct(limit.percent, false);
      if (pct === undefined) continue;
      const resetsAt = normalizeResetTimestamp(limit.resets_at);
      const modelName = limit.scope?.model?.display_name?.trim();
      if (modelName) {
        weeklyModelBuckets[modelName] = {
          pct,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        };
      }
    }
  }

  const sessionPct =
    sessionLimitPct ??
    utilizationToPct(fiveHour?.utilization, false) ??
    utilizationToPct(payload.five_hour_utilization);
  const weeklyPct =
    weeklyLimitPct ??
    utilizationToPct(sevenDay?.utilization, false) ??
    utilizationToPct(payload.seven_day_utilization);
  const resetsAt =
    weeklyLimitResetsAt ??
    normalizeResetTimestamp(sevenDay?.resets_at) ??
    normalizeResetTimestamp(payload.seven_day_resets_at);

  return {
    refreshedAt: Date.now(),
    ...(sessionPct !== undefined ? { sessionPct } : {}),
    ...(weeklyPct !== undefined ? { weeklyPct } : {}),
    ...(Object.keys(weeklyModelBuckets).length > 0
      ? { weeklyModelBuckets }
      : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Probe Codex / ChatGPT's usage endpoint via the canonical client
 * (`@elizaos/auth/codex-usage` — shared with the agent's inline Test probe).
 * The primary window is the 5h session; the secondary window is the 7-day
 * limit and maps to `weeklyPct` (same shape Anthropic exposes). Throws the
 * client's typed `ElizaError` on any transport/HTTP/parse/shape failure.
 */
export async function pollCodexUsage(
  accessToken: string,
  accountId: string,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  const usage = await fetchCodexUsage(accessToken, accountId, fetchImpl);
  return {
    refreshedAt: Date.now(),
    ...(usage.sessionPct !== undefined ? { sessionPct: usage.sessionPct } : {}),
    ...(usage.weeklyPct !== undefined ? { weeklyPct: usage.weeklyPct } : {}),
    ...(usage.resetsAt !== undefined ? { resetsAt: usage.resetsAt } : {}),
  };
}

// Local JSONL counters.

function dayStamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function counterFile(
  providerId: string,
  accountId: string,
  ts: number = Date.now(),
): string {
  return path.join(
    resolveStateDir(),
    "usage",
    providerId,
    accountId,
    `${dayStamp(ts)}.jsonl`,
  );
}

/**
 * Append a usage entry for the given `(providerId, accountId)` pair.
 * One line per call, written synchronously with mode 0o600. The day
 * directory is created on demand.
 */
export function recordCall(
  providerId: string,
  accountId: string,
  entry: Omit<UsageEntry, "ts">,
): void {
  const ts = Date.now();
  const line: UsageEntry = { ts, ...entry };
  const file = counterFile(providerId, accountId, ts);
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  appendFileSync(file, `${JSON.stringify(line)}\n`, {
    flag: "a",
    mode: 0o600,
  });
}

export interface DailyCounters {
  calls: number;
  tokens: number;
  errors: number;
}

/**
 * Read today's JSONL and aggregate `(calls, tokens, errors)`. Lines that
 * fail to parse are skipped silently (best-effort).
 */
export function readTodayCounters(
  providerId: string,
  accountId: string,
): DailyCounters {
  const file = counterFile(providerId, accountId);
  if (!existsSync(file)) {
    return { calls: 0, tokens: 0, errors: 0 };
  }
  const raw = readFileSync(file, "utf-8");
  let calls = 0;
  let tokens = 0;
  let errors = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: UsageEntry;
    try {
      parsed = JSON.parse(line) as UsageEntry;
    } catch {
      continue;
    }
    calls += 1;
    if (typeof parsed.tokens === "number" && Number.isFinite(parsed.tokens)) {
      tokens += parsed.tokens;
    }
    if (parsed.ok === false) {
      errors += 1;
    }
  }
  return { calls, tokens, errors };
}

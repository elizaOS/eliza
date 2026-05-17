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
import os from "node:os";
import path from "node:path";
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

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
type FetchLike = typeof fetch;

function utilizationToPct(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // Provider returns either 0..1 (legacy) or 0..100 — both are normalized
  // to percent. Anthropic ships 0..1, so we always multiply.
  return Math.max(0, Math.min(100, value * 100));
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

interface AnthropicUsagePayload {
  five_hour_utilization?: number;
  five_hour_resets_at?: string | number;
  seven_day_utilization?: number;
  seven_day_resets_at?: string | number;
  five_hour?: AnthropicUsageWindow;
  seven_day?: AnthropicUsageWindow;
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

  const sessionPct =
    utilizationToPct(fiveHour?.utilization) ??
    utilizationToPct(payload.five_hour_utilization);
  const weeklyPct =
    utilizationToPct(sevenDay?.utilization) ??
    utilizationToPct(payload.seven_day_utilization);
  const resetsAt =
    normalizeResetTimestamp(fiveHour?.resets_at) ??
    normalizeResetTimestamp(payload.five_hour_resets_at);

  return {
    refreshedAt: Date.now(),
    ...(sessionPct !== undefined ? { sessionPct } : {}),
    ...(weeklyPct !== undefined ? { weeklyPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

interface CodexUsagePayload {
  plan_type?: string;
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      reset_at?: number | string;
      limit_window_seconds?: number;
    };
  };
}

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
export async function pollCodexUsage(
  accessToken: string,
  accountId: string,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  const res = await fetchImpl(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "codex-cli",
    },
  });
  if (!res.ok) {
    throw new Error(`Codex usage probe failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as CodexUsagePayload;
  const primary = payload.rate_limit?.primary_window;

  let sessionPct: number | undefined;
  if (
    typeof primary?.used_percent === "number" &&
    Number.isFinite(primary.used_percent)
  ) {
    sessionPct = Math.max(0, Math.min(100, primary.used_percent));
  }
  const resetsAt = normalizeResetTimestamp(primary?.reset_at);

  return {
    refreshedAt: Date.now(),
    ...(sessionPct !== undefined ? { sessionPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// Local JSONL counters.

function elizaHome(): string {
  return process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza");
}

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
    elizaHome(),
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

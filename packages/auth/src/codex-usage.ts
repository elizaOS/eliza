/**
 * Canonical Codex (ChatGPT subscription) usage client.
 *
 * One place probes `chatgpt.com/backend-api/wham/usage` — the backend a
 * ChatGPT-subscription OAuth token actually authenticates against (NOT
 * api.openai.com, which bills the API platform and rejects subscription
 * tokens with billing errors). Consumed by app-core's `pollCodexUsage`
 * (pool usage refresh) and the agent's inline account Test probe, so the
 * two never drift apart again.
 *
 * Failure semantics follow the repo error policy: every transport / HTTP /
 * parse / shape failure throws a typed `ElizaError` — a failed usage read is
 * never fabricated as an empty-but-healthy snapshot. Fields that are merely
 * absent from a valid payload are legitimately optional and omitted.
 */

import { ElizaError } from "@elizaos/core";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Parsed rate-limit windows from a valid wham/usage payload. */
export interface CodexUsageSnapshot {
  /** Primary (5h session) window used percent, clamped to 0..100. */
  sessionPct?: number;
  /** Secondary (7-day) window used percent, clamped to 0..100. */
  weeklyPct?: number;
  /** Primary-window reset, epoch milliseconds. */
  resetsAt?: number;
  /** e.g. "plus" | "pro" — surfaced for display, never branched on. */
  planType?: string;
  /** Account email when the payload carries it. */
  email?: string;
}

function clampPct(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function normalizeResetTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: epoch seconds (~1.7e9 today) vs milliseconds (~1.7e12).
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Probe the Codex usage endpoint with a subscription access token.
 *
 * Headers: `Authorization: Bearer` + `ChatGPT-Account-Id` + the codex-cli
 * User-Agent (the endpoint rejects unknown clients). Throws a typed
 * `ElizaError` on any transport, HTTP, JSON, or shape failure; returns the
 * validated windows on success.
 */
export async function fetchCodexUsage(
  accessToken: string,
  accountId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexUsageSnapshot> {
  let response: Response;
  try {
    response = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Omitted (not sent empty) when the caller has no account id — e.g.
        // the inline Test probe against a record with no organizationId.
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        "User-Agent": "codex-cli",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — a usage read that never
    // completed is a failed probe, not a zero-usage account.
    throw new ElizaError("Codex usage request failed", {
      code: "codex_usage.request_failed",
      severity: "ephemeral",
      cause,
    });
  }

  if (!response.ok) {
    throw new ElizaError(
      `Codex usage request was rejected (HTTP ${response.status})`,
      {
        code: "codex_usage.http_error",
        severity: response.status >= 500 ? "ephemeral" : "fatal",
        context: { status: response.status },
      },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — malformed authenticated data is
    // a failed usage load, not a valid empty snapshot.
    throw new ElizaError("Codex usage response was not JSON", {
      code: "codex_usage.invalid_json",
      severity: "fatal",
      cause,
    });
  }

  if (!isRecord(payload)) {
    throw new ElizaError("Codex usage response was invalid", {
      code: "codex_usage.invalid_shape",
      severity: "fatal",
    });
  }
  const rateLimit = payload.rate_limit;
  if (rateLimit !== undefined && !isRecord(rateLimit)) {
    throw new ElizaError("Codex usage rate_limit was invalid", {
      code: "codex_usage.invalid_shape",
      severity: "fatal",
    });
  }
  // primary = the 5h session window (limit_window_seconds 18000);
  // secondary = the 7-day window (604800) — same split Anthropic exposes.
  const primary = isRecord(rateLimit) ? rateLimit.primary_window : undefined;
  const secondary = isRecord(rateLimit)
    ? rateLimit.secondary_window
    : undefined;
  if (primary !== undefined && !isRecord(primary)) {
    throw new ElizaError("Codex usage primary window was invalid", {
      code: "codex_usage.invalid_shape",
      severity: "fatal",
    });
  }
  if (secondary !== undefined && !isRecord(secondary)) {
    throw new ElizaError("Codex usage secondary window was invalid", {
      code: "codex_usage.invalid_shape",
      severity: "fatal",
    });
  }

  const sessionPct = clampPct(isRecord(primary) ? primary.used_percent : undefined);
  const weeklyPct = clampPct(
    isRecord(secondary) ? secondary.used_percent : undefined,
  );
  const resetsAt = normalizeResetTimestamp(
    isRecord(primary) ? primary.reset_at : undefined,
  );
  const planType =
    typeof payload.plan_type === "string" && payload.plan_type
      ? payload.plan_type
      : undefined;
  const email =
    typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email
      : undefined;

  return {
    ...(sessionPct !== undefined ? { sessionPct } : {}),
    ...(weeklyPct !== undefined ? { weeklyPct } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(planType !== undefined ? { planType } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

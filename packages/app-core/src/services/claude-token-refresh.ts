/**
 * Claude coding-spawn token lifetime helpers (recon gap #3).
 *
 * Claude coding sub-agents are spawned with a BARE `CLAUDE_CODE_OAUTH_TOKEN`
 * access token injected into the subprocess env. The third-party
 * `claude-agent-acp` adapter reads that env var ONCE at spawn and has no
 * refresh callback — and env re-exec of a running process is impossible — so a
 * session that outlives the injected token's remaining lifetime hits a mid-run
 * 401 even though the underlying account is perfectly healthy.
 *
 * Codex avoids this via a per-account `CODEX_HOME` the CLI self-refreshes into;
 * Claude's bare-token path has no equivalent. We cannot make the third-party
 * adapter refresh, so the safe floor (recon option "c") is:
 *
 *  1. PRE-SPAWN proactive refresh — hand Claude a token whose remaining TTL is
 *     at least the expected run duration, refreshing first if it is not.
 *  2. A TYPED expiry signal so a run that dies of injected-token expiry is
 *     distinguishable from a genuinely broken (needs-reauth) account.
 *
 * This module is PURE decision logic (no I/O, no token contents) so it is
 * unit-testable in isolation. The bridge wires the decision to the existing
 * `getAccessToken` refresh path (reuse-first, no second broker).
 *
 * SECURITY: never accept, return, or log an access-token STRING here. This
 * module works only with expiry epochs. Callers must never pass token material
 * in.
 */

/**
 * How long a freshly-injected Claude coding token is assumed to need to
 * survive, i.e. the longest run we proactively provision for. A run longer
 * than this can still expire mid-flight (the external adapter cannot refresh),
 * but it will emit the typed expiry signal below rather than a generic auth
 * failure.
 *
 * Set to 45 minutes DELIBERATELY below the effective lifetime of a
 * freshly-refreshed Anthropic token. Anthropic subscription access tokens live
 * ~1h and refreshAnthropicToken stores expires = now + expires_in - 5min, so a
 * just-refreshed token sits at ~55min remaining. If this threshold were >=55min,
 * getAccessToken (which returns the token only when expires > now +
 * minRemainingMs) would re-refresh on nearly EVERY spawn even for a perfectly
 * fresh token: needless latency and OAuth refresh/rate-limit risk. 45min leaves
 * a ~10min band above the fresh-token TTL so a fresh token is reused as-is,
 * while a token with under 45min left (already well into its life, at real risk
 * of aging out mid-run) is proactively refreshed.
 */
export const DEFAULT_CLAUDE_EXPECTED_RUN_MS = 45 * 60 * 1000;

/** Lower/upper clamps for an operator-supplied expected-run override (1min–6h). */
const MIN_EXPECTED_RUN_MS = 60 * 1000;
const MAX_EXPECTED_RUN_MS = 6 * 60 * 60 * 1000;

/**
 * Resolve the expected-run duration used as the pre-spawn refresh threshold.
 *
 * Reads `ELIZA_CLAUDE_EXPECTED_RUN_MS` (a positive integer count of
 * milliseconds) with the default fallback, clamped to a sane range so a
 * malformed/hostile value can neither disable the refresh (0/negative) nor
 * force a refresh on every single spawn (absurdly large). Returns the default
 * on anything non-numeric.
 */
export function resolveClaudeExpectedRunMs(
  read: (key: string) => string | undefined,
): number {
  const raw = read("ELIZA_CLAUDE_EXPECTED_RUN_MS")?.trim();
  if (!raw) return DEFAULT_CLAUDE_EXPECTED_RUN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CLAUDE_EXPECTED_RUN_MS;
  }
  return Math.min(Math.max(Math.floor(parsed), MIN_EXPECTED_RUN_MS), MAX_EXPECTED_RUN_MS);
}

/**
 * The minimum remaining lifetime a Claude coding token must have at injection
 * time. When `getAccessToken` is asked for a token with at least this much life
 * left, it refreshes rather than returning a token that would age out
 * mid-session. This is exactly the expected-run duration (a longer run than we
 * can provision for is handled by the typed expiry signal, not by refusing to
 * spawn).
 */
export function claudeMinRemainingMs(expectedRunMs: number): number {
  return expectedRunMs;
}

/**
 * Pure pre-spawn decision: given the injected token's expiry epoch (ms), should
 * we have proactively refreshed it? True when the remaining TTL is below the
 * expected run duration (including already-expired / unknown-expiry tokens).
 *
 * `expiresAtMs` null/undefined (unknown expiry) → refresh (fail-safe: never
 * assume an unknown token is fresh).
 */
export function shouldProactivelyRefreshClaudeToken(args: {
  expiresAtMs: number | null | undefined;
  nowMs: number;
  expectedRunMs: number;
}): boolean {
  const { expiresAtMs, nowMs, expectedRunMs } = args;
  if (expiresAtMs == null || !Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - nowMs < expectedRunMs;
}

export {
  classifyAuthFailureReason,
  type CodingAuthFailureReason,
  isTokenExpiryText,
} from "@elizaos/auth/token-expiry";

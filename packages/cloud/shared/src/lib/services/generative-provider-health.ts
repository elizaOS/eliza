/**
 * In-memory circuit breaker for long-running generative media providers
 * (music/audio upstreams such as fal and ElevenLabs). Consecutive breaker
 * eligible failures (upstream timeouts and 5xx) open a per provider+model gate
 * so routes can return an honest "backed up" 503 immediately instead of
 * holding a synchronous HTTP connection toward a multi-minute ceiling against
 * an upstream that is already known to be hanging (#18436).
 *
 * Config/contract failures (4xx, missing keys, unusable payloads) never trip
 * the breaker: a bad key must surface as a config error on every request, not
 * masquerade as a provider outage. State is per Worker isolate — the same
 * accepted tradeoff as the solana-rpc proxy breaker — so a cold isolate always
 * fails open and re-probes the upstream. After the cooldown the gate half
 * opens: traffic flows again, one further eligible failure reopens it, and one
 * success fully closes it.
 */

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 120_000;

export type GenerativeFailureKind = "timeout" | "upstream_error" | "config_error";

interface BreakerEntry {
  consecutiveFailures: number;
  openUntil: number;
  lastFailureKind?: GenerativeFailureKind;
}

const breakers = new Map<string, BreakerEntry>();

function entryFor(key: string): BreakerEntry {
  let entry = breakers.get(key);
  if (!entry) {
    entry = { consecutiveFailures: 0, openUntil: 0 };
    breakers.set(key, entry);
  }
  return entry;
}

/**
 * Classifies an upstream generation failure for breaker accounting from the
 * plain Error messages the fal-queue/audio providers throw. Timeouts and 5xx
 * count toward opening the gate; 4xx and configuration failures do not.
 */
export function classifyGenerativeFailure(error: unknown): GenerativeFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/not configured|missing .*key/i.test(message)) return "config_error";
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (status && status.startsWith("4")) return "config_error";
  return "upstream_error";
}

export interface GenerativeProviderHealth {
  degraded: boolean;
  retryAfterSeconds: number;
  lastFailureKind?: GenerativeFailureKind;
}

/** Returns the gate state for a provider+model key without mutating it. */
export function checkGenerativeProviderHealth(
  key: string,
  now: number = Date.now(),
): GenerativeProviderHealth {
  const entry = breakers.get(key);
  if (!entry || entry.openUntil <= now) {
    return { degraded: false, retryAfterSeconds: 0 };
  }
  return {
    degraded: true,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.openUntil - now) / 1000)),
    lastFailureKind: entry.lastFailureKind,
  };
}

/** Records a successful generation, fully closing the gate for the key. */
export function recordGenerativeSuccess(key: string): void {
  breakers.delete(key);
}

/**
 * Records a failed generation. Timeouts and upstream errors advance the
 * breaker (and reopen a half-open gate immediately); config errors leave the
 * breaker untouched so misconfiguration keeps failing loudly per request.
 * Returns the resulting gate state.
 */
export function recordGenerativeFailure(
  key: string,
  kind: GenerativeFailureKind,
  now: number = Date.now(),
): GenerativeProviderHealth {
  if (kind === "config_error") {
    return checkGenerativeProviderHealth(key, now);
  }
  const entry = entryFor(key);
  entry.consecutiveFailures += 1;
  entry.lastFailureKind = kind;
  if (entry.consecutiveFailures >= FAILURE_THRESHOLD) {
    entry.openUntil = now + OPEN_MS;
  }
  return checkGenerativeProviderHealth(key, now);
}

/** Test-only: clears all breaker state so cases stay order-independent. */
export function resetGenerativeProviderHealthForTests(): void {
  breakers.clear();
}

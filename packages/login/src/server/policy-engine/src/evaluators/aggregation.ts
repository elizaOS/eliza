// Privy-parity stateful aggregation policy evaluator.
//
// Gates a request on a rolling SERVER-SIDE aggregate of the agent's activity
// (value transferred, tx count, unique recipients) over a rolling window,
// optionally grouped per-recipient or per-chain. The aggregate is sourced from
// the authoritative provider on the evaluation context — NEVER from caller-
// supplied request fields. A malicious caller cannot lower the aggregate by
// putting a smaller number in the request body.
//
// FAIL CLOSED in every ambiguous case:
//   - no aggregation lookup wired on the context        → DENY
//   - the lookup has no snapshot for the bucket          → DENY
//   - USD denomination but no price oracle / no quote    → DENY
//   - malformed / negative / overflowing threshold       → DENY
//   - empty or non-positive window                       → DENY
//   - unknown metric / comparator / scope                → DENY
//
// Window boundary convention: a rolling window of S seconds at evaluation time
// `now` covers events with timestamp in the HALF-OPEN interval
// `(now - S*1000, now]` — i.e. an event exactly S seconds old has just aged
// out and is NOT counted, while an event at `now` IS counted. The provider is
// responsible for honouring the same boundary when it materialises the
// snapshot; this evaluator only documents and relies on it.

import type {
  AggregationComparator,
  AggregationConditionConfig,
  AggregationDenomination,
  AggregationMetric,
  AggregationScope,
  PolicyResult,
  PolicyRule,
  PriceOracle,
  SignRequest,
} from "../../../shared/src/index.ts";

const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;

/**
 * Resolved rolling-window query the evaluator hands to the provider/lookup.
 * Deterministic given (rule, request, now) so it is trivially testable.
 */
export interface AggregationQuery {
  agentId: string;
  tenantId: string;
  metric: AggregationMetric;
  /** Resolved positive window length in seconds. */
  windowSeconds: number;
  scope: AggregationScope;
  /**
   * Scope discriminator. Empty string for `agent` scope; lowercased recipient
   * address for `per_recipient`; decimal chainId for `per_chain`.
   */
  scopeKey: string;
}

/**
 * A point-in-time snapshot of the rolling aggregate, materialised by the
 * provider from authoritative data. All values are bigint to keep money math
 * exact:
 *   - value_sum         → sum of base units (wei/lamports) in the window
 *   - tx_count          → number of qualifying transactions in the window
 *   - unique_recipients → distinct `to` addresses in the window
 *
 * For USD-denominated `value_sum` conditions the evaluator does the conversion
 * itself via the oracle; the snapshot is always the raw base-unit sum.
 */
export interface AggregationSnapshot {
  /** The aggregate value over the resolved window, in raw integer units. */
  value: bigint;
}

/**
 * Synchronous lookup the evaluation context exposes. Returning `undefined`
 * means "the authoritative aggregate is unavailable" and the evaluator DENIES.
 * Implementations MUST precompute snapshots from server-side state (Redis
 * rolling counters / tx history) before evaluation — they must not derive the
 * value from the request.
 */
export type AggregationLookup = (
  query: AggregationQuery,
) => AggregationSnapshot | undefined;

export interface AggregationEvaluatorContext {
  request: SignRequest;
  /** Authoritative rolling-aggregate lookup. Absent → fail closed (deny). */
  aggregations?: AggregationLookup;
  /** Required for USD-denominated conditions; absent → fail closed (deny). */
  priceOracle?: PriceOracle;
  /** Evaluation timestamp in ms (defaults to Date.now()); injectable for tests. */
  now?: number;
}

const NAMED_WINDOW_SECONDS: Record<string, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

const VALID_METRICS: ReadonlySet<string> = new Set<AggregationMetric>([
  "value_sum",
  "tx_count",
  "unique_recipients",
]);

const VALID_SCOPES: ReadonlySet<string> = new Set<AggregationScope>([
  "agent",
  "per_recipient",
  "per_chain",
]);

const VALID_COMPARATORS: ReadonlySet<string> = new Set<AggregationComparator>([
  "lte",
  "lt",
  "gte",
  "gt",
  "eq",
]);

const VALID_DENOMINATIONS: ReadonlySet<string> =
  new Set<AggregationDenomination>(["raw", "usd"]);

/**
 * Parse a non-negative decimal integer string into bigint, rejecting anything
 * that is not a clean base-10 non-negative integer within uint256 range.
 * Reused for the threshold so a caller cannot smuggle floats, signs, hex, or
 * absurdly large values past the gate. Returns null on any violation → deny.
 */
function parseNonNegativeIntString(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return null;
  if (
    normalized.length === MAX_UINT256_DECIMAL_DIGITS &&
    normalized > MAX_UINT256_DECIMAL
  ) {
    return null;
  }
  return BigInt(normalized);
}

/** Resolve the configured window to a positive integer number of seconds. */
function resolveWindowSeconds(
  config: AggregationConditionConfig,
): number | null {
  const window = config.window;
  if (!window || typeof window !== "object") return null;

  if (window.seconds !== undefined) {
    if (
      typeof window.seconds !== "number" ||
      !Number.isSafeInteger(window.seconds) ||
      window.seconds <= 0
    ) {
      return null;
    }
    return window.seconds;
  }

  if (window.named !== undefined) {
    // Prototype-key safe lookup (SEC-106): `NAMED_WINDOW_SECONDS["__proto__"]`
    // on a plain object returns Object.prototype — an object, not null — which
    // would escape the "unknown window → deny" contract below. hasOwn restricts
    // to own keys and the finite check guarantees the number|null return type.
    if (
      typeof window.named !== "string" ||
      !Object.hasOwn(NAMED_WINDOW_SECONDS, window.named)
    ) {
      return null;
    }
    const seconds = NAMED_WINDOW_SECONDS[window.named];
    return typeof seconds === "number" && Number.isFinite(seconds)
      ? seconds
      : null;
  }

  return null;
}

/** Derive the scope discriminator from the request for the configured scope. */
function resolveScopeKey(
  scope: AggregationScope,
  request: SignRequest,
): string | null {
  switch (scope) {
    case "agent":
      return "";
    case "per_recipient": {
      const to = request.to;
      if (typeof to !== "string" || to.length === 0) return null;
      return to.toLowerCase();
    }
    case "per_chain": {
      const chainId = request.chainId;
      if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
      return String(chainId);
    }
    default:
      return null;
  }
}

/**
 * Contribution of the *current* request toward the aggregate, in raw base
 * units. Only `value_sum` has a non-trivial contribution; tx_count and
 * unique_recipients are evaluated against the already-recorded aggregate (the
 * in-flight request is reflected once it is committed by the provider).
 *
 * Returns null when the request value cannot be parsed as a uint256 — deny,
 * because a value_sum cap must never be evaluated against an unparseable value.
 */
function requestContribution(
  metric: AggregationMetric,
  request: SignRequest,
): bigint | null {
  if (metric !== "value_sum") return 0n;
  return parseNonNegativeIntString(request.value);
}

function compare(
  aggregate: bigint,
  comparator: AggregationComparator,
  threshold: bigint,
): boolean {
  switch (comparator) {
    case "lte":
      return aggregate <= threshold;
    case "lt":
      return aggregate < threshold;
    case "gte":
      return aggregate >= threshold;
    case "gt":
      return aggregate > threshold;
    case "eq":
      return aggregate === threshold;
    default:
      return false;
  }
}

/**
 * Convert a raw base-unit sum to integer USD cents using the oracle. Returns
 * null when the oracle cannot price the chain (→ deny). We compute dollars as a
 * float via the oracle then convert to integer cents with rounding; the cents
 * value is then compared as bigint so the threshold comparison stays exact.
 */
async function rawToUsdCents(
  rawUnits: bigint,
  chainId: number,
  oracle: PriceOracle,
): Promise<bigint | null> {
  const usd = await oracle.weiToUsd(rawUnits.toString(), chainId);
  if (usd === null || !Number.isFinite(usd) || usd < 0) return null;
  // Round to nearest cent; guard against precision blowups for huge sums.
  const cents = Math.round(usd * 100);
  if (!Number.isFinite(cents)) return null;
  return BigInt(cents);
}

/**
 * Evaluate a single aggregation condition. Pure aside from the optional async
 * oracle call required by USD denomination.
 */
export async function evaluateAggregation(
  rule: PolicyRule,
  ctx: AggregationEvaluatorContext,
): Promise<PolicyResult> {
  const config = rule.config as unknown as AggregationConditionConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  const metric = config.metric;
  if (typeof metric !== "string" || !VALID_METRICS.has(metric)) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: unknown metric ${String(metric)}`,
    };
  }

  const comparator = config.comparator;
  if (typeof comparator !== "string" || !VALID_COMPARATORS.has(comparator)) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: unknown comparator ${String(comparator)}`,
    };
  }

  const scope: AggregationScope = config.scope ?? "agent";
  if (!VALID_SCOPES.has(scope)) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: unknown scope ${String(scope)}`,
    };
  }

  const denomination: AggregationDenomination = config.denomination ?? "raw";
  if (!VALID_DENOMINATIONS.has(denomination)) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: unknown denomination ${String(denomination)}`,
    };
  }
  // USD only makes sense for a value metric.
  if (denomination === "usd" && metric !== "value_sum") {
    return {
      ...base,
      passed: false,
      reason: "aggregation: usd denomination is only valid for value_sum",
    };
  }

  const threshold = parseNonNegativeIntString(config.threshold);
  if (threshold === null) {
    return {
      ...base,
      passed: false,
      reason:
        "aggregation: threshold must be a non-negative uint256 decimal string",
    };
  }

  const windowSeconds = resolveWindowSeconds(config);
  if (windowSeconds === null) {
    return {
      ...base,
      passed: false,
      reason:
        "aggregation: window must be a known name or a positive integer of seconds",
    };
  }

  const scopeKey = resolveScopeKey(scope, ctx.request);
  if (scopeKey === null) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: cannot resolve ${scope} scope key from request`,
    };
  }

  // Authoritative aggregate. Absent lookup or absent snapshot → fail closed.
  if (typeof ctx.aggregations !== "function") {
    return {
      ...base,
      passed: false,
      reason: "aggregation: no aggregate provider available for evaluation",
    };
  }

  const query: AggregationQuery = {
    agentId: ctx.request.agentId,
    tenantId: ctx.request.tenantId,
    metric,
    windowSeconds,
    scope,
    scopeKey,
  };

  const snapshot = ctx.aggregations(query);
  if (!snapshot || typeof snapshot.value !== "bigint" || snapshot.value < 0n) {
    return {
      ...base,
      passed: false,
      reason: "aggregation: authoritative aggregate unavailable",
    };
  }

  const contribution = requestContribution(metric, ctx.request);
  if (contribution === null) {
    return {
      ...base,
      passed: false,
      reason:
        "aggregation: transaction value must be a uint256 base-unit string",
    };
  }

  // Projected aggregate including this request's contribution (bigint — no
  // float drift, no overflow: bigint is arbitrary precision).
  let projected = snapshot.value + contribution;
  let effectiveThreshold = threshold;

  if (denomination === "usd") {
    if (!ctx.priceOracle) {
      return {
        ...base,
        passed: false,
        reason:
          "aggregation: usd condition cannot be evaluated without a price oracle",
      };
    }
    const chainId = ctx.request.chainId;
    const projectedCents = await rawToUsdCents(
      projected,
      chainId,
      ctx.priceOracle,
    );
    if (projectedCents === null) {
      return {
        ...base,
        passed: false,
        reason: `aggregation: usd condition cannot be priced for chain ${chainId}`,
      };
    }
    projected = projectedCents;
    // threshold already interpreted as integer cents for usd conditions.
    effectiveThreshold = threshold;
  }

  const denyConditionHolds = compare(projected, comparator, effectiveThreshold);
  const unit = denomination === "usd" ? "¢" : "";
  if (denyConditionHolds) {
    return {
      ...base,
      passed: false,
      reason: `aggregation: ${metric} over ${windowSeconds}s (${scope}) = ${projected}${unit} ${comparator} threshold ${effectiveThreshold}${unit}`,
    };
  }

  return {
    ...base,
    passed: true,
    reason: `aggregation: ${metric} over ${windowSeconds}s (${scope}) = ${projected}${unit} within threshold ${effectiveThreshold}${unit}`,
  };
}

/**
 * Build a stable string key for an {@link AggregationQuery}. Used by callers
 * that precompute snapshots into a map and then expose a synchronous
 * {@link AggregationLookup} over it (the evaluator must stay synchronous while
 * the real provider is async).
 */
export function aggregationQueryKey(query: AggregationQuery): string {
  return [
    query.agentId,
    query.metric,
    query.windowSeconds,
    query.scope,
    query.scopeKey,
  ].join("|");
}

/**
 * Resolve the deterministic set of {@link AggregationQuery} a policy set needs
 * for a given request. Returns only the queries for well-formed `aggregation`
 * policies; malformed ones are skipped here and re-validated (and denied) by
 * the evaluator. A caller materialises a snapshot for each query, builds a map
 * keyed by {@link aggregationQueryKey}, and passes a synchronous lookup over it
 * as `ctx.aggregations`.
 */
export function aggregationQueriesForPolicies(
  policies: PolicyRule[],
  request: SignRequest,
): AggregationQuery[] {
  const out: AggregationQuery[] = [];
  const seen = new Set<string>();

  for (const rule of policies) {
    if (rule.type !== "aggregation" || !rule.enabled) continue;
    const config = rule.config as unknown as AggregationConditionConfig;

    const metric = config.metric;
    if (typeof metric !== "string" || !VALID_METRICS.has(metric)) continue;

    const scope: AggregationScope = config.scope ?? "agent";
    if (!VALID_SCOPES.has(scope)) continue;

    const windowSeconds = resolveWindowSeconds(config);
    if (windowSeconds === null) continue;

    const scopeKey = resolveScopeKey(scope, request);
    if (scopeKey === null) continue;

    const query: AggregationQuery = {
      agentId: request.agentId,
      tenantId: request.tenantId,
      metric: metric as AggregationMetric,
      windowSeconds,
      scope,
      scopeKey,
    };
    const key = aggregationQueryKey(query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }

  return out;
}

/**
 * Convenience: build a synchronous {@link AggregationLookup} from a precomputed
 * map of `aggregationQueryKey(query) → bigint`. A missing entry yields
 * `undefined`, which makes the evaluator fail closed (deny).
 */
export function aggregationLookupFromMap(
  snapshots: ReadonlyMap<string, bigint>,
): AggregationLookup {
  return (query) => {
    const value = snapshots.get(aggregationQueryKey(query));
    if (value === undefined) return undefined;
    return { value };
  };
}

export { NAMED_WINDOW_SECONDS, resolveScopeKey, resolveWindowSeconds };

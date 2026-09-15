import { logger } from "@elizaos/logger";
import {
  type PolicyResult,
  type PolicyRule,
  type PriceOracle,
  redactedThrownDiagnostics,
  type SignRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "../../shared/src/index.ts";
import { type EvaluatorContext, evaluatePolicy } from "./evaluators";
import type { AggregationLookup } from "./evaluators/aggregation";
import {
  type ManualApprovalSignal,
  resultRequiresManualApproval,
} from "./manual-approval";

/**
 * Policy results as produced internally by the engine. Identical to the public
 * `PolicyResult` shape plus the optional, engine-honoured `requiresManualApproval`
 * signal (see `./manual-approval`). The extra property is optional and
 * structurally compatible, so these values are still valid `PolicyResult`s when
 * surfaced on `EvaluationResult.results`.
 */
type EnginePolicyResult = PolicyResult & ManualApprovalSignal;

export interface TransactionSimulationRequest extends SignRequest {
  kind?: "transaction";
}

export interface ProxySimulationRequest {
  kind: "proxy";
  method: string;
  url: string;
  body?: unknown;
  data?: unknown;
  value?: string;
  chainId?: number;
}

export type PolicySimulationRequest =
  | TransactionSimulationRequest
  | ProxySimulationRequest;

export interface PolicyEvaluationContext {
  request: SignRequest;
  recentTxCount24h: number;
  recentTxCount1h: number;
  /**
   * Rolling spend sums in the base unit of `request.chainId` ONLY. Callers
   * MUST scope these counters to the request's chain — a cross-chain sum
   * mixes incomparable units (wei/lamports/piconero) and corrupts both the
   * wei caps and the USD-priced caps (SEC-039).
   */
  spentToday: bigint;
  spentThisWeek: bigint;
  /** Cross-rail USD spend, kept separate from chain-native counters. */
  additionalUsdSpentTodayMicros?: bigint;
  additionalUsdSpentThisWeekMicros?: bigint;
  /** Optional price oracle for USD-based policy evaluation */
  priceOracle?: PriceOracle;
  /** Optional reputation score for reputation-based policies */
  reputationScore?: number;
  /** Sprint 4: trading venue (for `venue-allowlist`). */
  venue?: string;
  /** Sprint 4: requested leverage multiple (for `leverage-cap`). */
  leverage?: number;
  /** Sprint 4: pre-computed USD value of the action. */
  valueUsd?: number;
  /**
   * Privy-style condition set items keyed by conditionSetId. Callers load these
   * from tenant-scoped storage before evaluating policies.
   */
  conditionSets?: Record<string, string[]>;
  /**
   * Authoritative rolling-aggregate lookup for `aggregation` policies. The API
   * wires this from a Redis-backed provider before evaluating; when absent,
   * aggregation policies fail closed (deny).
   */
  aggregations?: AggregationLookup;
  /**
   * Decoded EIP-712 typed-data payload for `typed-data` policies. The API wires
   * this from the validated sign-typed-data request body; absent on ordinary
   * transaction signs.
   */
  typedData?: {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    value: Record<string, unknown>;
  };
  rawSigning?: {
    chain: string;
    curve: string;
  };
  /**
   * Capability-invoke context for `capability-intent` policies. The capability
   * invoke route (W-1c) wires this from the resolved capability; absent on
   * ordinary transaction signs, so capability policies stay inert on tx signing
   * (mirrors the `typedData` seam).
   */
  capability?: {
    name: string;
    args: Record<string, unknown>;
    host: string;
    path: string;
    method: string;
  };
  /**
   * Trailing-hour capability-invoke count (distinct from `recentTxCount1h`). The
   * invoke route (W-1c) wires this so `capability-intent`'s `maxCallsPerHour`
   * constraint can be enforced; absent => that constraint fails closed (deny).
   */
  capabilityInvokeCount1h?: number;
}

export interface EvaluationResult {
  approved: boolean;
  results: PolicyResult[];
  requiresManualApproval: boolean;
}

function isProxyRequest(
  request: PolicySimulationRequest,
): request is ProxySimulationRequest {
  return (
    request.kind === "proxy" ||
    ("method" in request && "url" in request && !("to" in request))
  );
}

function extractProxyValue(request: ProxySimulationRequest): string {
  if (request.value !== undefined) return String(request.value);

  const candidates = [request.body, request.data];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && "value" in candidate) {
      const value = (candidate as { value?: unknown }).value;
      if (value !== undefined && value !== null) return String(value);
    }
  }

  return "0";
}

/**
 * `policy.evaluated` audit event.
 *
 * Engine emits one of these per `evaluate()` call when an audit hook is
 * attached. The shape is intentionally JSON-serialisable so callers can
 * persist it as a row in any audit log table without further mapping.
 * Contains no private keys, no SIWE signatures, no oracle internals.
 */
export interface PolicyEvaluatedEvent {
  event: "policy.evaluated";
  agentId: string;
  tenantId: string;
  venue?: string;
  leverage?: number;
  verdict: "ALLOW" | "NACK" | "NEEDS_MANUAL";
  results: PolicyResult[];
  /** Caller-provided correlation id (e.g. trade-session id, request id). */
  correlationId?: string;
  timestamp: string;
}

export type AuditHook = (event: PolicyEvaluatedEvent) => void | Promise<void>;

export interface PolicyEngineOptions {
  /**
   * Sprint 4: optional sink for `policy.evaluated` audit events. Trade-
   * sessions wires this to the proxy audit log so every evaluation is
   * traceable to its inputs and verdict. Failures inside the hook are
   * swallowed so they don't block the trade — but counted on
   * `auditHookFailures` and logged, so a persistently failing hook cannot
   * silently disable the audit trail (SEC-104).
   */
  auditHook?: AuditHook;
}

/**
 * Policy Engine — evaluates a set of policy rules against a transaction request.
 *
 * Logic:
 * - All enabled policies must pass for auto-approval
 * - If auto-approve-threshold fails but all other policies pass, tx is queued for manual approval
 * - If any hard policy (spending-limit, approved-addresses, rate-limit, time-window) fails, tx is rejected
 */
export class PolicyEngine {
  private readonly auditHook?: AuditHook;
  private auditHookFailureCount = 0;

  constructor(options: PolicyEngineOptions = {}) {
    if (options.auditHook) this.auditHook = options.auditHook;
  }

  /**
   * Number of audit-hook failures swallowed since engine construction. A
   * growing count means the policy audit trail is silently going dark — hook
   * failures must never block a trade, but they must not be invisible either
   * (SEC-104).
   */
  get auditHookFailures(): number {
    return this.auditHookFailureCount;
  }

  /**
   * Evaluate all policies for an agent's transaction request.
   *
   * Now async to support USD-based evaluations that require price oracle lookups.
   */
  async evaluate(
    policies: PolicyRule[],
    ctx: PolicyEvaluationContext & { correlationId?: string },
  ): Promise<EvaluationResult> {
    if (policies.length === 0) {
      // "No policies configured" is a deny and MUST be audited like any other
      // — returning before emitAuditEvent leaves no trace of the rejection
      // (SEC-104).
      const evaluationResult = {
        approved: false,
        results: [],
        requiresManualApproval: false,
      };
      await this.emitAuditEvent(ctx, [], evaluationResult);
      return evaluationResult;
    }

    const evaluatorCtx: EvaluatorContext = {
      request: ctx.request,
      recentTxCount24h: ctx.recentTxCount24h,
      recentTxCount1h: ctx.recentTxCount1h,
      spentToday: ctx.spentToday,
      spentThisWeek: ctx.spentThisWeek,
      additionalUsdSpentTodayMicros: ctx.additionalUsdSpentTodayMicros,
      additionalUsdSpentThisWeekMicros: ctx.additionalUsdSpentThisWeekMicros,
      priceOracle: ctx.priceOracle,
      reputationScore: ctx.reputationScore,
      venue: ctx.venue,
      leverage: ctx.leverage,
      valueUsd: ctx.valueUsd,
      conditionSets: ctx.conditionSets,
      aggregations: ctx.aggregations,
      typedData: ctx.typedData,
      rawSigning: ctx.rawSigning,
      capability: ctx.capability,
      capabilityInvokeCount1h: ctx.capabilityInvokeCount1h,
    };

    // SEC-104: an evaluator throw rejects `Promise.all` past the audit call
    // below, erasing the denial from the audit trail. Emit a NACK event before
    // propagating so even a 500-surfacing failure stays traceable. (SEC-105
    // makes config-malformation a structured deny; this catch is the residual
    // guard for unexpected evaluator bugs.)
    let results: EnginePolicyResult[];
    try {
      results = await Promise.all(
        policies.map((policy) => evaluatePolicy(policy, evaluatorCtx)),
      );
    } catch (err) {
      await this.emitAuditEvent(ctx, [], {
        approved: false,
        results: [],
        requiresManualApproval: false,
      });
      throw err;
    }

    // Same falsy check as evaluatePolicy: a rule with `enabled: undefined`/
    // null/0 is disabled for pass purposes, so an all-such policy set hits
    // this deny-all branch instead of auto-approving everything (SEC-103).
    if (policies.every((policy) => !policy.enabled)) {
      const evaluationResult = {
        approved: false,
        results,
        requiresManualApproval: false,
      };
      await this.emitAuditEvent(ctx, results, evaluationResult);
      return evaluationResult;
    }

    const hardPolicies = results.filter(
      (r) => r.type !== "auto-approve-threshold",
    );
    const autoApproveResults = results.filter(
      (r) => r.type === "auto-approve-threshold",
    );

    // A hard policy either passed, failed-soft (explicitly requesting manual
    // review), or failed-hard. The engine treats these three distinctly:
    //   - any hard-fail            ⇒ outright reject (default-deny preserved)
    //   - no hard-fail, but ≥1 soft ⇒ route to manual approval
    //   - all pass                 ⇒ proceed to the auto-approve check
    // `resultRequiresManualApproval` returns true ONLY for a non-passing result
    // that explicitly opted in, so a plain failure (block, default-deny,
    // missing inputs, unknown policy type) always counts as a hard-fail and
    // cannot be upgraded to "needs manual approval".
    const hardFailed = hardPolicies.some(
      (r) => !r.passed && !resultRequiresManualApproval(r),
    );
    const allHardPass = hardPolicies.every((r) => r.passed);

    const autoApprovePass =
      autoApproveResults.length === 0 ||
      autoApproveResults.every((r) => r.passed);

    let evaluationResult: EvaluationResult;
    if (hardFailed) {
      // A hard policy failed without requesting manual review - reject.
      evaluationResult = {
        approved: false,
        results,
        requiresManualApproval: false,
      };
    } else if (allHardPass && autoApprovePass) {
      evaluationResult = {
        approved: true,
        results,
        requiresManualApproval: false,
      };
    } else {
      // No hard failure, but either a hard policy requested manual review
      // (e.g. reputation-threshold `require-approval`) and/or the value exceeds
      // the auto-approve threshold. Queue for manual approval rather than deny.
      evaluationResult = {
        approved: false,
        results,
        requiresManualApproval: true,
      };
    }

    await this.emitAuditEvent(ctx, results, evaluationResult);
    return evaluationResult;
  }

  private async emitAuditEvent(
    ctx: PolicyEvaluationContext & { correlationId?: string },
    results: PolicyResult[],
    evaluation: EvaluationResult,
  ): Promise<void> {
    if (!this.auditHook) return;
    const verdict: PolicyEvaluatedEvent["verdict"] = evaluation.approved
      ? "ALLOW"
      : evaluation.requiresManualApproval
        ? "NEEDS_MANUAL"
        : "NACK";
    const event: PolicyEvaluatedEvent = {
      event: "policy.evaluated",
      agentId: ctx.request.agentId,
      tenantId: ctx.request.tenantId,
      ...(ctx.venue !== undefined ? { venue: ctx.venue } : {}),
      ...(ctx.leverage !== undefined ? { leverage: ctx.leverage } : {}),
      verdict,
      results,
      ...(ctx.correlationId !== undefined
        ? { correlationId: ctx.correlationId }
        : {}),
      timestamp: new Date().toISOString(),
    };
    try {
      await this.auditHook(event);
    } catch (err) {
      // Audit failures must never block a trade. The engine swallows, but not
      // silently (SEC-104): count and log every failure so a persistently
      // failing hook is visible to operators instead of quietly disabling the
      // whole policy audit trail.
      this.auditHookFailureCount += 1;
      logger.warn(
        {
          details: [
            `[steward] policy audit hook failed (${this.auditHookFailureCount} since engine start); policy.evaluated events are being dropped`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:engine] warn",
      );
    }
  }

  /**
   * Evaluate policy simulation input. Transaction requests use the full policy set;
   * proxy/API-call requests only apply rate/spend style controls that are meaningful
   * without an on-chain recipient.
   */
  async simulate(
    policies: PolicyRule[],
    ctx: Omit<PolicyEvaluationContext, "request"> & {
      request: PolicySimulationRequest;
    },
  ): Promise<EvaluationResult> {
    if (!isProxyRequest(ctx.request)) {
      const { kind: _kind, ...request } = ctx.request;
      return this.evaluate(policies, { ...ctx, request });
    }

    const proxyPolicies = policies.filter((policy) =>
      ["rate-limit", "spending-limit", "auto-approve-threshold"].includes(
        policy.type,
      ),
    );

    const syntheticRequest: SignRequest = {
      agentId: "proxy-simulation",
      tenantId: "proxy-simulation",
      to: "0x0000000000000000000000000000000000000000",
      value: extractProxyValue(ctx.request),
      data: typeof ctx.request.data === "string" ? ctx.request.data : undefined,
      chainId: ctx.request.chainId ?? 84532,
    };

    return this.evaluate(proxyPolicies, { ...ctx, request: syntheticRequest });
  }
}

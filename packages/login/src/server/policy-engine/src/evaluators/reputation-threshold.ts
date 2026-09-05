/**
 * Reputation-threshold policy evaluator.
 *
 * Gates transactions based on the agent's reputation score.
 * If no score is available in context, falls back to the configured fallbackAction.
 *
 * Each configurable action maps to a distinct engine outcome when the score is
 * below `minScore` (or when no score is available and `fallbackAction` applies):
 *   - `approve`          → `passed: true` (the policy does not block this tx).
 *                         EXCEPTION: as a `fallbackAction` with NO score wired
 *                         it fails closed (deny) — otherwise every rule is a
 *                         hidden default-allow while no score source exists
 *                         (SEC-040).
 *   - `require-approval` → `passed: false` + `requiresManualApproval: true`
 *                          (the engine routes the tx to the manual-approval
 *                          queue instead of hard-rejecting it).
 *   - `block`            → `passed: false` (hard deny).
 *   - anything else      → `passed: false` (fail closed / hard deny).
 *
 * `requiresManualApproval` is an engine-internal signal (see
 * `ManualApprovalSignal` / `engine.ts`); it is structurally compatible with the
 * public `PolicyResult` shape so it never leaks into persisted/serialised
 * results, but the engine honours it for non-`auto-approve-threshold` policies.
 */

import type { PolicyResult, PolicyRule } from "../../../shared/src/index.ts";
import type { ManualApprovalSignal } from "../manual-approval";

export interface ReputationThresholdConfig {
  minScore: number;
  action: "approve" | "require-approval" | "block";
  source: "internal" | "onchain" | "combined";
  fallbackAction: "approve" | "require-approval" | "block";
}

export interface ReputationThresholdContext {
  reputationScore?: number;
}

type ReputationThresholdAction = ReputationThresholdConfig["action"];

const REPUTATION_ACTIONS = new Set<ReputationThresholdAction>([
  "approve",
  "require-approval",
  "block",
]);
const REPUTATION_SOURCES = new Set<ReputationThresholdConfig["source"]>([
  "internal",
  "onchain",
  "combined",
]);

function isValidConfig(config: unknown): config is ReputationThresholdConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config))
    return false;
  const candidate = config as Partial<ReputationThresholdConfig>;
  return (
    typeof candidate.minScore === "number" &&
    Number.isFinite(candidate.minScore) &&
    candidate.minScore >= 0 &&
    candidate.minScore <= 100 &&
    REPUTATION_ACTIONS.has(candidate.action as ReputationThresholdAction) &&
    REPUTATION_SOURCES.has(
      candidate.source as ReputationThresholdConfig["source"],
    ) &&
    REPUTATION_ACTIONS.has(
      candidate.fallbackAction as ReputationThresholdAction,
    )
  );
}

/**
 * Translate a configured action into a policy result for the case where the
 * reputation gate did NOT clear (score below minimum, or fallback applies).
 *
 * Fails closed: only the explicit `approve` and `require-approval` actions get
 * non-deny treatment; `block` and any unrecognised/missing action deny.
 */
function resultForUnmetThreshold(
  base: { policyId: string; type: PolicyRule["type"] },
  action: ReputationThresholdAction | undefined,
  reason: string,
): PolicyResult & ManualApprovalSignal {
  if (action === "approve") {
    return { ...base, passed: true, reason };
  }
  if (action === "require-approval") {
    // Not auto-approved, but not a hard deny either: route to manual review.
    return { ...base, passed: false, requiresManualApproval: true, reason };
  }
  // "block" and any unknown/missing action → hard deny (fail closed).
  return { ...base, passed: false, reason };
}

export function evaluateReputationThreshold(
  rule: PolicyRule,
  ctx: ReputationThresholdContext,
): PolicyResult & ManualApprovalSignal {
  const base = { policyId: rule.id, type: rule.type } as const;
  const config: unknown = rule.config;

  // Policy rows can predate current write-time validation or be edited outside
  // the API. Mirror that validation at the authority boundary so malformed
  // persisted data cannot default-allow or throw during evaluation.
  if (!isValidConfig(config)) {
    return {
      ...base,
      passed: false,
      reason: "Malformed reputation-threshold configuration",
    };
  }

  if (ctx.reputationScore === undefined || ctx.reputationScore === null) {
    // No score available. FAIL CLOSED on an `approve` fallback: no caller in
    // the API wires a reputation score, so honoring `fallbackAction:
    // "approve"` would make every reputation-threshold rule a silent
    // default-allow (SEC-040). Manual-review and block fallbacks keep their
    // semantics.
    if (config.fallbackAction === "approve") {
      return {
        ...base,
        passed: false,
        reason:
          'No reputation score available; fallbackAction "approve" is not permitted without a wired score (fail closed)',
      };
    }
    return resultForUnmetThreshold(
      base,
      config.fallbackAction,
      `No reputation score available; fallback action: ${config.fallbackAction}`,
    );
  }

  // Reputation scores are supplied by an external authority. Never let NaN,
  // Infinity, or an out-of-contract value influence an authorization decision.
  if (
    typeof ctx.reputationScore !== "number" ||
    !Number.isFinite(ctx.reputationScore) ||
    ctx.reputationScore < 0 ||
    ctx.reputationScore > 100
  ) {
    return { ...base, passed: false, reason: "Invalid reputation score" };
  }

  if (ctx.reputationScore >= config.minScore) {
    return {
      ...base,
      passed: true,
      reason: `Reputation score ${ctx.reputationScore} meets minimum ${config.minScore}`,
    };
  }

  return resultForUnmetThreshold(
    base,
    config.action,
    `Reputation score ${ctx.reputationScore} below minimum ${config.minScore} (action: ${config.action})`,
  );
}

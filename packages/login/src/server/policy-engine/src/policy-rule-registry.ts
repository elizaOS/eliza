/**
 * policy-rule-registry.ts — a runtime-extensible registry of plugin-contributed
 * policy-rule evaluators.
 *
 * WHY THIS EXISTS
 * ---------------
 * the core's policy dispatch (`evaluatePolicy` in ./evaluators.ts) is a closed
 * `switch (rule.type)` over the ~16 core rule types, with a `default:` that denies
 * an unknown type. that is correct for the core's own rules, but a PLUGIN that
 * owns its own rule type (e.g. a venue-specific gate) cannot have that type
 * evaluated: it falls into `default:` and is denied as "Unknown policy type".
 *
 * Phase 2b of the plugin SDK lets a plugin DECLARE a rule type + evaluator
 * (`StewardPlugin.policyRules`). the plugin host registers those evaluators HERE
 * at composition time. `evaluatePolicy`'s `default:` consults this registry BEFORE
 * returning "Unknown policy type": if a plugin registered an evaluator for the
 * rule's type, that evaluator runs; otherwise the deny is unchanged.
 *
 * IMPORTANT — CORE BEHAVIOR IS UNTOUCHED. the 16 core `case` arms are not changed
 * in any way; the registry is consulted ONLY in the `default:` arm, i.e. ONLY for
 * a rule type that is not a core type. a core policy decision is byte-identical
 * before and after this phase. the registry can never shadow a core rule type:
 * registration FAILS CLOSED (throws) on a `type` that is a core type or that a
 * prior plugin already registered.
 *
 * This is a process-wide module singleton (the {@link policyRuleRegistry} export)
 * so the free `evaluatePolicy` function and the `PolicyEngine` both see the same
 * registered evaluators. The plugin host populates it at the composition root.
 * Tests that want isolation can construct their own {@link PolicyRuleRegistry}
 * and route through it, or use {@link policyRuleRegistry} and clear it.
 */

import type {
  ContributedPolicyResult,
  ContributedPolicyRule,
  PolicyResult,
  PolicyRule,
} from "../../shared/src/index.ts";
import { describeThrown } from "../../shared/src/index.ts";
import type { EvaluatorContext } from "./evaluators";
import type { ManualApprovalSignal } from "./manual-approval";

/**
 * The set of rule-type discriminators the CORE owns. A plugin may NOT register an
 * evaluator for any of these — doing so would let a plugin shadow a money-rail
 * policy decision, which is exactly what we forbid. Kept in sync with the
 * `switch (rule.type)` arms in ./evaluators.ts and the `PolicyType` union in
 * `@stwd/shared`.
 */
export const CORE_POLICY_RULE_TYPES: ReadonlySet<string> = new Set([
  "spending-limit",
  "approved-addresses",
  "auto-approve-threshold",
  "time-window",
  "rate-limit",
  "allowed-chains",
  "condition-set",
  "aggregation",
  "contract-allowlist",
  "typed-data",
  "raw-signing-chain",
  "reputation-threshold",
  "reputation-scaling",
  "venue-allowlist",
  "leverage-cap",
]);

/** A registered plugin evaluator, bound to the policy engine's context type. */
export interface RegisteredPolicyEvaluator {
  /** the rule-type discriminator this evaluator handles. */
  readonly type: string;
  /** the plugin that contributed it (diagnostics + collision messages). */
  readonly pluginName: string;
  /** optional human-readable description, surfaced in diagnostics. */
  readonly description?: string;
  /** the evaluator itself, sees the engine's EvaluatorContext. */
  evaluate(
    rule: ContributedPolicyRule,
    ctx: EvaluatorContext,
  ): ContributedPolicyResult | Promise<ContributedPolicyResult>;
}

/**
 * Thrown when a plugin tries to register an evaluator for a rule type that is a
 * CORE type or that another plugin already registered. The host FAILS CLOSED on
 * this (it never composes an ambiguous policy-evaluation surface), mirroring the
 * fail-closed philosophy of the plugin host's dependency ordering.
 */
export class PolicyRuleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRuleRegistryError";
  }
}

/**
 * A registry mapping a plugin-contributed rule `type` to its evaluator. Core rule
 * types are NOT stored here (they are evaluated by the closed switch); the
 * registry ONLY holds plugin contributions, and refuses any `type` that collides
 * with a core type or a previously-registered plugin type.
 */
export class PolicyRuleRegistry {
  private readonly evaluators = new Map<string, RegisteredPolicyEvaluator>();

  /**
   * Register a plugin's evaluator. FAILS CLOSED (throws
   * {@link PolicyRuleRegistryError}) when:
   *   - `type` is empty/blank,
   *   - `type` is a core rule type (a plugin can't override a core decision),
   *   - `type` was already registered by another plugin.
   */
  register(evaluator: RegisteredPolicyEvaluator): void {
    const type = evaluator.type;
    if (typeof type !== "string" || type.trim().length === 0) {
      throw new PolicyRuleRegistryError(
        `plugin "${evaluator.pluginName}" contributed a policy rule with an empty type.`,
      );
    }
    if (CORE_POLICY_RULE_TYPES.has(type)) {
      throw new PolicyRuleRegistryError(
        `plugin "${evaluator.pluginName}" cannot register policy rule type "${type}": it is a core rule type and may not be overridden.`,
      );
    }
    const existing = this.evaluators.get(type);
    if (existing) {
      throw new PolicyRuleRegistryError(
        `policy rule type "${type}" is already registered by plugin "${existing.pluginName}"; plugin "${evaluator.pluginName}" cannot register it again.`,
      );
    }
    this.evaluators.set(type, evaluator);
  }

  /** Look up a registered evaluator for a rule type, or undefined. */
  get(type: string): RegisteredPolicyEvaluator | undefined {
    return this.evaluators.get(type);
  }

  /** True when a plugin evaluator is registered for `type`. */
  has(type: string): boolean {
    return this.evaluators.has(type);
  }

  /** Remove all registered plugin evaluators (test isolation / recompose). */
  clear(): void {
    this.evaluators.clear();
  }

  /** Diagnostics: which plugin contributed which rule types. */
  describe(): Array<{
    type: string;
    pluginName: string;
    description?: string;
  }> {
    return [...this.evaluators.values()]
      .map((e) => ({
        type: e.type,
        pluginName: e.pluginName,
        ...(e.description !== undefined ? { description: e.description } : {}),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }
}

/**
 * Process-wide registry the core's `evaluatePolicy` default-fallthrough consults.
 * The plugin host registers plugin-contributed evaluators into THIS instance at
 * the composition root.
 */
export const policyRuleRegistry = new PolicyRuleRegistry();

/**
 * Evaluate a rule whose `type` is NOT a core type by consulting the registry.
 * Returns the contributed evaluator's verdict (as a `PolicyResult`, optionally
 * carrying the `requiresManualApproval` signal on a non-passing result), or
 * `null` when no plugin registered an evaluator for the type (the caller then
 * keeps its existing "Unknown policy type" deny). A thrown evaluator error is
 * converted to a fail-closed deny so a buggy plugin can never crash the
 * money-route decision.
 */
export async function evaluateRegisteredPolicy(
  rule: PolicyRule,
  ctx: EvaluatorContext,
  registry: PolicyRuleRegistry = policyRuleRegistry,
): Promise<(PolicyResult & ManualApprovalSignal) | null> {
  const evaluator = registry.get(rule.type);
  if (!evaluator) return null;
  const contributedRule: ContributedPolicyRule = {
    id: rule.id,
    type: rule.type,
    enabled: rule.enabled,
    config: rule.config,
  };
  try {
    const result = await evaluator.evaluate(contributedRule, ctx);
    // The contributed result is structurally a PolicyResult; surface it as one,
    // pinning policyId/type to the rule so a misbehaving plugin can't mislabel
    // the verdict's identity.
    const passed = result.passed === true;
    // Forward the manual-approval signal ONLY on a non-passing result (mirrors
    // ManualApprovalSignal's contract in ./manual-approval: the flag is
    // meaningless on a pass, and the engine must never treat a hard failure as
    // "needs approval" unless the evaluator explicitly opted in). This lets a
    // contributed rule (e.g. capability-intent's require-approval effect) route
    // to the approval queue through the same channel a core rule uses. Absence
    // of the flag => hard deny (fail closed).
    return {
      policyId: rule.id,
      type: rule.type as PolicyResult["type"],
      passed,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(!passed && result.requiresManualApproval === true
        ? { requiresManualApproval: true }
        : {}),
    };
  } catch (error) {
    // describeThrown NEVER throws for any hostile thrown value, so this
    // fail-closed deny reason cannot itself escape as an unhandled exception.
    return {
      policyId: rule.id,
      type: rule.type as PolicyResult["type"],
      passed: false,
      reason: `Plugin policy evaluator for "${rule.type}" threw: ${describeThrown(error)}`,
    };
  }
}

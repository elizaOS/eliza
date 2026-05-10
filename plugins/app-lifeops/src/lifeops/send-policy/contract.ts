/**
 * Send-policy contract.
 *
 * A send-policy contribution gates outbound dispatch on a connector or
 * channel. The canonical example is the owner-send-policy: Gmail drafts
 * require explicit owner approval; everything else passes straight through
 * (see `src/lifeops/messaging/owner-send-policy.ts`).
 */

import type { DispatchResult } from "../connectors/contract.js";

/**
 * Decision returned by a send-policy evaluation.
 *
 * - `allow`        — proceed with dispatch immediately.
 * - `require_approval` — enqueue an approval request keyed on `requestId`;
 *                    the runner pauses dispatch until the approval resolves.
 * - `deny`         — refuse the dispatch with `reason`. The runner converts
 *                    this into a `DispatchResult` failure with
 *                    `userActionable: true` if `userActionable` is true.
 */
export type SendPolicyDecision =
  | { kind: "allow" }
  | { kind: "require_approval"; requestId: string; reason?: string }
  | {
      kind: "deny";
      reason: string;
      userActionable: boolean;
      asDispatchResult?: Extract<DispatchResult, { ok: false }>;
    };

export interface SendPolicyContext {
  /** Connector or channel kind initiating the send. */
  source: { kind: "connector" | "channel"; key: string };

  /** Capability string the connector tagged this send with, if known. */
  capability?: string;

  /** Connector- or channel-specific payload (opaque to the policy registry). */
  payload: unknown;

  /** Stable identifier for the originating `ScheduledTask`, if any. */
  taskId?: string;
}

export interface SendPolicyContribution {
  /** Stable policy key — `"owner_approval"`, `"quiet_hours"`, etc. */
  kind: string;

  describe: { label: string };

  /**
   * Lower numbers run first. When multiple policies match, the runtime evaluates
   * in priority order and short-circuits on the first non-`allow` decision.
   * Policies without a priority are appended in registration order.
   */
  priority?: number;

  /**
   * Optional pre-filter — return `true` to evaluate this policy for the given
   * context. Defaults to "always evaluate" when omitted.
   */
  appliesTo?(context: SendPolicyContext): boolean;

  evaluate(
    context: SendPolicyContext,
  ): SendPolicyDecision | Promise<SendPolicyDecision>;
}

export interface SendPolicyRegistryFilter {
  /** Filter by source kind ("connector" | "channel"). */
  source?: SendPolicyContext["source"]["kind"];
}

export interface SendPolicyRegistry {
  register(c: SendPolicyContribution): void;
  list(filter?: SendPolicyRegistryFilter): SendPolicyContribution[];
  get(kind: string): SendPolicyContribution | null;

  /**
   * Evaluate every registered policy against `context` in priority order and
   * return the first non-`allow` decision, or `{ kind: "allow" }` if every
   * policy passes.
   */
  evaluate(context: SendPolicyContext): Promise<SendPolicyDecision>;
}

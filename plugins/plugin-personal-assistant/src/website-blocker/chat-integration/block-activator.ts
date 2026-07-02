/**
 * Shared block-activation seam.
 *
 * Both the BLOCK action's website target and the `BlockRuleWriter`
 * (chat-integration / application) need to flip the
 * OS-level hosts-file block on for a given hostname set + duration.
 *
 * Owning this here breaks the cycle that existed when the writer reached
 * up into `actions/website-block.ts` to invoke the action handler purely
 * for its side effect — the handler is presentation, the writer is
 * application, and the OS-block transaction is domain.
 *
 * The activator wraps `startSelfControlBlock` + `syncWebsiteBlockerExpiryTask`
 * with rollback semantics: if the expiry task can't be scheduled the OS
 * block is stopped before returning a failure.
 *
 * `syncOsBlockToRules` is the convergence primitive for the block-rule
 * lifecycle: given the set of active `life_block_rules`, it makes the single
 * OS-level block match them — starting, reshaping, or stopping the managed
 * block as rules are created and released. Rule-managed blocks are tagged
 * with `managedBy = BLOCK_RULES_MANAGED_BY` so the sync never tears down a
 * block the user started manually.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  getSelfControlStatus,
  normalizeWebsiteTargets,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
} from "@elizaos/plugin-blocker/services/website-blocker/index";
import type { BlockRule } from "./block-rule-schema.js";

/** `managedBy` marker for OS blocks owned by the block-rule lifecycle. */
export const BLOCK_RULES_MANAGED_BY = "lifeops-block-rules" as const;

export interface ActivateBlockRequest {
  runtime: IAgentRuntime;
  websites: readonly string[];
  /** `null` = manual / indefinite; positive integer = timed minutes. */
  durationMinutes: number | null;
  /** Optional engine metadata (e.g. `managedBy`) recorded on the OS block. */
  metadata?: Record<string, unknown> | null;
}

export type ActivateBlockResult =
  | { success: true; endsAt: string | null }
  | { success: false; error: string };

export async function activateBlockRule(
  request: ActivateBlockRequest,
): Promise<ActivateBlockResult> {
  const result = await startSelfControlBlock({
    websites: [...request.websites],
    durationMinutes: request.durationMinutes,
    metadata: request.metadata ?? null,
    scheduledByAgentId: String(request.runtime.agentId),
  });
  if (result.success === false) {
    return { success: false, error: result.error };
  }

  if (request.durationMinutes !== null) {
    const taskId = await syncWebsiteBlockerExpiryTask(request.runtime);
    if (!taskId) {
      await stopSelfControlBlock();
      return {
        success: false,
        error:
          "Eliza started the website block but could not schedule its automatic unblock task, so it rolled the block back.",
      };
    }
  }

  return { success: true, endsAt: result.endsAt };
}

export interface OsBlockSyncResult {
  /** True when the OS-level state matches the active rules after the call. */
  ok: boolean;
  /** True when this call started, reshaped, or stopped the OS block. */
  changed: boolean;
  error: string | null;
}

/**
 * Remaining enforcement time for a time-gated rule, in whole minutes
 * (minimum 1 so the engine accepts it). `null` for gates with no time bound
 * (`until_todo`, `harsh_no_bypass`) — those need an indefinite OS block that
 * only the reconciler releases.
 */
function remainingMinutesForRule(
  rule: BlockRule,
  nowMs: number,
): number | null {
  if (rule.gateType === "fixed_duration" && rule.fixedDurationMs !== null) {
    return Math.max(
      1,
      Math.ceil((rule.createdAt + rule.fixedDurationMs - nowMs) / 60_000),
    );
  }
  if (rule.gateType === "until_iso" && rule.gateUntilMs !== null) {
    return Math.max(1, Math.ceil((rule.gateUntilMs - nowMs) / 60_000));
  }
  return null;
}

function haveSameWebsiteSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((website, index) => website === rightSorted[index]);
}

/**
 * Converge the single OS-level website block onto the given active rules.
 *
 * - No active rules → stop the OS block if (and only if) it is rule-managed.
 * - Active rules, no OS block → start one for the union of rule websites.
 * - Active rules, rule-managed OS block with a different website set →
 *   reshape (stop + start).
 * - A foreign (manually started) OS block is never touched; if rules cannot
 *   engage because of it, that is reported as a failure so callers surface it.
 *
 * Duration of the merged block: indefinite when any rule has no time bound,
 * otherwise the longest remaining gate (the engine's expiry task then acts as
 * defense in depth if the reconciler stops running).
 */
export async function syncOsBlockToRules(
  runtime: IAgentRuntime,
  rules: readonly BlockRule[],
  nowMs: number = Date.now(),
): Promise<OsBlockSyncResult> {
  const status = await getSelfControlStatus();
  const desiredWebsites = normalizeWebsiteTargets(
    rules.flatMap((rule) => rule.websites),
  );

  if (desiredWebsites.length === 0) {
    if (!status.active || status.managedBy !== BLOCK_RULES_MANAGED_BY) {
      return { ok: true, changed: false, error: null };
    }
    const stopped = await stopSelfControlBlock();
    if (stopped.success === false) {
      return { ok: false, changed: false, error: stopped.error };
    }
    return { ok: true, changed: true, error: null };
  }

  if (status.active) {
    if (status.managedBy !== BLOCK_RULES_MANAGED_BY) {
      return {
        ok: false,
        changed: false,
        error:
          "A website block that is not managed by block rules is already running; the block rules cannot engage until it ends.",
      };
    }
    if (haveSameWebsiteSet(status.requestedWebsites, desiredWebsites)) {
      return { ok: true, changed: false, error: null };
    }
    const stopped = await stopSelfControlBlock();
    if (stopped.success === false) {
      return { ok: false, changed: false, error: stopped.error };
    }
  }

  let durationMinutes: number | null = 0;
  for (const rule of rules) {
    const remaining = remainingMinutesForRule(rule, nowMs);
    if (remaining === null) {
      durationMinutes = null;
      break;
    }
    durationMinutes = Math.max(durationMinutes, remaining);
  }

  const activation = await activateBlockRule({
    runtime,
    websites: desiredWebsites,
    durationMinutes,
    metadata: { managedBy: BLOCK_RULES_MANAGED_BY },
  });
  if (activation.success === false) {
    return { ok: false, changed: status.active, error: activation.error };
  }
  return { ok: true, changed: true, error: null };
}

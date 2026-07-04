/**
 * Block-rule reconciler — the repeating task worker that keeps the OS-level
 * hosts-file website block converged onto the active `life_block_rules`.
 *
 * On each 60s tick it releases rules whose gate is fulfilled (`until_todo` once
 * the gate todo completes, `fixed_duration` on expiry, `until_iso` past its
 * deadline) and re-asserts or drops the single managed OS block to match the
 * rules that remain. `harsh_no_bypass` rules resist manual release, so the
 * reconciler is what makes an out-of-band unblock self-heal. Exposes the task
 * name/tags/interval, the one-shot `reconcileBlockRulesOnce`, and the worker
 * registration + `ensureBlockRuleReconcileTask` used to persist the Task row.
 */

import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import { logger, stringToUuid } from "@elizaos/core";
import { executeRawSql, sqlQuote } from "../../lifeops/sql.js";
import {
  type OsBlockSyncResult,
  syncOsBlockToRules,
} from "./block-activator.js";
import type { BlockRule } from "./block-rule-schema.js";
import { BlockRuleReader, BlockRuleWriter } from "./block-rule-service.js";

export const BLOCK_RULE_RECONCILE_TASK_NAME = "BLOCK_RULE_RECONCILE" as const;
export const BLOCK_RULE_RECONCILE_TASK_TAGS = [
  "queue",
  "repeat",
  "website-blocker",
  "block-rule-reconciler",
] as const;
export const BLOCK_RULE_RECONCILE_INTERVAL_MS = 60_000;

/**
 * T7g — Website blocker chat integration reconciler (plan §6.8).
 *
 * Walks the `app_lifeops.life_block_rules` table every tick and releases rules
 * whose gates have been fulfilled, then converges the OS-level hosts-file
 * block onto the rules that remain active (releasing it when the last rule
 * goes, re-asserting it when activation previously failed or the block was
 * removed out-of-band). `harsh_no_bypass` rules behave like `until_todo` but
 * also reject manual release attempts in the writer and the HTTP DELETE route.
 */

async function isTodoCompleted(
  runtime: IAgentRuntime,
  todoId: string,
): Promise<boolean> {
  const rows = await executeRawSql(
    runtime,
    `SELECT state FROM app_lifeops.life_task_occurrences
       WHERE id = ${sqlQuote(todoId)}
       LIMIT 1`,
  );
  if (rows.length === 0) {
    const defRows = await executeRawSql(
      runtime,
      `SELECT status FROM app_lifeops.life_task_definitions
         WHERE id = ${sqlQuote(todoId)}
         LIMIT 1`,
    );
    if (defRows.length === 0) return false;
    const definitionRow = defRows[0];
    if (!definitionRow) return false;
    const status = definitionRow.status;
    return typeof status === "string" && status.toLowerCase() === "completed";
  }
  const row = rows[0];
  if (!row) return false;
  const state = row.state;
  return typeof state === "string" && state.toLowerCase() === "completed";
}

function shouldReleaseByTime(
  rule: BlockRule,
  nowMs: number,
): { release: boolean; reason: string } {
  if (rule.gateType === "fixed_duration") {
    if (rule.fixedDurationMs === null) return { release: false, reason: "" };
    if (nowMs - rule.createdAt >= rule.fixedDurationMs) {
      return { release: true, reason: "fixed_duration_elapsed" };
    }
    return { release: false, reason: "" };
  }
  if (rule.gateType === "until_iso") {
    if (rule.gateUntilMs === null) return { release: false, reason: "" };
    if (nowMs >= rule.gateUntilMs) {
      return { release: true, reason: "until_iso_reached" };
    }
    return { release: false, reason: "" };
  }
  return { release: false, reason: "" };
}

/** Returns true when the rule was released this pass. */
async function evaluateRule(
  runtime: IAgentRuntime,
  writer: BlockRuleWriter,
  rule: BlockRule,
  nowMs: number,
): Promise<boolean> {
  if (rule.gateType === "until_todo" || rule.gateType === "harsh_no_bypass") {
    if (!rule.gateTodoId) return false;
    const completed = await isTodoCompleted(runtime, rule.gateTodoId);
    if (!completed) return false;
    await writer.updateGateFulfilled(rule.id, "todo_completed");
    logger.info(
      `[BlockRuleReconciler] Released rule ${rule.id}: gate todo ${rule.gateTodoId} completed`,
    );
    if (rule.unlockDurationMs !== null && rule.unlockDurationMs > 0) {
      await scheduleAutoReLock(writer, rule, nowMs);
    }
    return true;
  }

  const decision = shouldReleaseByTime(rule, nowMs);
  if (!decision.release) return false;
  await writer.updateGateFulfilled(rule.id, decision.reason);
  logger.info(
    `[BlockRuleReconciler] Released rule ${rule.id}: ${decision.reason}`,
  );
  return true;
}

async function scheduleAutoReLock(
  writer: BlockRuleWriter,
  rule: BlockRule,
  nowMs: number,
): Promise<void> {
  if (rule.unlockDurationMs === null || rule.unlockDurationMs <= 0) return;
  const reLockAtMs = nowMs + rule.unlockDurationMs;
  const followUpRuleId = await writer.createBlockRule({
    profile: rule.profile,
    websites: rule.websites,
    gateType: "until_iso",
    gateUntilMs: reLockAtMs,
  });
  logger.info(
    `[BlockRuleReconciler] Scheduled auto re-lock ${followUpRuleId} until ${new Date(reLockAtMs).toISOString()}`,
  );
}

export interface BlockRuleReconcileResult {
  releasedRuleIds: string[];
  osSync: OsBlockSyncResult;
}

export async function reconcileBlockRulesOnce(
  runtime: IAgentRuntime,
  nowMs: number = Date.now(),
): Promise<BlockRuleReconcileResult> {
  const reader = new BlockRuleReader(runtime);
  const writer = new BlockRuleWriter(runtime);
  const active = await reader.listActiveBlocks();
  const releasedRuleIds: string[] = [];
  for (const rule of active) {
    if (await evaluateRule(runtime, writer, rule, nowMs)) {
      releasedRuleIds.push(rule.id);
    }
  }

  // Converge OS state onto whatever is active after this pass. This is what
  // releases the hosts-file block when gates fulfill, retries activations
  // that failed at rule-creation time, and re-asserts blocks that were
  // removed out-of-band while a rule (harsh or not) is still active.
  const remaining = await reader.listActiveBlocks();
  const osSync = await syncOsBlockToRules(runtime, remaining, nowMs);
  if (!osSync.ok) {
    logger.error(
      `[BlockRuleReconciler] OS block sync failed for ${remaining.length} active rule(s): ${osSync.error}`,
    );
  }
  return { releasedRuleIds, osSync };
}

export function registerBlockRuleReconcilerWorker(
  runtime: IAgentRuntime,
): void {
  if (runtime.getTaskWorker(BLOCK_RULE_RECONCILE_TASK_NAME)) {
    return;
  }
  runtime.registerTaskWorker({
    name: BLOCK_RULE_RECONCILE_TASK_NAME,
    shouldRun: async () => true,
    execute: async (rt) => {
      await reconcileBlockRulesOnce(rt);
      return undefined;
    },
  });
}

function isBlockRuleReconcileTask(task: Task): boolean {
  return task.name === BLOCK_RULE_RECONCILE_TASK_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildBlockRuleReconcileMetadata(
  previous?: TaskMetadata | null,
): TaskMetadata {
  return {
    ...(isRecord(previous) ? previous : {}),
    updateInterval: BLOCK_RULE_RECONCILE_INTERVAL_MS,
  };
}

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

/**
 * Persist the repeating Task row that drives the reconciler through the core
 * task tick. Without this row the registered worker never runs: `until_todo`
 * gates never release, `fixed_duration` rules never deactivate, and auto
 * re-lock is unreachable. Mirrors `ensureFollowupTrackerTask`.
 */
export async function ensureBlockRuleReconcileTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...BLOCK_RULE_RECONCILE_TASK_TAGS],
  });
  const existing = tasks.find(isBlockRuleReconcileTask);
  const metadata = buildBlockRuleReconcileMetadata(
    isRecord(existing?.metadata) ? existing.metadata : null,
  );
  if (existing?.id) {
    await runtime.updateTask(existing.id, {
      description: "Reconcile website block rules against gates and OS state",
      metadata,
    });
    return existing.id;
  }

  const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
  const roomId =
    autonomy?.getAutonomousRoomId?.() ??
    stringToUuid(`block-rule-reconciler-room-${runtime.agentId}`);

  return runtime.createTask({
    name: BLOCK_RULE_RECONCILE_TASK_NAME,
    description: "Reconcile website block rules against gates and OS state",
    roomId,
    tags: [...BLOCK_RULE_RECONCILE_TASK_TAGS],
    metadata,
    dueAt: Date.now(),
  });
}

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { executeRawSql, sqlQuote } from "../../lifeops/sql.js";
import type { BlockRule } from "./block-rule-schema.js";
import { BlockRuleReader, BlockRuleWriter } from "./block-rule-service.js";

export const BLOCK_RULE_RECONCILE_TASK_NAME = "BLOCK_RULE_RECONCILE" as const;
export const BLOCK_RULE_RECONCILE_TASK_TAGS = [
  "queue",
  "website-blocker",
  "block-rule-reconciler",
] as const;
export const BLOCK_RULE_RECONCILE_INTERVAL_MS = 60_000;

/**
 * T7g — Website blocker chat integration reconciler (plan §6.8).
 *
 * Walks the `app_lifeops.life_block_rules` table every tick and releases rules whose
 * gates have been fulfilled. `harsh_no_bypass` rules behave like
 * `until_todo` but also reject manual release attempts in the writer.
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

async function evaluateRule(
  runtime: IAgentRuntime,
  writer: BlockRuleWriter,
  rule: BlockRule,
  nowMs: number,
): Promise<void> {
  if (rule.gateType === "until_todo" || rule.gateType === "harsh_no_bypass") {
    if (!rule.gateTodoId) return;
    const completed = await isTodoCompleted(runtime, rule.gateTodoId);
    if (!completed) return;
    await writer.updateGateFulfilled(rule.id, "todo_completed");
    logger.info(
      `[BlockRuleReconciler] Released rule ${rule.id}: gate todo ${rule.gateTodoId} completed`,
    );
    if (rule.unlockDurationMs !== null && rule.unlockDurationMs > 0) {
      await scheduleAutoReLock(runtime, writer, rule, nowMs);
    }
    return;
  }

  const decision = shouldReleaseByTime(rule, nowMs);
  if (!decision.release) return;
  await writer.updateGateFulfilled(rule.id, decision.reason);
  logger.info(
    `[BlockRuleReconciler] Released rule ${rule.id}: ${decision.reason}`,
  );
}

async function scheduleAutoReLock(
  _runtime: IAgentRuntime,
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

export async function reconcileBlockRulesOnce(
  runtime: IAgentRuntime,
  nowMs: number = Date.now(),
): Promise<void> {
  const reader = new BlockRuleReader(runtime);
  const writer = new BlockRuleWriter(runtime);
  const active = await reader.listActiveBlocks();
  for (const rule of active) {
    await evaluateRule(runtime, writer, rule, nowMs);
  }
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

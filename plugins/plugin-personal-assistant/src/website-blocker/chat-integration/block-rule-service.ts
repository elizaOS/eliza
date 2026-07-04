// Reconciles LifeOps block rules with website blocker chat requests.
import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { executeRawSql, sqlQuote, sqlText } from "../../lifeops/sql.js";
import { syncOsBlockToRules } from "./block-activator.js";
import {
  BLOCK_RULES_TABLE,
  type BlockRule,
  type BlockRuleGateType,
  type CreateBlockRuleInput,
  rowToBlockRule,
} from "./block-rule-schema.js";

/**
 * CQRS: writers only mutate. They return the new id or void. Readers return
 * domain objects. Both live in the same module because they share the table
 * encoders, but they are separate classes so tests exercise the pipelines
 * independently.
 */

function nowMs(): number {
  return Date.now();
}

function newBlockRuleId(): string {
  const maybeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (maybeCrypto?.randomUUID) return maybeCrypto.randomUUID();
  return crypto.randomUUID();
}

function sqlBigint(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) {
    throw new Error(`[BlockRuleWriter] non-finite numeric: ${String(value)}`);
  }
  return String(Math.trunc(value));
}

function sqlJsonArray(values: readonly string[]): string {
  return sqlQuote(JSON.stringify([...values]));
}

function assertValidGateType(gateType: BlockRuleGateType): void {
  switch (gateType) {
    case "fixed_duration":
    case "until_todo":
    case "until_iso":
    case "harsh_no_bypass":
      return;
  }
}

function assertCreateInput(input: CreateBlockRuleInput): void {
  if (!input.profile.trim()) {
    throw new Error("[BlockRuleWriter] profile is required");
  }
  if (input.websites.length === 0) {
    throw new Error("[BlockRuleWriter] websites must not be empty");
  }
  assertValidGateType(input.gateType);
  if (input.gateType === "until_todo" && !input.gateTodoId) {
    throw new Error("[BlockRuleWriter] until_todo gate requires gateTodoId");
  }
  // A harsh rule refuses every manual bypass (confirmed release, chat unblock,
  // HTTP DELETE) and the reconciler only releases it via its gate task item. Without
  // a gateTodoId it would be a permanent lock with no exit path at all.
  if (input.gateType === "harsh_no_bypass" && !input.gateTodoId) {
    throw new Error(
      "[BlockRuleWriter] harsh_no_bypass gate requires gateTodoId",
    );
  }
  if (input.gateType === "until_iso" && input.gateUntilMs === undefined) {
    throw new Error("[BlockRuleWriter] until_iso gate requires gateUntilMs");
  }
  if (
    input.gateType === "fixed_duration" &&
    (input.fixedDurationMs === undefined || input.fixedDurationMs === null)
  ) {
    throw new Error(
      "[BlockRuleWriter] fixed_duration gate requires fixedDurationMs",
    );
  }
}

export class BlockRuleWriter {
  constructor(private readonly runtime: IAgentRuntime) {}

  async createBlockRule(input: CreateBlockRuleInput): Promise<string> {
    assertCreateInput(input);
    const id = input.id ?? newBlockRuleId();
    const agentId = String(this.runtime.agentId);
    const createdAt = nowMs();

    await executeRawSql(
      this.runtime,
      `INSERT INTO ${BLOCK_RULES_TABLE} (
         id, agent_id, profile, websites, gate_type, gate_todo_id,
         gate_until_ms, fixed_duration_ms, unlock_duration_ms,
         active, created_at, released_at, released_reason
       ) VALUES (
         ${sqlQuote(id)},
         ${sqlQuote(agentId)},
         ${sqlQuote(input.profile)},
         ${sqlJsonArray(input.websites)},
         ${sqlQuote(input.gateType)},
         ${sqlText(input.gateTodoId ?? null)},
         ${sqlBigint(input.gateUntilMs ?? null)},
         ${sqlBigint(input.fixedDurationMs ?? null)},
         ${sqlBigint(input.unlockDurationMs ?? null)},
         TRUE,
         ${sqlBigint(createdAt)},
         NULL,
         NULL
       )`,
    );

    const reader = new BlockRuleReader(this.runtime);
    const sync = await syncOsBlockToRules(
      this.runtime,
      await reader.listActiveBlocks(),
      createdAt,
    );
    if (!sync.ok) {
      // The rule is the source of truth. Activation failures
      // (missing admin permission, unsupported platform, no helper binary)
      // are logged but do not tear down the rule — the reconciler re-runs
      // this same OS sync on every tick until it succeeds.
      logger.warn(
        `[BlockRuleWriter] SelfControl activation did not complete for rule ${id}: ${sync.error}`,
      );
    }

    logger.info(
      `[BlockRuleWriter] Created block rule ${id} (${input.gateType}) for ${input.websites.join(", ")}`,
    );
    return id;
  }

  async releaseBlockRule(
    id: string,
    options: { confirmed: boolean; reason?: string },
  ): Promise<void> {
    if (!options.confirmed) {
      throw new Error(
        "[BlockRuleWriter] releaseBlockRule requires confirmed:true",
      );
    }
    const agentId = String(this.runtime.agentId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM ${BLOCK_RULES_TABLE}
         WHERE id = ${sqlQuote(id)}
           AND agent_id = ${sqlQuote(agentId)}`,
    );
    if (rows.length === 0) {
      throw new Error(`[BlockRuleWriter] block rule ${id} not found`);
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`[BlockRuleWriter] block rule ${id} not found`);
    }
    const rule = rowToBlockRule(row);
    if (rule.gateType === "harsh_no_bypass") {
      throw new Error(
        `[BlockRuleWriter] block rule ${id} is harsh_no_bypass and cannot be released by user confirmation`,
      );
    }
    if (!rule.active) {
      return;
    }
    const reason = options.reason ?? "user_confirmed";
    await executeRawSql(
      this.runtime,
      `UPDATE ${BLOCK_RULES_TABLE}
          SET active = FALSE,
              released_at = ${sqlBigint(nowMs())},
              released_reason = ${sqlQuote(reason)}
        WHERE id = ${sqlQuote(id)}
          AND agent_id = ${sqlQuote(agentId)}`,
    );
    logger.info(`[BlockRuleWriter] Released block rule ${id} (${reason})`);

    // Releasing the rule must release the OS-level block too — a user who
    // hears "released" and still hits a hosts-file sinkhole has been lied to.
    const reader = new BlockRuleReader(this.runtime);
    const sync = await syncOsBlockToRules(
      this.runtime,
      await reader.listActiveBlocks(),
    );
    if (!sync.ok) {
      throw new Error(
        `[BlockRuleWriter] Block rule ${id} was released, but updating the OS-level website block failed: ${sync.error} The reconciler retries within a minute.`,
      );
    }
  }

  /**
   * DB-only release used by the reconciler's gate evaluation. The reconciler
   * runs one `syncOsBlockToRules` pass after evaluating every rule, so this
   * writer intentionally does not touch OS state itself.
   */
  async updateGateFulfilled(id: string, reason: string): Promise<void> {
    const agentId = String(this.runtime.agentId);
    await executeRawSql(
      this.runtime,
      `UPDATE ${BLOCK_RULES_TABLE}
          SET active = FALSE,
              released_at = ${sqlBigint(nowMs())},
              released_reason = ${sqlQuote(reason)}
        WHERE id = ${sqlQuote(id)}
          AND agent_id = ${sqlQuote(agentId)}
          AND active = TRUE`,
    );
  }
}

export class BlockRuleReader {
  constructor(private readonly runtime: IAgentRuntime) {}

  async listActiveBlocks(): Promise<BlockRule[]> {
    const agentId = String(this.runtime.agentId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM ${BLOCK_RULES_TABLE}
         WHERE agent_id = ${sqlQuote(agentId)}
           AND active = TRUE
         ORDER BY created_at ASC`,
    );
    return rows.map(rowToBlockRule);
  }

  async findBlocksGatedByTodo(todoId: string): Promise<BlockRule[]> {
    const agentId = String(this.runtime.agentId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM ${BLOCK_RULES_TABLE}
         WHERE agent_id = ${sqlQuote(agentId)}
           AND active = TRUE
           AND gate_type = 'until_todo'
           AND gate_todo_id = ${sqlQuote(todoId)}`,
    );
    return rows.map(rowToBlockRule);
  }

  async isBlockActive(profile: string): Promise<boolean> {
    const agentId = String(this.runtime.agentId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT 1 AS ok FROM ${BLOCK_RULES_TABLE}
         WHERE agent_id = ${sqlQuote(agentId)}
           AND active = TRUE
           AND profile = ${sqlQuote(profile)}
         LIMIT 1`,
    );
    return rows.length > 0;
  }

  async getBlockRuleById(id: string): Promise<BlockRule | null> {
    const agentId = String(this.runtime.agentId);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM ${BLOCK_RULES_TABLE}
         WHERE id = ${sqlQuote(id)}
           AND agent_id = ${sqlQuote(agentId)}
         LIMIT 1`,
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return row ? rowToBlockRule(row) : null;
  }
}

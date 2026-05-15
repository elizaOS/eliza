/**
 * T7g — Website blocker chat integration (plan §6.8).
 *
 * Domain types for the `life_block_rules` table. The table is bootstrapped
 * in `LifeOpsRepository.bootstrapSchema`; this module only provides typed
 * shapes and narrow runtime decoders for rows read back from SQL.
 */

export const BLOCK_RULES_TABLE = "app_lifeops.life_block_rules" as const;

export type BlockRuleGateType =
  | "fixed_duration"
  | "until_todo"
  | "until_iso"
  | "harsh_no_bypass";

export interface BlockRule {
  id: string;
  agentId: string;
  profile: string;
  websites: string[];
  gateType: BlockRuleGateType;
  gateTodoId: string | null;
  gateUntilMs: number | null;
  fixedDurationMs: number | null;
  unlockDurationMs: number | null;
  active: boolean;
  createdAt: number;
  releasedAt: number | null;
  releasedReason: string | null;
}

export interface CreateBlockRuleInput {
  id?: string;
  profile: string;
  websites: string[];
  gateType: BlockRuleGateType;
  gateTodoId?: string | null;
  gateUntilMs?: number | null;
  fixedDurationMs?: number | null;
  unlockDurationMs?: number | null;
}

export class BlockRuleRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockRuleRowError";
  }
}

function isGateType(value: string): value is BlockRuleGateType {
  return (
    value === "fixed_duration" ||
    value === "until_todo" ||
    value === "until_iso" ||
    value === "harsh_no_bypass"
  );
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new BlockRuleRowError(
        "life_block_rules.websites JSON is not an array",
      );
    }
    return parsed.map((entry) => {
      if (typeof entry !== "string") {
        throw new BlockRuleRowError(
          "life_block_rules.websites contains a non-string entry",
        );
      }
      return entry;
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") {
        throw new BlockRuleRowError(
          "life_block_rules.websites contains a non-string entry",
        );
      }
      return entry;
    });
  }
  throw new BlockRuleRowError(
    "life_block_rules.websites is neither string nor array",
  );
}

function toNumberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BlockRuleRowError(`life_block_rules.${field} is not finite`);
    }
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BlockRuleRowError(
        `life_block_rules.${field} could not be parsed as number`,
      );
    }
    return parsed;
  }
  throw new BlockRuleRowError(
    `life_block_rules.${field} has unexpected type ${typeof value}`,
  );
}

function toRequiredNumber(value: unknown, field: string): number {
  const result = toNumberOrNull(value, field);
  if (result === null) {
    throw new BlockRuleRowError(`life_block_rules.${field} is NULL`);
  }
  return result;
}

function toStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new BlockRuleRowError(
    `life_block_rules.${field} has unexpected type ${typeof value}`,
  );
}

function toRequiredString(value: unknown, field: string): string {
  const result = toStringOrNull(value, field);
  if (result === null) {
    throw new BlockRuleRowError(`life_block_rules.${field} is NULL`);
  }
  return result;
}

function toBool(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "t" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "f" || normalized === "0") {
      return false;
    }
  }
  if (value === null || value === undefined) return false;
  throw new BlockRuleRowError(
    `life_block_rules.${field} is not a boolean-compatible value`,
  );
}

export function rowToBlockRule(row: Record<string, unknown>): BlockRule {
  const gateType = toRequiredString(row.gate_type, "gate_type");
  if (!isGateType(gateType)) {
    throw new BlockRuleRowError(
      `life_block_rules.gate_type is invalid: ${gateType}`,
    );
  }
  return {
    id: toRequiredString(row.id, "id"),
    agentId: toRequiredString(row.agent_id, "agent_id"),
    profile: toRequiredString(row.profile, "profile"),
    websites: toStringArray(row.websites),
    gateType,
    gateTodoId: toStringOrNull(row.gate_todo_id, "gate_todo_id"),
    gateUntilMs: toNumberOrNull(row.gate_until_ms, "gate_until_ms"),
    fixedDurationMs: toNumberOrNull(row.fixed_duration_ms, "fixed_duration_ms"),
    unlockDurationMs: toNumberOrNull(
      row.unlock_duration_ms,
      "unlock_duration_ms",
    ),
    active: toBool(row.active, "active"),
    createdAt: toRequiredNumber(row.created_at, "created_at"),
    releasedAt: toNumberOrNull(row.released_at, "released_at"),
    releasedReason: toStringOrNull(row.released_reason, "released_reason"),
  };
}

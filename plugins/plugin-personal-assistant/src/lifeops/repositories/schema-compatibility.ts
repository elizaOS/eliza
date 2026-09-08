/** Detects existing SQL tables for guarded compatibility repairs without hiding unexpected database failures. */
import type { IAgentRuntime } from "@elizaos/core";
import { executeRawSql } from "../sql.js";

export function isMissingTableError(error: unknown, table: string): boolean {
  const message = errorMessagesWithCauses(error).join("\n");
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const schema = table.includes(".") ? table.split(".")[0] : "";
  const pattern = new RegExp(
    `no such table: ${escaped}|relation ["']?${escaped}["']? does not exist|undefined table`,
    "i",
  );
  return (
    pattern.test(message) ||
    (schema.length > 0 &&
      new RegExp(`schema ["']?${schema}["']? does not exist`, "i").test(
        message,
      ))
  );
}

/**
 * Probe whether a table exists by running a no-op query against it.
 *
 * Boot-order contract: callers MUST run after `adapter.runPluginMigrations`
 * has completed in `bootstrapSchema`, which already early-returns when the
 * adapter is missing or `adapter.isReady() === false`. We rely on that
 * gating; this helper does not re-check.
 *
 * SECURITY: `table` is interpolated directly into the SQL. Callers MUST
 * pass a hardcoded literal, NEVER a user-derived or runtime-derived name.
 * The current three callers (app_lifeops.life_scheduling_negotiations,
 * app_lifeops.life_activity_signals, app_lifeops.life_inbox_messages) all pass string literals.
 *
 * Failure mode: any error other than the recognized "missing table"
 * patterns (`isMissingTableError`) rethrows. We deliberately fail loud on
 * connection / syntax / permission errors rather than silent-skip the
 * column-repair pass.
 */
export async function tableExists(
  runtime: IAgentRuntime,
  table: string,
): Promise<boolean> {
  try {
    await executeRawSql(runtime, `SELECT 1 FROM ${table} WHERE 1=0`);
    return true;
  } catch (error) {
    if (isMissingTableError(error, table)) {
      return false;
    }
    throw error;
  }
}

export function errorMessagesWithCauses(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current && typeof current === "object") {
    if (current instanceof Error) {
      messages.push(current.message);
    }
    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) {
      break;
    }
    current = cause;
  }
  if (messages.length === 0) {
    messages.push(String(error));
  }
  return messages;
}

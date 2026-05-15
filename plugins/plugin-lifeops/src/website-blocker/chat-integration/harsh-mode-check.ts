import type { IAgentRuntime } from "@elizaos/core";
import { executeRawSql, sqlQuote } from "../../lifeops/sql.js";
import { BLOCK_RULES_TABLE } from "./block-rule-schema.js";

/**
 * Returns true when the agent has at least one active `harsh_no_bypass`
 * rule. Used by the website-block unblock flow to refuse a soft hosts-file
 * restore that the reconciler would re-create on its 60s tick anyway, leaving
 * a window of unprotected state.
 *
 * Returns false when the runtime database adapter is unavailable
 * (e.g. unit tests with a stub runtime). The hosts-file engine has no
 * rule store of its own, so an unconfigured runtime cannot have rules.
 */
export async function hasActiveHarshNoBypassRule(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const db = (runtime as { adapter?: { db?: unknown } }).adapter?.db;
  if (!db || typeof (db as { execute?: unknown }).execute !== "function") {
    return false;
  }
  const agentId = String(runtime.agentId);
  const rows = await executeRawSql(
    runtime,
    `SELECT 1 AS ok FROM ${BLOCK_RULES_TABLE}
       WHERE agent_id = ${sqlQuote(agentId)}
         AND active = TRUE
         AND gate_type = 'harsh_no_bypass'
       LIMIT 1`,
  );
  return rows.length > 0;
}

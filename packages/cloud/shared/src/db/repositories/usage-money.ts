/** Preserves exact persisted MCP usage money at the repository boundary. */

import { ElizaError } from "@elizaos/core";

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Preserve Postgres NUMERIC precision instead of coercing money through IEEE-754. */
export function parseUsageMoneyAggregate(value: unknown, field: string): string {
  if (value === null || value === undefined) return "0";
  if (typeof value !== "string" || !NON_NEGATIVE_DECIMAL.test(value)) {
    throw new ElizaError("Stored MCP usage aggregate is corrupt.", {
      code: "CORRUPT_MCP_USAGE_RECEIPT",
      context: { field, value },
      severity: "fatal",
    });
  }
  return value;
}

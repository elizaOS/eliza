/**
 * Guards the PostgreSQL aggregate-row invariant used by the account billing
 * snapshot. Aggregate queries must return one row even for an empty relation;
 * only values produced by that row (`COUNT` or SQL `COALESCE`) may represent
 * zero. A missing row is a source failure, never an implicit healthy zero.
 */

import { ElizaError } from "@elizaos/core";

export type AccountBillingAggregateSource =
  | "cloud_characters"
  | "agent_sandboxes"
  | "containers"
  | "apps"
  | "api_keys"
  | "tier_source_credits";

export function requireAccountBillingAggregateRow<T>(
  rows: readonly T[],
  source: AccountBillingAggregateSource,
): T {
  const row = rows[0];
  if (row === undefined || row === null) {
    throw new ElizaError(`Account billing aggregate ${source} did not return its required row`, {
      code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
      context: { source, reason: "missing_aggregate_row" },
      severity: "fatal",
    });
  }
  return row;
}

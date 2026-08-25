/**
 * Verifies that every PostgreSQL aggregate family required by the account
 * billing snapshot distinguishes a present SQL-produced zero from an absent
 * aggregate row. The latter must fail closed before DTO assembly.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  type AccountBillingAggregateSource,
  requireAccountBillingAggregateRow,
} from "../account-billing-snapshot-aggregates";

const REQUIRED_AGGREGATES: AccountBillingAggregateSource[] = [
  "cloud_characters",
  "agent_sandboxes",
  "containers",
  "apps",
  "api_keys",
  "tier_source_credits",
];

describe("account billing aggregate rows", () => {
  test.each(REQUIRED_AGGREGATES)("fails closed when %s returns no row", (source) => {
    let thrown: unknown;
    try {
      requireAccountBillingAggregateRow([], source);
    } catch (error) {
      // error-policy:J4 — capture the deliberate fail-closed source error so
      // its stable code and provenance can be asserted below.
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
      context: { source, reason: "missing_aggregate_row" },
    });
  });

  test.each(REQUIRED_AGGREGATES)(
    "accepts %s zero only when an aggregate row is present",
    (source) => {
      const sqlAggregateRow = { value: "0" };
      expect(requireAccountBillingAggregateRow([sqlAggregateRow], source)).toBe(sqlAggregateRow);
    },
  );
});

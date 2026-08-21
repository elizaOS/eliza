/**
 * Verifies that customer-binding authority rows preserve real boolean values
 * while missing or malformed primary data fails closed with typed provenance.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { requireCustomerBindingAuthoritativeRow } from "../account-billing-snapshot-primary-values";

describe("account billing customer-binding authority", () => {
  test.each([
    {
      name: "missing row",
      rows: [],
      code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
      reason: "missing_scalar_row",
      field: undefined,
    },
    {
      name: "null scalar",
      rows: [{ authoritative: null }],
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      reason: "non_boolean_scalar",
      field: "stripe_customer_binding_is_authoritative.authoritative",
    },
    {
      name: "non-boolean scalar",
      rows: [{ authoritative: "false" }],
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      reason: "non_boolean_scalar",
      field: "stripe_customer_binding_is_authoritative.authoritative",
    },
  ])("fails closed on $name", ({ rows, code, reason, field }) => {
    let thrown: unknown;
    try {
      requireCustomerBindingAuthoritativeRow(rows);
    } catch (error) {
      // error-policy:J4 — capture the deliberate fail-closed source error so
      // its stable code and provenance can be asserted below.
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code,
      context: {
        source: "stripe_customer_binding_authority",
        reason,
        ...(field === undefined ? {} : { field }),
      },
    });
  });

  test.each([
    { authoritative: false, expected: false },
    { authoritative: true, expected: true },
  ])("preserves a real $authoritative value", ({ authoritative, expected }) => {
    expect(requireCustomerBindingAuthoritativeRow([{ authoritative }])).toBe(expected);
  });
});

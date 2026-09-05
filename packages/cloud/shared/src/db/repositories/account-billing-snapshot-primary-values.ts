/**
 * Validates scalar rows returned by PostgreSQL functions that feed the
 * account billing snapshot. Missing rows and malformed scalar values remain
 * distinguishable primary-source failures instead of becoming business data.
 */

import { ElizaError } from "@elizaos/core/edge";

const CUSTOMER_BINDING_AUTHORITY_SOURCE = "stripe_customer_binding_authority";
const CUSTOMER_BINDING_AUTHORITY_FIELD = "stripe_customer_binding_is_authoritative.authoritative";

/** Require one actual boolean authority result; `false` is valid business data. */
export function requireCustomerBindingAuthoritativeRow(rows: readonly unknown[]): boolean {
  const row = rows[0];
  if (row === undefined || row === null) {
    throw new ElizaError(
      "Account billing customer-binding authority did not return its required row",
      {
        code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
        context: {
          source: CUSTOMER_BINDING_AUTHORITY_SOURCE,
          reason: "missing_scalar_row",
        },
        severity: "fatal",
      },
    );
  }

  const authoritative =
    typeof row === "object" && "authoritative" in row
      ? (row as { authoritative: unknown }).authoritative
      : undefined;
  if (typeof authoritative !== "boolean") {
    throw new ElizaError("Account billing customer-binding authority did not return a boolean", {
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      context: {
        source: CUSTOMER_BINDING_AUTHORITY_SOURCE,
        field: CUSTOMER_BINDING_AUTHORITY_FIELD,
        reason: "non_boolean_scalar",
      },
      severity: "fatal",
    });
  }

  return authoritative;
}

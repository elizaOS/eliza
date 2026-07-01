/**
 * Unit test for the static tenant-scope gate (#9853 P1.6, GAP B).
 *
 * Drives `findUnscopedTenantReads` (the core of scripts/check-tenant-scope.ts)
 * over two parse-only fixtures: an UNSCOPED repository (pk-only read against a
 * tenant data-plane table) must be flagged, and a SCOPED one (annotated, or
 * carrying an ownership predicate) must pass. The CLI form of the same function
 * gates the real repositories/ tree in cloud-tests.yml.
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { findUnscopedTenantReads } from "../../../../scripts/check-tenant-scope.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../scripts/__fixtures__/tenant-scope/${name}`, import.meta.url));

describe("tenant-scope gate (#9853 P1.6)", () => {
  test("flags a pk-only read against a tenant data-plane table", () => {
    const violations = findUnscopedTenantReads([fixture("unscoped.ts")]);
    expect(violations).toHaveLength(6);
    expect(violations.map((v) => v.method).sort()).toEqual([
      "findById",
      "findByIdWrappedInAnd",
      "findByIdWrappedInOr",
      "findByIds",
      "findByNestedSpreadConditions",
      "findBySpreadConditions",
    ]);
    for (const violation of violations) {
      expect(violation.table).toBe("apps");
    }
  });

  test("passes when the read is annotated global-scope or carries an ownership predicate", () => {
    expect(findUnscopedTenantReads([fixture("scoped.ts")])).toHaveLength(0);
  });
});

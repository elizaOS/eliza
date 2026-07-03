/**
 * Unit coverage for the admin-role rank/predicate helpers. Pure functions, no
 * harness.
 */
import {
  ADMIN_ROLE_RANK,
  adminRoleRank,
  isAdminRole,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import { describe, expect, it } from "vitest";

/**
 * The canonical admin-role helpers (#12087 Item 21). One `isAdminRole` guard
 * and one `adminRoleRank` replace the two hand-written predicates that lived in
 * `use-admin-gate.ts` (header validation) and `ModerationPage.tsx`.
 */
describe("isAdminRole", () => {
  it("accepts every recognized admin tier", () => {
    expect(isAdminRole("super_admin")).toBe(true);
    expect(isAdminRole("moderator")).toBe(true);
    expect(isAdminRole("viewer")).toBe(true);
  });

  it("rejects unknown / empty / null values (fail closed)", () => {
    expect(isAdminRole("owner")).toBe(false);
    expect(isAdminRole("admin")).toBe(false);
    expect(isAdminRole("")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole(42)).toBe(false);
  });
});

describe("adminRoleRank", () => {
  it("orders super_admin > moderator > viewer", () => {
    expect(adminRoleRank("super_admin")).toBeGreaterThan(
      adminRoleRank("moderator"),
    );
    expect(adminRoleRank("moderator")).toBeGreaterThan(adminRoleRank("viewer"));
  });

  it("ranks unknown/null below every real tier", () => {
    expect(adminRoleRank(null)).toBe(-1);
    expect(adminRoleRank(undefined)).toBe(-1);
    expect(adminRoleRank(null)).toBeLessThan(adminRoleRank("viewer"));
  });

  it("matches the ADMIN_ROLE_RANK table", () => {
    expect(adminRoleRank("viewer")).toBe(ADMIN_ROLE_RANK.viewer);
    expect(adminRoleRank("super_admin")).toBe(ADMIN_ROLE_RANK.super_admin);
  });
});

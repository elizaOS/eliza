import { describe, expect, it } from "vitest";
import {
  canManageOrg,
  isOrgOwner,
  isOrgRole,
  ORG_ROLE_RANK,
  orgRoleRank,
} from "./cloud-org-types";

/**
 * Canonical org-role helpers (#12087 Item 22). One typed union + rank table
 * replace the scattered `role === "owner" || role === "admin"` comparisons in
 * members-tab / credentials-tab / members-list.
 */
describe("isOrgRole", () => {
  it("accepts every recognized tier and rejects the rest", () => {
    expect(isOrgRole("owner")).toBe(true);
    expect(isOrgRole("admin")).toBe(true);
    expect(isOrgRole("member")).toBe(true);
    expect(isOrgRole("super_admin")).toBe(false);
    expect(isOrgRole("")).toBe(false);
    expect(isOrgRole(null)).toBe(false);
    expect(isOrgRole(undefined)).toBe(false);
  });
});

describe("orgRoleRank", () => {
  it("orders owner > admin > member", () => {
    expect(orgRoleRank("owner")).toBeGreaterThan(orgRoleRank("admin"));
    expect(orgRoleRank("admin")).toBeGreaterThan(orgRoleRank("member"));
  });

  it("ranks unknown/null below every real tier (fail closed)", () => {
    expect(orgRoleRank(null)).toBe(-1);
    expect(orgRoleRank("bogus")).toBe(-1);
    expect(orgRoleRank(null)).toBeLessThan(orgRoleRank("member"));
  });

  it("matches the ORG_ROLE_RANK table", () => {
    expect(orgRoleRank("member")).toBe(ORG_ROLE_RANK.member);
    expect(orgRoleRank("owner")).toBe(ORG_ROLE_RANK.owner);
  });
});

describe("canManageOrg", () => {
  it("is true for owner and admin, false for member/unknown", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("member")).toBe(false);
    expect(canManageOrg(null)).toBe(false);
    expect(canManageOrg("bogus")).toBe(false);
  });
});

describe("isOrgOwner", () => {
  it("is true only for owner", () => {
    expect(isOrgOwner("owner")).toBe(true);
    expect(isOrgOwner("admin")).toBe(false);
    expect(isOrgOwner("member")).toBe(false);
    expect(isOrgOwner(null)).toBe(false);
  });
});

describe("removal predicate (rank-based, as members-list applies it)", () => {
  // A manager may remove anyone strictly below their own tier; a manager cannot
  // remove an owner, a peer of the same tier, or (for a member) anyone at all.
  const canRemove = (actor: string, target: string): boolean =>
    !isOrgOwner(target) &&
    canManageOrg(actor) &&
    orgRoleRank(actor) > orgRoleRank(target);

  it("owner removes admins and members", () => {
    expect(canRemove("owner", "admin")).toBe(true);
    expect(canRemove("owner", "member")).toBe(true);
  });

  it("admin removes members but NOT other admins or the owner", () => {
    expect(canRemove("admin", "member")).toBe(true);
    expect(canRemove("admin", "admin")).toBe(false);
    expect(canRemove("admin", "owner")).toBe(false);
  });

  it("members can remove no one", () => {
    expect(canRemove("member", "member")).toBe(false);
    expect(canRemove("member", "admin")).toBe(false);
  });
});

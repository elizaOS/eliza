/**
 * Unit tests for cloud organization types: validates role rank and permission logic.
 */
import { describe, expect, it } from "vitest";
import {
  canManageOrg,
  isOrgOwner,
  isOrgRole,
  ORG_ROLE_RANK,
  orgRoleRank,
} from "./cloud-org-types.ts";

describe("cloud-org-types", () => {
  it("validates recognized org roles with isOrgRole", () => {
    expect(isOrgRole("owner")).toBe(true);
    expect(isOrgRole("admin")).toBe(true);
    expect(isOrgRole("member")).toBe(true);
    expect(isOrgRole("viewer")).toBe(false);
    expect(isOrgRole(null)).toBe(false);
  });

  it("ranks roles correctly (owner > admin > member > unknown)", () => {
    expect(orgRoleRank("owner")).toBe(ORG_ROLE_RANK.owner);
    expect(orgRoleRank("admin")).toBe(ORG_ROLE_RANK.admin);
    expect(orgRoleRank("member")).toBe(ORG_ROLE_RANK.member);
    expect(orgRoleRank("unknown")).toBe(-1);
    expect(orgRoleRank(undefined)).toBe(-1);
  });

  it("determines management capabilities", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("member")).toBe(false);
    expect(canManageOrg(null)).toBe(false);
  });

  it("identifies org owner", () => {
    expect(isOrgOwner("owner")).toBe(true);
    expect(isOrgOwner("admin")).toBe(false);
    expect(isOrgOwner("member")).toBe(false);
  });
});

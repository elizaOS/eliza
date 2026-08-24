/**
 * Pins the org RBAC ladder and the pooled-provider list this module mirrors.
 * `canManageOrg` gates the org settings surface, so its ordering and its
 * fail-closed behaviour on unknown roles are the contract worth freezing; the
 * provider list is a hand-maintained mirror of the cloud-shared source of truth
 * and drifts silently. Pure module, no harness.
 */

import { describe, expect, it } from "vitest";
import {
  canManageOrg,
  isOrgOwner,
  isOrgRole,
  ORG_ROLE_RANK,
  type OrgRole,
  orgRoleRank,
  POOLED_PROVIDER_LABELS,
  POOLED_PROVIDERS,
} from "./cloud-org-types";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

/** Values that must never be mistaken for a role. */
const NON_ROLES = [
  "",
  " ",
  "Owner",
  "OWNER",
  "owner ",
  "admin\n",
  "guest",
  "root",
  "superuser",
  "toString",
  "constructor",
  "hasOwnProperty",
  "__proto__",
  null,
  undefined,
] as const;

describe("isOrgRole", () => {
  it("accepts exactly the three declared roles", () => {
    for (const role of ROLES) expect(isOrgRole(role)).toBe(true);
  });

  it("rejects near-misses, inherited keys, and nullish values", () => {
    for (const value of NON_ROLES) expect(isOrgRole(value)).toBe(false);
  });

  it("rejects non-string types", () => {
    for (const value of [0, 1, 2, true, false, {}, [], Symbol("owner")]) {
      expect(isOrgRole(value)).toBe(false);
    }
  });
});

describe("orgRoleRank", () => {
  it("orders the ladder owner > admin > member", () => {
    expect(orgRoleRank("owner")).toBeGreaterThan(orgRoleRank("admin"));
    expect(orgRoleRank("admin")).toBeGreaterThan(orgRoleRank("member"));
  });

  it("agrees with the exported rank table", () => {
    for (const role of ROLES)
      expect(orgRoleRank(role)).toBe(ORG_ROLE_RANK[role]);
  });

  it("fails closed below every real tier for unknown roles", () => {
    const lowest = Math.min(...ROLES.map((role) => ORG_ROLE_RANK[role]));
    for (const value of NON_ROLES) {
      expect(orgRoleRank(value as string | null | undefined)).toBe(-1);
      expect(orgRoleRank(value as string | null | undefined)).toBeLessThan(
        lowest,
      );
    }
  });

  it("assigns every role a distinct rank", () => {
    const ranks = ROLES.map((role) => ORG_ROLE_RANK[role]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("canManageOrg", () => {
  it("admits owner and admin", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
  });

  it("refuses member", () => {
    expect(canManageOrg("member")).toBe(false);
  });

  it("refuses every unknown or nullish role", () => {
    for (const value of NON_ROLES) {
      expect(canManageOrg(value as string | null | undefined)).toBe(false);
    }
  });

  it("is exactly rank >= admin", () => {
    for (const role of ROLES) {
      expect(canManageOrg(role)).toBe(orgRoleRank(role) >= ORG_ROLE_RANK.admin);
    }
  });
});

describe("isOrgOwner", () => {
  it("is true only for owner", () => {
    expect(isOrgOwner("owner")).toBe(true);
    expect(isOrgOwner("admin")).toBe(false);
    expect(isOrgOwner("member")).toBe(false);
  });

  it("refuses every unknown or nullish role", () => {
    for (const value of NON_ROLES) {
      expect(isOrgOwner(value as string | null | undefined)).toBe(false);
    }
  });

  it("implies canManageOrg", () => {
    for (const role of ROLES) {
      if (isOrgOwner(role)) expect(canManageOrg(role)).toBe(true);
    }
  });

  it("is the unique top of the ladder", () => {
    const top = Math.max(...ROLES.map((role) => ORG_ROLE_RANK[role]));
    for (const role of ROLES) {
      expect(isOrgOwner(role)).toBe(ORG_ROLE_RANK[role] === top);
    }
  });
});

describe("pooled providers", () => {
  // Mirror of POOLED_DIRECT_PROVIDERS in
  // cloud/shared/src/lib/services/team-credential-pool/provider-map.ts, which
  // this module's doc comment names as the source of truth. @elizaos/ui
  // deliberately does not depend on the cloud-shared bundle, so the list is
  // pinned by value: drift on either side fails here instead of silently
  // rendering a provider the backend refuses (or omitting one it accepts).
  it("matches the cloud-shared pooled provider list", () => {
    expect([...POOLED_PROVIDERS]).toEqual([
      "anthropic-api",
      "openai-api",
      "deepseek-api",
      "zai-api",
      "moonshot-api",
      "cerebras-api",
    ]);
  });

  it("never includes a Phase-2 subscription provider", () => {
    for (const id of [
      "anthropic-subscription",
      "openai-codex",
      "gemini-cli",
      "zai-coding",
      "kimi-coding",
      "deepseek-coding",
    ]) {
      expect([...POOLED_PROVIDERS]).not.toContain(id);
    }
  });

  it("carries no duplicates", () => {
    expect(new Set(POOLED_PROVIDERS).size).toBe(POOLED_PROVIDERS.length);
  });

  it("labels exactly the declared providers, with no empty label", () => {
    expect(Object.keys(POOLED_PROVIDER_LABELS).sort()).toEqual(
      [...POOLED_PROVIDERS].sort(),
    );
    for (const id of POOLED_PROVIDERS) {
      expect(POOLED_PROVIDER_LABELS[id].trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every provider a distinct label", () => {
    const labels = Object.values(POOLED_PROVIDER_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

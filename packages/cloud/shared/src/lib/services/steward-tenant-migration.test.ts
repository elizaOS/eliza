/**
 * Tests for the one-off Steward tenant backfill (#14645).
 *
 * PR #14869 provisions Steward tenants eagerly at signup, but orgs created
 * before that fix still have steward_tenant_id = NULL and 403-loop on
 * /steward/user/me/tenants. `backfillStewardTenants` provisions a tenant for
 * each such org. Asserted here:
 *   (a) every NULL-tenant candidate is provisioned exactly once,
 *   (b) FAIL-OPEN accounting: one org failing does NOT abort the run — the
 *       others still provision and the failure is counted, not thrown,
 *   (c) --dry-run provisions nothing but reports the candidate count,
 *   (d) --max-orgs caps how many candidates are processed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Candidate rows the mocked readQuery returns (NULL-tenant orgs).
let candidateRows: Array<{ id: string }> = [];
const ensureStewardTenantCalls: string[] = [];
let failForOrgId: string | null = null;

mock.module("../../db/helpers", () => ({
  // The service passes an async (db) => query builder; we bypass the real DB
  // and hand back the staged candidate rows.
  readQuery: async () => candidateRows,
}));

mock.module("./steward-tenant-config", () => ({
  ensureStewardTenant: async (organizationId: string) => {
    ensureStewardTenantCalls.push(organizationId);
    if (failForOrgId && organizationId === failForOrgId) {
      throw new Error(`Steward unreachable for ${organizationId}`);
    }
    return { tenantId: `elizacloud-${organizationId}`, isNew: true };
  },
}));

mock.module("../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

describe("backfillStewardTenants (#14645)", () => {
  beforeEach(() => {
    candidateRows = [];
    ensureStewardTenantCalls.length = 0;
    failForOrgId = null;
  });

  test("provisions a tenant for every NULL-tenant org exactly once", async () => {
    candidateRows = [{ id: "org-a" }, { id: "org-b" }, { id: "org-c" }];
    const { backfillStewardTenants } = await import("./steward-tenant-migration");

    const summary = await backfillStewardTenants();

    expect(ensureStewardTenantCalls.sort()).toEqual(["org-a", "org-b", "org-c"]);
    expect(summary).toEqual({ scanned: 3, provisioned: 3, failed: 0, dryRun: false });
  });

  test("FAIL-OPEN: one org failing does not abort the run; it is counted", async () => {
    candidateRows = [{ id: "org-a" }, { id: "org-bad" }, { id: "org-c" }];
    failForOrgId = "org-bad";
    const { backfillStewardTenants } = await import("./steward-tenant-migration");

    const summary = await backfillStewardTenants({ batchSize: 10 });

    // All three were attempted; the good two succeeded, the bad one is counted.
    expect(ensureStewardTenantCalls.sort()).toEqual(["org-a", "org-bad", "org-c"]);
    expect(summary.scanned).toBe(3);
    expect(summary.provisioned).toBe(2);
    expect(summary.failed).toBe(1);
  });

  test("--dry-run provisions nothing but reports the candidate count", async () => {
    candidateRows = [{ id: "org-a" }, { id: "org-b" }];
    const { backfillStewardTenants } = await import("./steward-tenant-migration");

    const summary = await backfillStewardTenants({ dryRun: true });

    expect(ensureStewardTenantCalls).toHaveLength(0);
    expect(summary).toEqual({ scanned: 2, provisioned: 0, failed: 0, dryRun: true });
  });

  test("--max-orgs caps how many candidates are processed", async () => {
    candidateRows = [{ id: "org-a" }, { id: "org-b" }, { id: "org-c" }, { id: "org-d" }];
    const { backfillStewardTenants } = await import("./steward-tenant-migration");

    const summary = await backfillStewardTenants({ maxOrgs: 2 });

    expect(ensureStewardTenantCalls).toHaveLength(2);
    expect(summary.scanned).toBe(2);
    expect(summary.provisioned).toBe(2);
  });
});

/**
 * Real admin route + PGlite coverage for selecting and explicitly re-reviewing
 * one retained personal Dedicated row without provisioning or touching
 * duplicate compute inventory.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import {
  type AgentExecutionTier,
  type AgentSandboxPoolStatus,
  type AgentSandboxStatus,
  agentSandboxBackups,
  agentSandboxes,
} from "@/db/schemas/agent-sandboxes";
import { jobs } from "@/db/schemas/jobs";
import { organizations } from "@/db/schemas/organizations";
import { personalDedicatedAdoptionSelections } from "@/db/schemas/personal-dedicated-adoption-selections";
import { personalDedicatedUpgradeAuthorities } from "@/db/schemas/personal-dedicated-upgrade-authorities";
import { users } from "@/db/schemas/users";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { computeStateHash } from "@/lib/services/agent-backup-diff";
import {
  adoptPersonalDedicatedTargetWithProvision,
  resolvePersonalDedicatedAdoption,
} from "@/lib/services/agent-tier-upgrade-target";
import { personalDedicatedAdoptionSelectionService } from "@/lib/services/personal-dedicated-adoption-selection";
import {
  provisioningJobService,
  resolveReviewedProvisionRestoreDirectiveForExecution,
} from "@/lib/services/provisioning-jobs";
import { personalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";
import { TIER_UPGRADE_TEST_TABLES } from "../../shared/src/lib/services/__tests__/tier-upgrade-pglite-schema";
import { createAdminPersonalDedicatedSelectionRoute } from "../v1/admin/personal-dedicated-adoption-selection/route";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const ADMIN = "dddddddd-4444-4444-8444-444444444444";
const RETAINED = "cccccccc-1111-4111-8111-111111111111";
const STALE = "cccccccc-2222-4222-8222-222222222222";
const SOURCE_A = personalSharedAgentId({
  organizationId: ORG_A,
  userId: USER_A,
});
const ENV = {} as AppEnv["Bindings"];

let role: "super_admin" | "moderator" = "super_admin";
let adminIdentity = {
  id: ADMIN,
  email: "admin@example.test",
  organization_id: ORG_B,
  organization: { id: ORG_B, name: "Admin Org", is_active: true },
};
type RouteDependencies = NonNullable<
  Parameters<typeof createAdminPersonalDedicatedSelectionRoute>[0]
>;
const route = createAdminPersonalDedicatedSelectionRoute({
  requireAdmin: (async () => ({
    user: adminIdentity,
    role,
  })) as RouteDependencies["requireAdmin"],
  selectionService: personalDedicatedAdoptionSelectionService,
  logger: { info: () => undefined },
});
const app = new Hono<AppEnv>();
app.route("/api/v1/admin/personal-dedicated-adoption-selection", route);

async function seedCandidate(params: {
  id: string;
  organizationId?: string;
  userId?: string;
  status?: AgentSandboxStatus;
  executionTier?: AgentExecutionTier;
  poolStatus?: AgentSandboxPoolStatus | null;
  deletedAt?: Date | null;
  deletionAttemptId?: string | null;
  agentConfig?: Record<string, unknown>;
  lifecycleRevision?: number;
}) {
  await dbWrite.insert(agentSandboxes).values({
    id: params.id,
    organization_id: params.organizationId ?? ORG_A,
    user_id: params.userId ?? USER_A,
    agent_name: params.id === RETAINED ? "Retained" : "Stale",
    execution_tier: params.executionTier ?? "dedicated-always",
    status: params.status ?? "error",
    database_status: "ready",
    database_uri: "postgresql://private.invalid/tenant",
    agent_config: params.agentConfig ?? {},
    lifecycle_revision:
      params.lifecycleRevision ?? (params.id === RETAINED ? 5749 : 0),
    pool_status: params.poolStatus ?? null,
    deleted_at: params.deletedAt ?? null,
    deletion_attempt_id: params.deletionAttemptId ?? null,
    bridge_url: "http://100.64.12.34:3000",
    headscale_ip: "100.64.12.34",
    docker_image: "ghcr.io/elizaos/eliza:latest",
    image_digest: `sha256:${params.id === RETAINED ? "a" : "b"}`.padEnd(
      71,
      params.id === RETAINED ? "a" : "b",
    ),
  });
}

async function seedAmbiguousInventory() {
  await seedCandidate({
    id: RETAINED,
    status: "error",
    lifecycleRevision: 5749,
  });
  await seedCandidate({ id: STALE, status: "error", lifecycleRevision: 0 });
}

function requestBody(dryRun: true): Record<string, unknown>;
function requestBody(
  dryRun: false,
  inventoryFingerprint: string,
  stateDisposition?:
    | "verified_backup_present"
    | "fresh_boot_no_verified_backup",
): Record<string, unknown>;
function requestBody(
  dryRun: boolean,
  inventoryFingerprint?: string,
  stateDisposition = "fresh_boot_no_verified_backup",
) {
  return {
    action: "select_existing_personal_dedicated",
    targetOwnerOrganizationId: ORG_A,
    targetOwnerUserId: USER_A,
    retainedAgentId: RETAINED,
    reason: "duplicate_owned_dedicated_inventory",
    dryRun,
    ...(dryRun
      ? {}
      : {
          inventoryFingerprint,
          stateDisposition,
          confirmation: "select_without_provisioning_or_deleting",
        }),
  };
}

async function post(body: unknown) {
  return await app.request(
    "/api/v1/admin/personal-dedicated-adoption-selection",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

async function previewFingerprint(): Promise<string> {
  const response = await post(requestBody(true));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { inventoryFingerprint: string };
  };
  return body.data.inventoryFingerprint;
}

function rereviewRequestBody(
  retainedAgentId: string,
  dryRun: true,
): Record<string, unknown>;
function rereviewRequestBody(
  retainedAgentId: string,
  dryRun: false,
  preview: {
    receiptFingerprint: string;
    receiptUpdatedAt: string;
    previousRetainedAgentId: string;
    inventoryFingerprint: string;
    stateDisposition:
      | "verified_backup_present"
      | "fresh_boot_no_verified_backup";
  },
): Record<string, unknown>;
function rereviewRequestBody(
  retainedAgentId: string,
  dryRun: boolean,
  preview?: {
    receiptFingerprint: string;
    receiptUpdatedAt: string;
    previousRetainedAgentId: string;
    inventoryFingerprint: string;
    stateDisposition:
      | "verified_backup_present"
      | "fresh_boot_no_verified_backup";
  },
) {
  return {
    action: "rereview_existing_personal_dedicated",
    targetOwnerOrganizationId: ORG_A,
    targetOwnerUserId: USER_A,
    retainedAgentId,
    reason: "duplicate_owned_dedicated_inventory",
    dryRun,
    ...(dryRun
      ? {}
      : {
          receiptFingerprint: preview?.receiptFingerprint,
          receiptUpdatedAt: preview?.receiptUpdatedAt,
          previousRetainedAgentId: preview?.previousRetainedAgentId,
          inventoryFingerprint: preview?.inventoryFingerprint,
          stateDisposition: preview?.stateDisposition,
          confirmation: "rereview_without_provisioning_or_deleting",
        }),
  };
}

async function seedStaleSelection() {
  await seedAmbiguousInventory();
  const inventoryFingerprint = await previewFingerprint();
  await personalDedicatedAdoptionSelectionService.execute({
    organizationId: ORG_A,
    userId: USER_A,
    sourceAgentId: SOURCE_A,
    retainedAgentId: RETAINED,
    selectedByUserId: ADMIN,
    reason: "duplicate_owned_dedicated_inventory",
    expectedInventoryFingerprint: inventoryFingerprint,
    expectedStateDisposition: "fresh_boot_no_verified_backup",
  });
  const [selection] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections);
  if (!selection) throw new Error("selection fixture was not persisted");
  return selection;
}

async function rereviewPreview(retainedAgentId = RETAINED) {
  const response = await post(rereviewRequestBody(retainedAgentId, true));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: {
      receiptFingerprint: string;
      receiptUpdatedAt: string;
      inventoryFingerprint: string;
      stateDisposition:
        | "verified_backup_present"
        | "fresh_boot_no_verified_backup";
      candidateCount: number;
      previousRetainedAgentId: string;
      retainedAgentId: string;
      replacesTarget: boolean;
    };
  };
  return body.data;
}

beforeAll(async () => {
  for (const ddl of TIER_UPGRADE_TEST_TABLES) await dbWrite.execute(ddl);
  await dbWrite.insert(organizations).values([
    {
      id: ORG_A,
      name: "Owner Org",
      slug: "owner-org-selection",
      credit_balance: "100",
    },
    {
      id: ORG_B,
      name: "Admin Org",
      slug: "admin-org-selection",
      credit_balance: "100",
    },
  ]);
  await dbWrite.insert(users).values([
    {
      id: USER_A,
      organization_id: ORG_A,
      steward_user_id: "owner-selection-a",
      role: "owner",
    },
    {
      id: USER_B,
      organization_id: ORG_A,
      steward_user_id: "owner-selection-b",
      role: "owner",
    },
    {
      id: ADMIN,
      organization_id: ORG_B,
      steward_user_id: "admin-selection",
      role: "owner",
    },
  ]);
}, 120_000);

beforeEach(async () => {
  role = "super_admin";
  adminIdentity = {
    id: ADMIN,
    email: "admin@example.test",
    organization_id: ORG_B,
    organization: { id: ORG_B, name: "Admin Org", is_active: true },
  };
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(personalDedicatedUpgradeAuthorities);
  await dbWrite.delete(personalDedicatedAdoptionSelections);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("admin personal Dedicated adoption selection", () => {
  test("previews exact ambiguous inventory without mutation or private coordinates", async () => {
    await seedAmbiguousInventory();
    const response = await post(requestBody(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      dryRun: true,
      data: {
        retainedAgentId: RETAINED,
        retainedStatus: "error",
        retainedLifecycleRevision: 5749,
        stateDisposition: "fresh_boot_no_verified_backup",
        candidateCount: 2,
        alreadySelected: false,
        startsCompute: false,
        createsJob: false,
        deletesRows: false,
        changesCutover: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("100.64.");
    expect(JSON.stringify(body)).not.toContain("postgresql://");
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("requires super-admin before reading target inventory", async () => {
    await seedAmbiguousInventory();
    role = "moderator";
    const response = await post(requestBody(true));
    expect(response.status).toBe(403);
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);
  });

  test("the synthetic local admin records nullable attribution instead of violating the user FK", async () => {
    await seedAmbiguousInventory();
    adminIdentity = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "local-dev-admin@localhost",
      organization_id: "00000000-0000-4000-8000-000000000002",
      organization: {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Local Dev",
        is_active: true,
      },
    };
    const fingerprint = await previewFingerprint();
    const response = await post(requestBody(false, fingerprint));
    expect(response.status).toBe(200);
    const [selection] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(selection?.selected_by_user_id).toBeNull();
  });

  test("wrong organization, wrong owner, and excluded retained rows are indistinguishable 404s", async () => {
    await seedCandidate({
      id: RETAINED,
      organizationId: ORG_B,
      userId: USER_A,
    });
    await seedCandidate({ id: STALE, organizationId: ORG_B, userId: USER_A });
    expect((await post(requestBody(true))).status).toBe(404);

    await dbWrite.delete(agentSandboxes);
    await seedCandidate({ id: RETAINED, userId: USER_B });
    await seedCandidate({ id: STALE, userId: USER_B });
    expect((await post(requestBody(true))).status).toBe(404);

    const excluded = [
      { id: RETAINED, executionTier: "shared" },
      { id: RETAINED, executionTier: "dedicated-lazy" },
      { id: RETAINED, executionTier: "custom" },
      { id: RETAINED, poolStatus: "unclaimed" },
      { id: RETAINED, deletedAt: new Date("2026-08-25T12:00:00.000Z") },
      {
        id: RETAINED,
        deletionAttemptId: "eeeeeeee-5555-4555-8555-555555555555",
      },
      { id: RETAINED, status: "pending" },
      { id: RETAINED, status: "provisioning" },
      { id: RETAINED, status: "disconnected" },
    ] satisfies Array<Parameters<typeof seedCandidate>[0]>;
    for (const candidate of excluded) {
      await dbWrite.delete(agentSandboxes);
      await seedCandidate(candidate);
      await seedCandidate({ id: STALE, status: "error" });
      expect((await post(requestBody(true))).status).toBe(404);
    }
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);
  });

  test("explicitly supports stable error, stopped, and running retained rows", async () => {
    for (const status of ["error", "stopped", "running"] as const) {
      await dbWrite.delete(agentSandboxes);
      await seedCandidate({ id: RETAINED, status });
      await seedCandidate({ id: STALE, status: "error" });
      const response = await post(requestBody(true));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { retainedAgentId: RETAINED, retainedStatus: status },
      });
    }
  });

  test("rejects stale inventory fingerprint and active lifecycle work without partial selection", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: 5750 })
      .where(eq(agentSandboxes.id, RETAINED));
    expect((await post(requestBody(false, fingerprint))).status).toBe(409);
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);

    const current = await previewFingerprint();
    await dbWrite.insert(jobs).values({
      type: "agent_provision",
      status: "pending",
      data: { agentId: STALE, organizationId: ORG_A, userId: USER_A },
      agent_id: STALE,
      organization_id: ORG_A,
      user_id: USER_A,
    });
    expect((await post(requestBody(false, current))).status).toBe(409);
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);
  });

  test("binds database, image, and backup provenance before selection", async () => {
    for (const mutation of [
      { database_uri: "postgresql://private.invalid/replaced" },
      { image_digest: `sha256:${"c".repeat(64)}` },
    ]) {
      await dbWrite.delete(agentSandboxBackups);
      await dbWrite.delete(agentSandboxes);
      await seedAmbiguousInventory();
      const fingerprint = await previewFingerprint();
      await dbWrite
        .update(agentSandboxes)
        .set(mutation)
        .where(eq(agentSandboxes.id, RETAINED));
      expect((await post(requestBody(false, fingerprint))).status).toBe(409);
      expect(
        await dbWrite.select().from(personalDedicatedAdoptionSelections),
      ).toHaveLength(0);
    }

    await dbWrite.delete(agentSandboxes);
    await seedAmbiguousInventory();
    const noBackupFingerprint = await previewFingerprint();
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: RETAINED,
      snapshot_type: "manual",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      content_hash: "d".repeat(64),
      verification_status: "verified",
      verified_at: new Date("2026-08-26T12:00:00.000Z"),
    });
    expect((await post(requestBody(false, noBackupFingerprint))).status).toBe(
      409,
    );

    const verifiedPreview = await post(requestBody(true));
    expect(verifiedPreview.status).toBe(200);
    const verifiedBody = (await verifiedPreview.json()) as {
      data: { inventoryFingerprint: string; stateDisposition: string };
    };
    expect(verifiedBody.data.stateDisposition).toBe("verified_backup_present");
    expect(
      (
        await post(
          requestBody(
            false,
            verifiedBody.data.inventoryFingerprint,
            "verified_backup_present",
          ),
        )
      ).status,
    ).toBe(200);
    await dbWrite.delete(agentSandboxBackups);
    await expect(
      personalDedicatedAdoptionSelectionService.execute({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        retainedAgentId: RETAINED,
        selectedByUserId: ADMIN,
        reason: "duplicate_owned_dedicated_inventory",
        expectedInventoryFingerprint: verifiedBody.data.inventoryFingerprint,
        expectedStateDisposition: "verified_backup_present",
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
    });
    expect((await post(requestBody(true))).status).toBe(409);
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toEqual({ state: "unavailable" });
  });

  test("only canonical catalog-v2/manifest-v3 protected states are restorable", async () => {
    for (const manifestVersion of [2, 3] as const) {
      await dbWrite.delete(agentSandboxBackups);
      await dbWrite.delete(agentSandboxes);
      await seedAmbiguousInventory();
      const [backup] = await dbWrite
        .insert(agentSandboxBackups)
        .values({
          sandbox_record_id: RETAINED,
          snapshot_type: "auto",
          state_data: { memories: [], config: {}, workspaceFiles: {} },
          verification_status: null,
          verified_at: null,
          catalog_version: 2,
          catalog_state: "primary_uploaded",
          catalog_payload_digest: "c".repeat(64),
          catalog_organization_id: ORG_A,
          catalog_agent_id: RETAINED,
          manifest_version: manifestVersion,
          manifest_digest: "d".repeat(64),
          object_inventory_digest: "e".repeat(64),
        })
        .returning();

      const uploaded = await post(requestBody(true));
      expect(uploaded.status).toBe(200);
      expect(await uploaded.json()).toMatchObject({
        data: { stateDisposition: "fresh_boot_no_verified_backup" },
      });

      await dbWrite
        .update(agentSandboxBackups)
        .set({ catalog_state: "protected" })
        .where(eq(agentSandboxBackups.id, backup!.id));
      const protectedBackup = await post(requestBody(true));
      expect(protectedBackup.status).toBe(200);
      expect(await protectedBackup.json()).toMatchObject({
        data: {
          stateDisposition:
            manifestVersion === 3
              ? "verified_backup_present"
              : "fresh_boot_no_verified_backup",
        },
      });
    }

    await dbWrite.delete(agentSandboxBackups);
    for (const catalogState of [
      "primary_verified",
      "secondary_pending",
    ] as const) {
      const [backup] = await dbWrite
        .insert(agentSandboxBackups)
        .values({
          sandbox_record_id: RETAINED,
          snapshot_type: "auto",
          state_data: { memories: [], config: {}, workspaceFiles: {} },
          catalog_version: 2,
          catalog_state: catalogState,
          catalog_payload_digest: "c".repeat(64),
          catalog_organization_id: ORG_A,
          catalog_agent_id: RETAINED,
          manifest_version: 3,
          manifest_digest: "d".repeat(64),
          object_inventory_digest: "e".repeat(64),
        })
        .returning();
      const preview = await post(requestBody(true));
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        data: { stateDisposition: "fresh_boot_no_verified_backup" },
      });
      await dbWrite
        .delete(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, backup!.id));
    }
  });

  test("treats backfilled catalogue-v1 rows as verified legacy restore points", async () => {
    await seedAmbiguousInventory();
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: RETAINED,
      snapshot_type: "auto",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      content_hash: "a".repeat(64),
      verification_status: "verified",
      verified_at: new Date("2026-08-25T12:00:00.000Z"),
      catalog_version: 1,
      catalog_state: "legacy_unmigrated",
      catalog_payload_digest: "b".repeat(64),
      catalog_organization_id: ORG_A,
      catalog_agent_id: RETAINED,
    });

    const preview = await post(requestBody(true));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      data: { stateDisposition: "verified_backup_present" },
    });
  });

  test("selects only the retained row and leaves agents, jobs, markers, and cutover untouched", async () => {
    await seedAmbiguousInventory();
    const before = await dbWrite.select().from(agentSandboxes);
    const fingerprint = await previewFingerprint();
    const response = await post(requestBody(false, fingerprint));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      dryRun: false,
      data: {
        retainedAgentId: RETAINED,
        candidateCount: 2,
        startsCompute: false,
        createsJob: false,
        deletesRows: false,
        changesCutover: false,
      },
    });

    const after = await dbWrite.select().from(agentSandboxes);
    expect(after).toEqual(before);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    expect(
      await dbWrite.select().from(personalDedicatedUpgradeAuthorities),
    ).toHaveLength(0);
    const [selection] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(selection).toMatchObject({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SOURCE_A,
      dedicated_agent_id: RETAINED,
      selected_by_user_id: ADMIN,
      selection_reason: "duplicate_owned_dedicated_inventory",
      inventory_fingerprint: fingerprint,
      candidate_count: 2,
    });

    const resolved = await resolvePersonalDedicatedAdoption({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
    });
    expect(resolved).toMatchObject({
      state: "available",
      agent: { id: RETAINED },
    });

    const replay = await post(requestBody(true));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        retainedAgentId: RETAINED,
        candidateCount: 2,
        alreadySelected: true,
      },
    });
  });

  test("idempotent execute replay succeeds only against the complete unchanged inventory", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    const execute = () =>
      personalDedicatedAdoptionSelectionService.execute({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        retainedAgentId: RETAINED,
        selectedByUserId: ADMIN,
        reason: "duplicate_owned_dedicated_inventory",
        expectedInventoryFingerprint: fingerprint,
        expectedStateDisposition: "fresh_boot_no_verified_backup",
      });

    expect(await execute()).toMatchObject({
      alreadySelected: false,
      candidateCount: 2,
    });
    expect(await execute()).toMatchObject({
      alreadySelected: true,
      candidateCount: 2,
    });

    await dbWrite.insert(jobs).values({
      type: "agent_provision",
      status: "pending",
      organization_id: ORG_A,
      agent_id: RETAINED,
      data: { agentId: RETAINED, organizationId: ORG_A },
    });
    await expect(execute()).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_ACTIVE_JOB",
    });
    await dbWrite.delete(jobs);

    await seedCandidate({ id: "cccccccc-3333-4333-8333-333333333333" });
    await expect(execute()).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
    });
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(1);
    expect((await post(requestBody(true))).status).toBe(409);
  });

  test("an invalidated selection fails closed instead of falling back to the stale row", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: fingerprint,
      expectedStateDisposition: "fresh_boot_no_verified_backup",
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "disconnected" })
      .where(eq(agentSandboxes.id, RETAINED));

    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toEqual({ state: "unavailable" });
  });

  test("explicitly re-reviews fingerprint drift without changing original audit identity", async () => {
    const original = await seedStaleSelection();
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: 5750 })
      .where(eq(agentSandboxes.id, RETAINED));

    const preview = await rereviewPreview();
    expect(preview).toMatchObject({
      receiptFingerprint: original.inventory_fingerprint,
      previousRetainedAgentId: RETAINED,
      retainedAgentId: RETAINED,
      candidateCount: 2,
      replacesTarget: false,
    });
    expect(preview.inventoryFingerprint).not.toBe(
      original.inventory_fingerprint,
    );

    const response = await post(rereviewRequestBody(RETAINED, false, preview));
    expect(response.status).toBe(200);
    const [refreshed] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(refreshed).toMatchObject({
      id: original.id,
      selected_by_user_id: original.selected_by_user_id,
      selected_at: original.selected_at,
      created_at: original.created_at,
      dedicated_agent_id: RETAINED,
      inventory_fingerprint: preview.inventoryFingerprint,
      candidate_count: 2,
    });
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toMatchObject({ state: "available", agent: { id: RETAINED } });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("re-reviews candidate-count drift and can explicitly replace the retained target", async () => {
    const original = await seedStaleSelection();
    const third = "cccccccc-3333-4333-8333-333333333333";
    await seedCandidate({ id: third, status: "stopped" });

    const preview = await rereviewPreview(STALE);
    expect(preview).toMatchObject({
      receiptFingerprint: original.inventory_fingerprint,
      previousRetainedAgentId: RETAINED,
      retainedAgentId: STALE,
      candidateCount: 3,
      replacesTarget: true,
    });
    const response = await post(rereviewRequestBody(STALE, false, preview));
    expect(response.status).toBe(200);
    const [replaced] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(replaced).toMatchObject({
      id: original.id,
      selected_by_user_id: original.selected_by_user_id,
      dedicated_agent_id: STALE,
      candidate_count: 3,
      inventory_fingerprint: preview.inventoryFingerprint,
    });
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toMatchObject({ state: "available", agent: { id: STALE } });
    expect(await dbWrite.select().from(agentSandboxes)).toHaveLength(3);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("rejects re-review when the named target is deleted or ineligible", async () => {
    const original = await seedStaleSelection();
    await dbWrite
      .update(agentSandboxes)
      .set({ status: "disconnected" })
      .where(eq(agentSandboxes.id, RETAINED));

    const response = await post(rereviewRequestBody(RETAINED, true));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "personal_dedicated_selection_not_found",
    });
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toEqual([original]);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("rejects re-review when activation authority already owns the source", async () => {
    const original = await seedStaleSelection();
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SOURCE_A,
      dedicated_agent_id: RETAINED,
    });

    const response = await post(rereviewRequestBody(RETAINED, true));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "personal_dedicated_selection_conflict",
    });
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toEqual([original]);
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("serializes concurrent stale-receipt refreshes with an exact receipt CAS", async () => {
    await seedStaleSelection();
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: 5750 })
      .where(eq(agentSandboxes.id, RETAINED));
    const preview = await rereviewPreview();
    const input = {
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory" as const,
      expectedReceiptFingerprint: preview.receiptFingerprint,
      expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
      expectedPreviousRetainedAgentId: preview.previousRetainedAgentId,
      expectedInventoryFingerprint: preview.inventoryFingerprint,
      expectedStateDisposition: preview.stateDisposition,
    };

    const results = await Promise.allSettled([
      personalDedicatedAdoptionSelectionService.executeRereview(input),
      personalDedicatedAdoptionSelectionService.executeRereview(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
      },
    });
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toMatchObject({ state: "available", agent: { id: RETAINED } });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
  });

  test("rejects a newer committed receipt target with the previewed fingerprint and version", async () => {
    await seedStaleSelection();
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: 5750 })
      .where(eq(agentSandboxes.id, RETAINED));
    const preview = await rereviewPreview();

    await dbWrite
      .update(personalDedicatedAdoptionSelections)
      .set({ dedicated_agent_id: STALE })
      .where(eq(personalDedicatedAdoptionSelections.source_agent_id, SOURCE_A));

    await expect(
      personalDedicatedAdoptionSelectionService.executeRereview({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        retainedAgentId: RETAINED,
        selectedByUserId: ADMIN,
        reason: "duplicate_owned_dedicated_inventory",
        expectedReceiptFingerprint: preview.receiptFingerprint,
        expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
        expectedPreviousRetainedAgentId: preview.previousRetainedAgentId,
        expectedInventoryFingerprint: preview.inventoryFingerprint,
        expectedStateDisposition: preview.stateDisposition,
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
    });
    const [receipt] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(receipt?.dedicated_agent_id).toBe(STALE);
    expect(receipt?.inventory_fingerprint).toBe(preview.receiptFingerprint);
  });

  test("rejects a newer committed receipt version with the previewed fingerprint and target", async () => {
    await seedStaleSelection();
    await dbWrite
      .update(agentSandboxes)
      .set({ lifecycle_revision: 5750 })
      .where(eq(agentSandboxes.id, RETAINED));
    const preview = await rereviewPreview();
    const newerReceiptVersion = new Date("2026-08-30T12:01:00.000Z");

    await dbWrite
      .update(personalDedicatedAdoptionSelections)
      .set({ updated_at: newerReceiptVersion })
      .where(eq(personalDedicatedAdoptionSelections.source_agent_id, SOURCE_A));

    await expect(
      personalDedicatedAdoptionSelectionService.executeRereview({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        retainedAgentId: RETAINED,
        selectedByUserId: ADMIN,
        reason: "duplicate_owned_dedicated_inventory",
        expectedReceiptFingerprint: preview.receiptFingerprint,
        expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
        expectedPreviousRetainedAgentId: preview.previousRetainedAgentId,
        expectedInventoryFingerprint: preview.inventoryFingerprint,
        expectedStateDisposition: preview.stateDisposition,
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
    });
    const [receipt] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(receipt?.dedicated_agent_id).toBe(RETAINED);
    expect(receipt?.updated_at.toISOString()).toBe(
      newerReceiptVersion.toISOString(),
    );
  });

  test("target deletion preserves selection and authority tombstones and fails closed", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: fingerprint,
      expectedStateDisposition: "fresh_boot_no_verified_backup",
    });
    await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, RETAINED));
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(1);
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toEqual({ state: "unavailable" });

    await dbWrite.delete(personalDedicatedAdoptionSelections);
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SOURCE_A,
      dedicated_agent_id: RETAINED,
    });
    expect(
      await dbWrite.select().from(personalDedicatedUpgradeAuthorities),
    ).toHaveLength(1);
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toEqual({ state: "unavailable" });
  });

  test("actor deletion nulls audit attribution while owner deletion cascades the receipt", async () => {
    const actorId = "dddddddd-5555-4555-8555-555555555555";
    await dbWrite.insert(users).values({
      id: actorId,
      organization_id: ORG_B,
      steward_user_id: "selection-actor-delete",
      role: "owner",
    });
    await seedAmbiguousInventory();
    const preview = await personalDedicatedAdoptionSelectionService.preview({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: actorId,
      reason: "duplicate_owned_dedicated_inventory",
    });
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: actorId,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: preview.inventoryFingerprint,
      expectedStateDisposition: preview.stateDisposition,
    });

    await dbWrite.delete(users).where(eq(users.id, actorId));
    const [afterActorDelete] = await dbWrite
      .select()
      .from(personalDedicatedAdoptionSelections);
    expect(afterActorDelete?.selected_by_user_id).toBeNull();

    await dbWrite.delete(users).where(eq(users.id, USER_A));
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(0);
    await dbWrite.insert(users).values({
      id: USER_A,
      organization_id: ORG_A,
      steward_user_id: "owner-selection-a",
      role: "owner",
    });
  });

  test("concurrent identical executions converge and a conflicting target cannot replace the selection", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    const input = {
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory" as const,
      expectedInventoryFingerprint: fingerprint,
      expectedStateDisposition: "fresh_boot_no_verified_backup" as const,
    };
    const results = await Promise.all([
      personalDedicatedAdoptionSelectionService.execute(input),
      personalDedicatedAdoptionSelectionService.execute(input),
    ]);
    expect(results.every((result) => result.retainedAgentId === RETAINED)).toBe(
      true,
    );
    expect(
      await dbWrite.select().from(personalDedicatedAdoptionSelections),
    ).toHaveLength(1);

    await expect(
      personalDedicatedAdoptionSelectionService.execute({
        ...input,
        expectedInventoryFingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_SELECTION_INVENTORY_CHANGED",
    });

    await expect(
      personalDedicatedAdoptionSelectionService.preview({
        ...input,
        retainedAgentId: STALE,
      }),
    ).rejects.toMatchObject({ code: "PERSONAL_DEDICATED_SELECTION_CONFLICT" });
  });

  test("the later quote-bound adoption provisions the selected same row and preserves the stale row", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: fingerprint,
      expectedStateDisposition: "fresh_boot_no_verified_backup",
    });

    const result = await adoptPersonalDedicatedTargetWithProvision({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      expectedTargetId: RETAINED,
      expectedLifecycleRevision: 5749,
      expectedStatus: "error",
      expectedBalance: 100,
      expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
      expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
      expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
      expectedActivationAuthorityKey: "fresh-boot",
    });
    expect(result).toMatchObject({ agent: { id: RETAINED }, jobCreated: true });
    expect(result.job?.data).toMatchObject({
      restoreDirective: { kind: "reviewed-fresh-boot" },
    });
    expect(await dbWrite.select().from(agentSandboxes)).toHaveLength(2);
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);
    const [authority] = await dbWrite
      .select()
      .from(personalDedicatedUpgradeAuthorities);
    expect(authority?.dedicated_agent_id).toBe(RETAINED);
    const [stale] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, STALE));
    expect(stale?.agent_config).toEqual({});
    expect(stale?.status).toBe("error");

    await dbWrite
      .update(jobs)
      .set({
        status: "failed",
        completed_at: new Date("2026-08-25T13:00:00.000Z"),
      })
      .where(eq(jobs.id, result.job!.id));
    const retry = await adoptPersonalDedicatedTargetWithProvision({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      expectedTargetId: RETAINED,
      expectedLifecycleRevision: result.agent.lifecycle_revision,
      expectedStatus: result.agent.status,
      expectedBalance: 100,
      expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
      expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
      expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
      expectedActivationAuthorityKey: "fresh-boot",
    });
    expect(retry).toMatchObject({ alreadyAdopted: true, jobCreated: true });
    expect(retry.job?.data).toMatchObject({
      restoreDirective: { kind: "reviewed-fresh-boot" },
    });
  });

  test("adoption rejects an active provision job with different restore authority without partial marker writes", async () => {
    await seedAmbiguousInventory();
    const fingerprint = await previewFingerprint();
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: fingerprint,
      expectedStateDisposition: "fresh_boot_no_verified_backup",
    });
    const active = await provisioningJobService.enqueueAgentProvisionOnce({
      agentId: RETAINED,
      organizationId: ORG_A,
      userId: USER_A,
      agentName: "Retained",
    });
    expect(active.job.data).not.toHaveProperty("restoreDirective");

    await expect(
      adoptPersonalDedicatedTargetWithProvision({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        expectedTargetId: RETAINED,
        expectedLifecycleRevision: 5749,
        expectedStatus: "error",
        expectedBalance: 100,
        expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
        expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
        expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
        expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
        expectedActivationAuthorityKey: "fresh-boot",
      }),
    ).rejects.toThrow("different restore authority");

    expect(
      await dbWrite.select().from(personalDedicatedUpgradeAuthorities),
    ).toHaveLength(0);
    const [retained] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, RETAINED));
    expect(retained?.agent_config).toEqual({});
    const [persistedJob] = await dbWrite.select().from(jobs);
    expect(persistedJob?.id).toBe(active.job.id);
    expect(persistedJob?.data).not.toHaveProperty("restoreDirective");
  });

  test("a selected legacy backup is pinned and worker revalidation blocks hash/status drift", async () => {
    await seedAmbiguousInventory();
    const state = { memories: [], config: {}, workspaceFiles: {} };
    const contentHash = computeStateHash(state);
    const verifiedAt = new Date("2026-08-25T12:00:00.000Z");
    const [backup] = await dbWrite
      .insert(agentSandboxBackups)
      .values({
        sandbox_record_id: RETAINED,
        snapshot_type: "auto",
        state_data: state,
        content_hash: contentHash,
        verification_status: "verified",
        verified_at: verifiedAt,
        catalog_version: 1,
        catalog_state: "legacy_unmigrated",
        catalog_payload_digest: "b".repeat(64),
        catalog_organization_id: ORG_A,
        catalog_agent_id: RETAINED,
      })
      .returning();
    const expectedBackupChain = [
      {
        backupId: backup!.id,
        backupKind: "full" as const,
        parentBackupId: null,
        contentHash,
        catalogVersion: 1,
        catalogState: "legacy_unmigrated",
      },
    ];
    const preview = await personalDedicatedAdoptionSelectionService.preview({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
    });
    await personalDedicatedAdoptionSelectionService.execute({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory",
      expectedInventoryFingerprint: preview.inventoryFingerprint,
      expectedStateDisposition: "verified_backup_present",
    });

    // A routine healthy verifier pass only advances its observation time; it
    // must not invalidate an immutable selection or reviewed restore chain.
    await dbWrite
      .update(agentSandboxBackups)
      .set({ verified_at: new Date("2026-08-25T13:00:00.000Z") })
      .where(eq(agentSandboxBackups.id, backup!.id));

    const result = await adoptPersonalDedicatedTargetWithProvision({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      expectedTargetId: RETAINED,
      expectedLifecycleRevision: 5749,
      expectedStatus: "error",
      expectedBalance: 100,
      expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
      expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
      expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
      expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
      expectedActivationAuthorityKey: `from-legacy-backup:${backup!.id}:${contentHash}:${JSON.stringify(
        expectedBackupChain.map((entry) => [
          entry.backupId,
          entry.backupKind,
          entry.parentBackupId,
          entry.contentHash,
          entry.catalogVersion,
          entry.catalogState,
        ]),
      )}`,
    });
    expect(result.job?.data).toMatchObject({
      restoreDirective: {
        kind: "from-reviewed-backup",
        backupId: backup!.id,
        expectedContentHash: contentHash,
        expectedBackupChain,
      },
    });
    const reviewedSelectionId = (
      result.job?.data as
        | { restoreDirective?: { selectionId?: string } }
        | undefined
    )?.restoreDirective?.selectionId;
    if (!reviewedSelectionId)
      throw new Error("reviewed selection id was not persisted");

    const reviewedJobData = {
      agentId: RETAINED,
      organizationId: ORG_A,
      userId: USER_A,
      agentName: "Retained",
      restoreDirective: {
        kind: "from-reviewed-backup" as const,
        selectionId: reviewedSelectionId,
        backupId: backup!.id,
        expectedContentHash: contentHash,
        expectedBackupChain,
      },
    };
    await expect(
      resolveReviewedProvisionRestoreDirectiveForExecution(reviewedJobData),
    ).resolves.toEqual(reviewedJobData.restoreDirective);

    await dbWrite
      .update(agentSandboxBackups)
      .set({ verification_status: "failed" })
      .where(eq(agentSandboxBackups.id, backup!.id));
    await expect(
      resolveReviewedProvisionRestoreDirectiveForExecution(reviewedJobData),
    ).rejects.toMatchObject({ status: 409, code: "session_not_ready" });

    await dbWrite
      .update(agentSandboxBackups)
      .set({ verification_status: "verified", content_hash: "f".repeat(64) })
      .where(eq(agentSandboxBackups.id, backup!.id));
    await expect(
      resolveReviewedProvisionRestoreDirectiveForExecution(reviewedJobData),
    ).rejects.toMatchObject({ status: 409, code: "session_not_ready" });
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);
    const [organization] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, ORG_A));
    expect(Number(organization?.creditBalance)).toBe(100);
  });

  test("a selected catalogue-v2 backup fails closed before marker or provision job", async () => {
    await seedAmbiguousInventory();
    const [backup] = await dbWrite
      .insert(agentSandboxBackups)
      .values({
        sandbox_record_id: RETAINED,
        snapshot_type: "auto",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        catalog_version: 2,
        catalog_state: "protected",
        catalog_payload_digest: "c".repeat(64),
        catalog_organization_id: ORG_A,
        catalog_agent_id: RETAINED,
        manifest_version: 3,
        manifest_digest: "d".repeat(64),
        object_inventory_digest: "e".repeat(64),
      })
      .returning();
    const input = {
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
      retainedAgentId: RETAINED,
      selectedByUserId: ADMIN,
      reason: "duplicate_owned_dedicated_inventory" as const,
    };
    const preview =
      await personalDedicatedAdoptionSelectionService.preview(input);
    await personalDedicatedAdoptionSelectionService.execute({
      ...input,
      expectedInventoryFingerprint: preview.inventoryFingerprint,
      expectedStateDisposition: "verified_backup_present",
    });

    await expect(
      adoptPersonalDedicatedTargetWithProvision({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
        expectedTargetId: RETAINED,
        expectedLifecycleRevision: 5749,
        expectedStatus: "error",
        expectedBalance: 100,
        expectedHourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
        expectedDailyRate: AGENT_PRICING.DAILY_RUNNING_COST,
        expectedMinimumBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE,
        expectedMinimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
        expectedActivationAuthorityKey: `catalog-restore-required:${backup!.id}:${"c".repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED",
    });
    const [retained] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, RETAINED));
    expect(retained?.agent_config).toEqual({});
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    expect(
      await dbWrite.select().from(personalDedicatedUpgradeAuthorities),
    ).toHaveLength(0);
  });

  test("a canonical adoption authority wins over an unrelated unmarked stale row", async () => {
    await seedAmbiguousInventory();
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SOURCE_A,
      dedicated_agent_id: RETAINED,
    });
    const resolved = await resolvePersonalDedicatedAdoption({
      organizationId: ORG_A,
      userId: USER_A,
      sourceAgentId: SOURCE_A,
    });
    expect(resolved).toMatchObject({
      state: "adopted",
      agent: { id: RETAINED },
    });

    await dbWrite
      .update(agentSandboxes)
      .set({ status: "disconnected" })
      .where(eq(agentSandboxes.id, RETAINED));
    expect(
      await resolvePersonalDedicatedAdoption({
        organizationId: ORG_A,
        userId: USER_A,
        sourceAgentId: SOURCE_A,
      }),
    ).toEqual({ state: "unavailable" });
  });
});

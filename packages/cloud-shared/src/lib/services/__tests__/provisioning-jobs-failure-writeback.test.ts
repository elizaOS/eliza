/**
 * Unit coverage for the CONTAINER_PROVISION permanent-failure writeback in
 * ProvisioningJobService.buildPermanentFailureWriteback.
 *
 * Why this exists: a SUCCESSFUL app deploy (APP_DEPLOY) only enqueues a
 * CONTAINER_PROVISION and self-completes, so the container provision is what
 * actually fails. Before this writeback, a permanently-failed provision left
 * the owning app stuck in `building` forever (the deploy-status route echoes
 * apps.deployment_status). This locks in: app container -> flip to `failed`;
 * plain /v1/containers row (non-UUID project_name) -> no-op; missing row -> no-op.
 */
import { describe, expect, test } from "bun:test";
import { apps } from "../../../db/schemas/apps";
import { JOB_TYPES } from "../provisioning-job-types";
import { ProvisioningJobService } from "../provisioning-jobs";

// Structurally-valid UUIDs (isValidUUID enforces the version/variant nibbles,
// like apps.id which is uuid().defaultRandom()).
const APP_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const CONTAINER_ID = "cccccccc-dddd-4eee-8fff-000000000000";

// Minimal DbTransaction stand-in: serves one container row for the select chain
// (project_name + organization_id, since the writeback org-scopes the flip) and
// records every update(table).set(values) the writeback issues.
function mockTx(containerRow: { projectName: string; organizationId: string } | null) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (containerRow ? [containerRow] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  return { tx, updates };
}

const service = new ProvisioningJobService();

function containerProvisionWriteback() {
  const job = {
    id: "job-1",
    type: JOB_TYPES.CONTAINER_PROVISION,
    max_attempts: 3,
    data: { containerId: CONTAINER_ID, organizationId: "org-1", userId: "user-1" },
  };
  // buildPermanentFailureWriteback is private; exercise the real switch case.
  const cb = (
    service as unknown as {
      buildPermanentFailureWriteback: (
        j: typeof job,
        e: string,
      ) => ((tx: unknown, j: typeof job) => Promise<void>) | undefined;
    }
  ).buildPermanentFailureWriteback(job, "container provision exhausted retries");
  return { job, cb };
}

describe("buildPermanentFailureWriteback: CONTAINER_PROVISION", () => {
  test("app container (UUID project_name) -> apps.deployment_status flipped to failed", async () => {
    const { job, cb } = containerProvisionWriteback();
    expect(cb).toBeDefined();
    const { tx, updates } = mockTx({ projectName: APP_ID, organizationId: ORG_ID });
    await cb!(tx, job);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(apps);
    expect(updates[0].values.deployment_status).toBe("failed");
    expect(updates[0].values.updated_at).toBeInstanceOf(Date);
  });

  test("plain container (non-UUID project_name) -> no app update", async () => {
    const { job, cb } = containerProvisionWriteback();
    const { tx, updates } = mockTx({ projectName: "my-plain-container", organizationId: ORG_ID });
    await cb!(tx, job);
    expect(updates).toHaveLength(0);
  });

  test("missing container row -> no app update", async () => {
    const { job, cb } = containerProvisionWriteback();
    const { tx, updates } = mockTx(null);
    await cb!(tx, job);
    expect(updates).toHaveLength(0);
  });

  test("36-char non-UUID project_name (e.g. all dashes) -> no app update", async () => {
    // isValidUUID rejects a 36-char hex/dash string that is not a real UUID, so
    // a coding container whose slug merely looks UUID-shaped is a clean no-op.
    const { job, cb } = containerProvisionWriteback();
    const { tx, updates } = mockTx({ projectName: "-".repeat(36), organizationId: ORG_ID });
    await cb!(tx, job);
    expect(updates).toHaveLength(0);
  });
});

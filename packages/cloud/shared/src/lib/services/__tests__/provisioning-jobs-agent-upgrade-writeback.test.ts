/**
 * Unit coverage for the AGENT_UPGRADE permanent-failure writeback in
 * ProvisioningJobService.buildPermanentFailureWriteback. Exhausted upgrades
 * must stop the fleet reconciler from retrying the same failing target without
 * declaring a rollback-safe, still-serving sandbox terminal.
 */
import { describe, expect, test } from "bun:test";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { JOB_TYPES } from "../provisioning-job-types";
import { ProvisioningJobService } from "../provisioning-jobs";

const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const USER_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

// Minimal DbTransaction stand-in: records every update(table).set(values) call.
function mockTx() {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
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

function agentUpgradeWriteback(errorMsg = "upgrade exhausted retries") {
  const job = {
    id: "job-upgrade-1",
    type: JOB_TYPES.AGENT_UPGRADE,
    max_attempts: 3,
    data: {
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
      dockerImage: "elizaos/agent:latest",
      fromDigest: "sha256:old",
      toDigest: "sha256:new",
    },
  };
  const cb = (
    service as unknown as {
      buildPermanentFailureWriteback: (
        j: typeof job,
        e: string,
      ) => ((tx: unknown, j: typeof job) => Promise<void>) | undefined;
    }
  ).buildPermanentFailureWriteback(job, errorMsg);
  return { job, cb };
}

describe("buildPermanentFailureWriteback: AGENT_UPGRADE (#15310)", () => {
  test("returns a callback for AGENT_UPGRADE so exhausted upgrades have a stop signal", () => {
    const { cb } = agentUpgradeWriteback();
    expect(cb).toBeDefined();
  });

  test("records an actionable error_message without marking the still-serving sandbox terminal", async () => {
    const { job, cb } = agentUpgradeWriteback("SSH to node timed out");
    const { tx, updates } = mockTx();
    await cb!(tx, job);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(agentSandboxes);
    expect(updates[0].values.status).toBeUndefined();
    expect(updates[0].values.updated_at).toBeInstanceOf(Date);

    const errorMessage = String(updates[0].values.error_message);
    expect(errorMessage).toContain("Upgrade permanently failed");
    expect(errorMessage).toContain(`after ${job.max_attempts} attempts`);
    expect(errorMessage).toContain("SSH to node timed out");
  });

  test("does not touch any other tables (no silent cross-writes)", async () => {
    const { job, cb } = agentUpgradeWriteback();
    const { tx, updates } = mockTx();
    await cb!(tx, job);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(agentSandboxes);
  });

  test("propagates a variety of underlying errors verbatim into error_message", async () => {
    for (const errorMsg of [
      "AEAD decrypt failed",
      "key not found: org:775ba863/dek/v1",
      "Node ssh dial-tcp timeout after 30000ms",
      "Container health check failed after 6 attempts",
    ]) {
      const { job, cb } = agentUpgradeWriteback(errorMsg);
      const { tx, updates } = mockTx();
      await cb!(tx, job);
      expect(String(updates[0].values.error_message)).toContain(errorMsg);
    }
  });
});

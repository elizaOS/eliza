/**
 * Unit coverage for the AGENT_UPGRADE permanent-failure writeback in
 * ProvisioningJobService.buildPermanentFailureWriteback (#15310, self-healing
 * behavior 2).
 *
 * Why this exists: before #15310 there was NO switch case for AGENT_UPGRADE.
 * When an upgrade exhausted its retries the sandbox row was left untouched,
 * so:
 *   - the reconciler kept re-enqueuing the same doomed upgrade against the
 *     same dead agent id (silent retry loop),
 *   - the client UI kept rendering "Setting up your cloud agent…" forever
 *     (no `error` status to switch on),
 *   - and there was no server-truth signal for the client boot-reconciliation
 *     lane to detect "onboarded locally but the bound agent is dead."
 *
 * The writeback locks in: on permanent AGENT_UPGRADE failure, flip the
 * sandbox row to `error` with an actionable error_message. This is the
 * dead-agent-row CLEANUP half — the re-enqueue-fresh (mint a NEW dedicated
 * create) is called out as a follow-up in the PR body because it needs a
 * product decision on who owns/names the new agent (the upgrade path swaps
 * containers on an existing sandbox row and never mints a new one).
 */
import { describe, expect, test } from "bun:test";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { JOB_TYPES } from "../provisioning-job-types";
import { ProvisioningJobService } from "../provisioning-jobs";

const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const USER_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

// Minimal DbTransaction stand-in: records every update(table).set(values) call.
// AGENT_UPGRADE's writeback issues a single agent-sandboxes update with no
// prior select, mirroring the AGENT_PROVISION case.
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
  test("returns a callback for AGENT_UPGRADE (previously was undefined — the stranding bug)", () => {
    const { cb } = agentUpgradeWriteback();
    // The core regression guard: before this PR, AGENT_UPGRADE fell through to
    // the `default: return undefined` branch and the org stayed stranded.
    expect(cb).toBeDefined();
  });

  test("flips the sandbox row to status=error with an actionable error_message", async () => {
    const { job, cb } = agentUpgradeWriteback("SSH to node timed out");
    const { tx, updates } = mockTx();
    await cb!(tx, job);

    expect(updates).toHaveLength(1);
    // Must target the agent_sandboxes table — not apps, not containers —
    // because the client boot-reconciliation lane (#15310 client half) reads
    // agent status to decide "re-enter provisioning."
    expect(updates[0].table).toBe(agentSandboxes);
    expect(updates[0].values.status).toBe("error");
    expect(updates[0].values.updated_at).toBeInstanceOf(Date);

    // The error_message must (a) explain WHAT failed, (b) how many attempts
    // it took to give up, and (c) carry the underlying cause. Without the
    // cause a user support ticket has no signal to act on.
    const errorMessage = String(updates[0].values.error_message);
    expect(errorMessage).toContain("Upgrade permanently failed");
    expect(errorMessage).toContain(`after ${job.max_attempts} attempts`);
    expect(errorMessage).toContain("SSH to node timed out");
  });

  test("does not touch any other tables (no silent cross-writes)", async () => {
    const { job, cb } = agentUpgradeWriteback();
    const { tx, updates } = mockTx();
    await cb!(tx, job);

    // Exactly one write, exactly to agent_sandboxes. If a future refactor
    // adds a secondary write (apps, containers, jobs) this test fails and
    // forces an explicit re-think of the writeback scope.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(agentSandboxes);
  });

  test("propagates a variety of underlying errors verbatim into error_message", async () => {
    // A permanently-failed upgrade can happen for many reasons (image pull
    // timeout, node exhaustion, KMS decrypt failure on the pre-upgrade
    // snapshot, health-check timeout). Whatever the reason, the writeback
    // must preserve it so ops can diagnose without re-reading the job row.
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

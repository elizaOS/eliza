/**
 * Unit coverage for the AGENT_UPGRADE permanent-failure writeback in
 * ProvisioningJobService.buildPermanentFailureWriteback.
 *
 * The writeback must NOT treat all exhausted upgrades identically (#15357,
 * lalalune's #15311 review): most upgrade failures are ROLLBACK-SAFE — the old
 * container is still serving its previous version, so marking the sandbox row
 * terminal would make the dedicated proxy reject live traffic and expose the
 * live container to the orphan reconciler. Rollback-safe failures keep the row
 * `running` and record a re-armable marker (the exhausted target digest) so the
 * fleet reconciler stops re-enqueuing the SAME doomed target WITHOUT freezing
 * the agent out of a NEWER target. Genuinely-dead failures (old container not
 * serving) keep the terminal `status:"error"` writeback.
 */
import { describe, expect, test } from "bun:test";
import {
  agentSandboxes,
  UPGRADE_FAILURE_TARGET_MARKER_PREFIX,
} from "../../../db/schemas/agent-sandboxes";
import { JOB_TYPES } from "../provisioning-job-types";
import {
  buildUpgradeFailureMarker,
  ProvisioningJobService,
  parseUpgradeFailureTargetDigest,
  UpgradeFailedError,
} from "../provisioning-jobs";

const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const USER_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const TO_DIGEST = "sha256:newtarget000000000000000000000000000000000000000000000000000000";

// Minimal DbTransaction stand-in: records every update(table).set(values) call
// with the where-predicate presence so the tests can assert both the values and
// that a status-scoped WHERE was (or was not) applied.
function mockTx() {
  const updates: Array<{ table: unknown; values: Record<string, unknown>; hadWhere: boolean }> = [];
  const tx = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values, hadWhere: true });
        },
      }),
    }),
  };
  return { tx, updates };
}

const service = new ProvisioningJobService();

type WritebackFn = ((tx: unknown, j: unknown) => Promise<void>) | undefined;

function agentUpgradeWriteback(
  errorMsg = "upgrade exhausted retries",
  upgradeFailure?: UpgradeFailedError,
) {
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
      toDigest: TO_DIGEST,
    },
  };
  const cb = (
    service as unknown as {
      buildPermanentFailureWriteback: (
        j: typeof job,
        e: string,
        f?: UpgradeFailedError,
      ) => WritebackFn;
    }
  ).buildPermanentFailureWriteback(job, errorMsg, upgradeFailure);
  return { job, cb };
}

describe("buildPermanentFailureWriteback: AGENT_UPGRADE (#15357)", () => {
  test("returns a callback for AGENT_UPGRADE so exhausted upgrades have a stop signal", () => {
    const { cb } = agentUpgradeWriteback();
    expect(cb).toBeDefined();
  });

  describe("rollback-safe failure (old container still serving)", () => {
    // Default (no classification) MUST be treated as rollback-safe: erroring a
    // possibly-live agent is strictly worse than leaving a dead one non-terminal.
    test("default (no classification) keeps the row running and records a re-armable marker", async () => {
      const { job, cb } = agentUpgradeWriteback(
        "Blue health check failed; rolled back to old container",
      );
      const { tx, updates } = mockTx();
      await cb!(tx, job);

      expect(updates).toHaveLength(1);
      expect(updates[0].table).toBe(agentSandboxes);
      // Non-terminal: status is NEVER set for a rollback-safe failure.
      expect(updates[0].values.status).toBeUndefined();
      expect(updates[0].values.updated_at).toBeInstanceOf(Date);
      const msg = String(updates[0].values.error_message);
      expect(msg).toContain("Upgrade permanently failed");
      expect(msg).toContain("Blue health check failed");
      // No classification (undefined UpgradeFailedError), but the job data still
      // carries the real target — so the marker records the job's toDigest, not
      // "unknown". This keeps the reconciler's target-scoped skip precise even on
      // the defensive worker-level-throw path (no UpgradeFailedError constructed).
      expect(msg).not.toContain(`${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}unknown]`);
      expect(parseUpgradeFailureTargetDigest(msg)).toBe(TO_DIGEST);
    });

    test("explicit rolledBack:true keeps running and encodes the exhausted target digest", async () => {
      const failure = new UpgradeFailedError("Pre-upgrade snapshot failed: disk full", {
        rolledBack: true,
        toDigest: TO_DIGEST,
      });
      const { job, cb } = agentUpgradeWriteback("Pre-upgrade snapshot failed: disk full", failure);
      const { tx, updates } = mockTx();
      await cb!(tx, job);

      expect(updates).toHaveLength(1);
      expect(updates[0].values.status).toBeUndefined();
      const msg = String(updates[0].values.error_message);
      expect(msg).toContain("Pre-upgrade snapshot failed: disk full");
      // The recorded target must be the EXACT exhausted digest so the reconciler
      // can re-arm the agent when a newer target is published.
      expect(parseUpgradeFailureTargetDigest(msg)).toBe(TO_DIGEST);
    });

    test("falls back to the job's own toDigest when the error carries no target digest", async () => {
      // Defensive path: an UpgradeFailedError can reach the writeback with an
      // empty `toDigest` (e.g. a failure thrown before the target was resolved
      // onto the error, or an unexpected re-throw). The marker MUST still record
      // the EXACT exhausted target so the reconciler can re-arm the agent on a
      // newer digest — otherwise it degrades to an "unknown" marker and the
      // target-scoped skip can't distinguish this doomed target from a fresh one.
      // The job data always carries the real target, so we fall back to it.
      const failure = new UpgradeFailedError("Blue provision failed: node offline", {
        rolledBack: true,
        toDigest: "",
      });
      const { job, cb } = agentUpgradeWriteback("Blue provision failed: node offline", failure);
      const { tx, updates } = mockTx();
      await cb!(tx, job);

      expect(updates).toHaveLength(1);
      expect(updates[0].values.status).toBeUndefined();
      const msg = String(updates[0].values.error_message);
      // NOT "unknown": the marker carries the job's real target digest.
      expect(msg).not.toContain(`${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}unknown]`);
      expect(parseUpgradeFailureTargetDigest(msg)).toBe(TO_DIGEST);
    });

    test("each rollback-safe executeUpgrade failure reason stays non-terminal", async () => {
      // Every one of these reason strings comes from an executeUpgrade path that
      // returns BEFORE the atomic swap, leaving the old container alive.
      const rollbackSafeReasons = [
        "Blue provision failed: node ssh dial-tcp timeout after 30000ms",
        "Blue health check failed; rolled back to old container",
        "Blue provisioner returned non-docker metadata",
        "Blue image digest mismatch: expected sha256:new, got sha256:other",
        "Blue runtime readiness gate failed: plugin @elizaos/x failed to load",
        "Pre-upgrade snapshot failed: AEAD decrypt failed",
        "Atomic swap UPDATE failed: Agent changed during upgrade; abandoned stale swap",
        "Agent has no node_id or container_name to upgrade from",
        "Agent uses a custom docker image; refusing fleet upgrade",
        "Old node node-abc not registered in docker_nodes",
        "Fleet upgrade only supported on docker provider",
      ];
      for (const reason of rollbackSafeReasons) {
        const failure = new UpgradeFailedError(reason, { rolledBack: true, toDigest: TO_DIGEST });
        const { job, cb } = agentUpgradeWriteback(reason, failure);
        const { tx, updates } = mockTx();
        await cb!(tx, job);
        expect(updates[0].values.status).toBeUndefined();
        expect(String(updates[0].values.error_message)).toContain(reason);
      }
    });
  });

  describe("genuinely-dead failure (old container not serving)", () => {
    test("rolledBack:false marks the sandbox terminal (status error), like AGENT_PROVISION", async () => {
      const failure = new UpgradeFailedError("Agent not running (status: stopped)", {
        rolledBack: false,
        toDigest: TO_DIGEST,
      });
      const { job, cb } = agentUpgradeWriteback("Agent not running (status: stopped)", failure);
      const { tx, updates } = mockTx();
      await cb!(tx, job);

      expect(updates).toHaveLength(1);
      expect(updates[0].table).toBe(agentSandboxes);
      // Terminal: the row IS flipped to error for a genuinely-down agent.
      expect(updates[0].values.status).toBe("error");
      const msg = String(updates[0].values.error_message);
      expect(msg).toContain("Upgrade permanently failed");
      expect(msg).toContain("agent not serving");
      expect(msg).toContain("Agent not running (status: stopped)");
      // The terminal writeback does NOT carry the re-armable target marker: a
      // status:"error" row is already excluded from the reconciler by status.
      expect(msg).not.toContain(UPGRADE_FAILURE_TARGET_MARKER_PREFIX);
    });
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
      const failure = new UpgradeFailedError(errorMsg, { rolledBack: true, toDigest: TO_DIGEST });
      const { job, cb } = agentUpgradeWriteback(errorMsg, failure);
      const { tx, updates } = mockTx();
      await cb!(tx, job);
      expect(String(updates[0].values.error_message)).toContain(errorMsg);
    }
  });
});

describe("upgrade-failure marker encode/parse round-trip (#15357)", () => {
  test("buildUpgradeFailureMarker encodes cause + target digest, parse recovers the digest", () => {
    const marker = buildUpgradeFailureMarker(3, "Blue health check failed", TO_DIGEST);
    expect(marker).toContain("after 3 attempts");
    expect(marker).toContain("Blue health check failed");
    expect(parseUpgradeFailureTargetDigest(marker)).toBe(TO_DIGEST);
  });

  test("a null / undefined target encodes 'unknown' and parses back to null (no re-arm target)", () => {
    const marker = buildUpgradeFailureMarker(3, "unknown cause", null);
    expect(marker).toContain(`${UPGRADE_FAILURE_TARGET_MARKER_PREFIX}unknown]`);
    expect(parseUpgradeFailureTargetDigest(marker)).toBeNull();
  });

  test("parseUpgradeFailureTargetDigest returns null for messages without a marker", () => {
    expect(parseUpgradeFailureTargetDigest(null)).toBeNull();
    expect(parseUpgradeFailureTargetDigest("")).toBeNull();
    expect(
      parseUpgradeFailureTargetDigest("Provisioning permanently failed after 3 attempts: boom"),
    ).toBeNull();
  });

  test("parse picks the LAST marker if a message somehow accreted more than one", () => {
    // Defensive: error_message is single-writer, but lastIndexOf guarantees we
    // read the freshest target if two markers ever coexist.
    const older = buildUpgradeFailureMarker(3, "old cause", "sha256:oldtarget");
    const combined = `${older} ${buildUpgradeFailureMarker(3, "new cause", TO_DIGEST)}`;
    expect(parseUpgradeFailureTargetDigest(combined)).toBe(TO_DIGEST);
  });
});

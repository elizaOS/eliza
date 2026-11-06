/**
 * Host-locale contract for the personal-dedicated inventory fingerprint.
 *
 * personalDedicatedInventoryFingerprint() output is stored on the selection
 * receipt (`inventory_fingerprint`, regex-pinned `^[a-f0-9]{64}$`) and re-
 * verified later by agent-tier-upgrade-target and the selection flow —
 * possibly on a different node with a different default locale.
 *
 * The candidates/backups lists are ordered with localeCompare before being
 * hashed. ICU collation is locale-dependent: on a Danish host "aa…" collates
 * as "åa…" and is ordered AFTER "b0…", so one logical inventory produced a
 * fingerprint its later verifier on another host rejected — the same class as
 * #38566 (budget consumption receipt). The ordering inside the fingerprint
 * must be code-unit order on every host.
 *
 * These tests pin the exact fingerprint for a fixed inventory and verify a
 * fingerprint computed by a Node process whose default locale is da-DK.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { personalDedicatedInventoryFingerprint } from "../personal-dedicated-adoption-provenance";
import type { PersonalDedicatedBackupProvenance } from "../personal-dedicated-adoption-provenance";

const AA = "aa000000-0000-4000-8000-000000000001";
const B0 = "b0000000-0000-4000-8000-000000000002";

function candidate(id: string): AgentSandbox {
  return {
    id,
    status: "ready",
    lifecycle_revision: 1,
    environment_revision: 1,
    environment_vars: {},
    database_status: "ok",
    database_uri: `postgres://db-${id.slice(0, 2)}`,
    snapshot_id: null,
    last_backup_at: null,
    last_backup_attempt_at: null,
    backup_unsupported_reason: null,
    node_id: `node-${id.slice(0, 2)}`,
    container_name: null,
    docker_image: null,
    image_digest: null,
    previous_image_digest: null,
    billing_status: "none",
    hourly_rate: null,
    scheduled_shutdown_at: null,
    activation_phase: null,
    activation_backup_id: null,
    activation_backup_hash: null,
    activation_receipt_hash: null,
    activation_image_digest: null,
  } as unknown as AgentSandbox;
}

function backup(id: string, sandboxRecordId: string | null): PersonalDedicatedBackupProvenance {
  return {
    id,
    sandboxRecordId,
    snapshotType: "full",
    stateDataStorage: "cloudflare-r2",
    stateDataKey: `backups/${id}`,
    backupKind: "scheduled",
    parentBackupId: null,
    contentHash: null,
    verificationStatus: "verified",
    verifiedAt: null,
    catalogVersion: null,
    catalogState: null,
    catalogPayloadDigest: null,
    catalogRevision: 1n,
    catalogOrganizationId: null,
    catalogAgentId: null,
    sourceProvider: null,
    sourceNodeRecordId: null,
    sourceNodeId: null,
    sourceProviderServerId: null,
    sourceProviderHandle: null,
    sourceContainerId: null,
    manifestVersion: null,
    manifestDigest: null,
    objectInventoryDigest: null,
    imageDigest: null,
    databaseSchemaVersion: null,
    pluginSetDigest: null,
    watermarkDigest: null,
    restoreReceiptDigest: null,
    catalogDeletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as PersonalDedicatedBackupProvenance;
}

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const SOURCE_AGENT_ID = "src-1";
const RETAINED_AGENT_ID = "ret-1";

function params(candidates: AgentSandbox[], backups: PersonalDedicatedBackupProvenance[]) {
  return {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    sourceAgentId: SOURCE_AGENT_ID,
    retainedAgentId: RETAINED_AGENT_ID,
    candidates,
    backups,
  };
}

const EXPECTED_FINGERPRINT = "ac609b0615eaf5ffed661f08ff61c033795f6f7e2fa8045f6b86edfa28fdc8e9";

describe("personalDedicatedInventoryFingerprint", () => {
  test("is independent of the caller's input order", async () => {
    const forward = await personalDedicatedInventoryFingerprint(
      params([candidate(AA), candidate(B0)], [backup("11111111-1111-4111-8111-111111111111", null)]),
    );
    const reversed = await personalDedicatedInventoryFingerprint(
      params([candidate(B0), candidate(AA)], [backup("11111111-1111-4111-8111-111111111111", null)]),
    );
    expect(forward).toBe(EXPECTED_FINGERPRINT);
    expect(reversed).toBe(EXPECTED_FINGERPRINT);
  });

  test("matches the fingerprint computed by a node under a da-DK host locale", async () => {
    if (spawnSync("node", ["--version"]).error) return; // node is the full-icu host stand-in
    const dir = mkdtempSync(join(tmpdir(), "personal-dedicated-fingerprint-"));
    try {
      const built = await Bun.build({
        entrypoints: [
          join(import.meta.dir, "../personal-dedicated-adoption-provenance.ts"),
        ],
        outdir: dir,
        target: "node",
        format: "esm",
      });
      if (!built.success) throw new Error("bundle failed");
      const probe = join(dir, "probe.mjs");
      writeFileSync(
        probe,
        `import { personalDedicatedInventoryFingerprint } from ${JSON.stringify(
          pathToFileURL(built.outputs[0].path).href,
        )};\n` +
          `const mk = (id) => ({ id, status: "ready", lifecycle_revision: 1, environment_revision: 1, ` +
          `environment_vars: {}, database_status: "ok", database_uri: \`postgres://db-\${id.slice(0, 2)}\`, ` +
          `snapshot_id: null, last_backup_at: null, last_backup_attempt_at: null, ` +
          `backup_unsupported_reason: null, node_id: \`node-\${id.slice(0, 2)}\`, container_name: null, ` +
          `docker_image: null, image_digest: null, previous_image_digest: null, billing_status: "none", ` +
          `hourly_rate: null, scheduled_shutdown_at: null, activation_phase: null, ` +
          `activation_backup_id: null, activation_backup_hash: null, activation_receipt_hash: null, ` +
          `activation_image_digest: null });\n` +
          `const mkBackup = (id) => ({ id, sandboxRecordId: null, snapshotType: "full", ` +
          `stateDataStorage: "cloudflare-r2", stateDataKey: \`backups/\${id}\`, backupKind: "scheduled", ` +
          `parentBackupId: null, contentHash: null, verificationStatus: "verified", verifiedAt: null, ` +
          `catalogVersion: null, catalogState: null, catalogPayloadDigest: null, catalogRevision: 1n, ` +
          `catalogOrganizationId: null, catalogAgentId: null, sourceProvider: null, sourceNodeRecordId: null, ` +
          `sourceNodeId: null, sourceProviderServerId: null, sourceProviderHandle: null, sourceContainerId: null, ` +
          `manifestVersion: null, manifestDigest: null, objectInventoryDigest: null, imageDigest: null, ` +
          `databaseSchemaVersion: null, pluginSetDigest: null, watermarkDigest: null, restoreReceiptDigest: null, ` +
          `catalogDeletedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z") });\n` +
          `const fingerprint = await personalDedicatedInventoryFingerprint({ ` +
          `organizationId: ${JSON.stringify(ORGANIZATION_ID)}, userId: ${JSON.stringify(USER_ID)}, ` +
          `sourceAgentId: ${JSON.stringify(SOURCE_AGENT_ID)}, retainedAgentId: ${JSON.stringify(RETAINED_AGENT_ID)}, ` +
          `candidates: [mk(${JSON.stringify(B0)}), mk(${JSON.stringify(AA)})], ` +
          `backups: [mkBackup("11111111-1111-4111-8111-111111111111")] });\n` +
          `console.log(fingerprint);\n`,
      );
      const run = spawnSync("node", [probe], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "da_DK.UTF-8" },
      });
      if (run.error) return;
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(EXPECTED_FINGERPRINT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

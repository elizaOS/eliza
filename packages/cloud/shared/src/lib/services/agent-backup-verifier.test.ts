/**
 * Backup restorability verification (#15603 B5) against the REAL pipeline: the
 * real Drizzle schema on in-process PGlite, the real memory KMS encrypting
 * through `prepareAgentBackupInsertData`, real AEAD decryption, and the real
 * sampling/stamping/alerting cycle. No mock stands in for the thing under test
 * — corrupted-ciphertext and wrong-KMS-key cases tamper with actual stored
 * envelopes and actual key state, reproducing the #15310 failure mode.
 *
 * Harness mirrors `db/repositories/__tests__/agent-sandboxes-fleet-candidate-repo.test.ts`:
 * drizzle-kit `pushSchema` applies the real DDL to the PGlite connection the
 * service queries through; self-skips LOUDLY when the ambient DATABASE_URL is a
 * shared non-PGlite Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  type AgentBackupFileEntry,
  type AgentBackupFileSet,
  type AgentBackupManifest,
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
  type EncryptedAgentBackupStateData,
} from "../../db/schemas/agent-sandboxes";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { computeStateHash, diffBackupState } from "./agent-backup-diff";
import {
  type BackupVerifierConfig,
  classifyCryptoError,
  readBackupVerifierConfig,
  runBackupVerificationCycle,
  verifyBackupRestorability,
} from "./agent-backup-verifier";
import type { DaemonHealthAlert } from "./provisioning-worker-health-monitor";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const CONFIG: BackupVerifierConfig = {
  enabled: true,
  batchSize: 10,
  reVerifyIntervalMs: 24 * 3_600_000,
  escalationThresholdPct: 50,
};

function makeAlertSpy(): { alerts: DaemonHealthAlert[]; alert: (a: DaemonHealthAlert) => void } {
  const alerts: DaemonHealthAlert[] = [];
  return { alerts, alert: (a) => alerts.push(a) };
}

async function seedSandbox(): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Backup Verify Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: uniq("agent"),
      status: "running",
    })
    .returning();
  return sandbox.id;
}

function sampleState(marker: string): AgentBackupStateData {
  return {
    memories: [{ role: "user", text: `remember ${marker}`, timestamp: 1_700_000_000_000 }],
    config: { marker },
    workspaceFiles: { "notes.txt": `notes for ${marker}` },
  };
}

async function seedFullBackup(
  sandboxRecordId: string,
  state: AgentBackupStateData,
  overrides: { contentHash?: string | null } = {},
): Promise<string> {
  const backup = await agentSandboxesRepository.createBackup({
    sandbox_record_id: sandboxRecordId,
    snapshot_type: "auto",
    state_data: state,
    size_bytes: 1024,
    backup_kind: "full",
    content_hash:
      overrides.contentHash === undefined ? computeStateHash(state) : overrides.contentHash,
  });
  return backup.id;
}

async function readBackupRow(backupId: string) {
  const [row] = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, backupId))
    .limit(1);
  if (!row) throw new Error(`backup row ${backupId} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// Independent manifest-fixture hashing. Deliberately NOT the verifier's own
// helpers: the test computes the producer-side hashes with its own sha256 +
// sorted-key canonical JSON (the scheme from packages/agent/src/services/
// agent-backup.ts), so the verifier is cross-checked against a second
// implementation instead of against itself.
// ---------------------------------------------------------------------------

function fixtureCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixtureCanonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = fixtureCanonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function fixtureSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureSha256Json(value: unknown): string {
  return fixtureSha256(JSON.stringify(fixtureCanonicalize(value)));
}

function fixtureFileEntry(path: string, content: string): AgentBackupFileEntry {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    sha256: fixtureSha256(bytes),
    size: bytes.length,
    bytesBase64: bytes.toString("base64"),
  };
}

function fixtureFileSet(files: AgentBackupFileEntry[]): AgentBackupFileSet {
  return {
    kind: "file-set",
    rootLabel: "state-dir",
    files,
    sha256: fixtureSha256Json(files.map(({ path, sha256, size }) => ({ path, sha256, size }))),
  };
}

function fixtureManifest(agentId: string): AgentBackupManifest {
  const media = fixtureFileSet([fixtureFileEntry("avatar.png", "png-bytes")]);
  const vault = fixtureFileSet([fixtureFileEntry("vault.json", '{"secrets":true}')]);
  const stateFiles = fixtureFileSet([fixtureFileEntry("eliza.json", '{"agents":{}}')]);
  const pglite = fixtureFileSet([fixtureFileEntry("pglite/PG_VERSION", "16")]);
  const database = { kind: "pglite-files" as const, pglite, sha256: pglite.sha256 };
  const runtimeCharacter = { name: "Verify Me", bio: ["backup verification fixture"] };
  const character = {
    runtimeCharacter,
    sha256: fixtureSha256Json({ runtimeCharacter, configFile: undefined }),
  };
  return {
    schemaVersion: 1,
    format: "elizaos.agent-backup",
    createdAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    agentId,
    components: { database, media, vault, character, stateFiles },
    integrity: {
      componentHashes: {
        database: database.sha256,
        media: media.sha256,
        vault: vault.sha256,
        character: character.sha256,
        stateFiles: stateFiles.sha256,
      },
    },
  };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-backup-verifier.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite self-skips — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    const schema = { organizations, users, userCharacters, agentSandboxes, agentSandboxBackups };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[agent-backup-verifier.test] PGlite/pushSchema unavailable — cannot drive the backup verifier against a real DB. Skipping all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("readBackupVerifierConfig", () => {
  test("defaults: enabled, batch 10, 24h re-verify, 50% escalation", () => {
    const config = readBackupVerifierConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.batchSize).toBe(10);
    expect(config.reVerifyIntervalMs).toBe(24 * 3_600_000);
    expect(config.escalationThresholdPct).toBe(50);
  });

  test("opt-out flag and tunables parse; garbage falls back to defaults", () => {
    expect(
      readBackupVerifierConfig({ BACKUP_VERIFICATION_ENABLED: "0" } as NodeJS.ProcessEnv).enabled,
    ).toBe(false);
    expect(
      readBackupVerifierConfig({ BACKUP_VERIFICATION_ENABLED: "false" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    const tuned = readBackupVerifierConfig({
      BACKUP_VERIFICATION_BATCH_SIZE: "3",
      BACKUP_VERIFICATION_REVERIFY_HOURS: "6",
      BACKUP_VERIFICATION_ESCALATION_PCT: "80",
    } as NodeJS.ProcessEnv);
    expect(tuned.batchSize).toBe(3);
    expect(tuned.reVerifyIntervalMs).toBe(6 * 3_600_000);
    expect(tuned.escalationThresholdPct).toBe(80);
    const garbage = readBackupVerifierConfig({
      BACKUP_VERIFICATION_BATCH_SIZE: "-5",
      BACKUP_VERIFICATION_REVERIFY_HOURS: "banana",
    } as NodeJS.ProcessEnv);
    expect(garbage.batchSize).toBe(10);
    expect(garbage.reVerifyIntervalMs).toBe(24 * 3_600_000);
  });
});

describe("classifyCryptoError", () => {
  test("KeyNotFoundError → key-unavailable (the #15310 signature)", () => {
    const error = new Error("key not found: org:abc/dek v1");
    error.name = "KeyNotFoundError";
    expect(classifyCryptoError(error)?.kind).toBe("key-unavailable");
  });

  test("AEAD auth failure → decrypt-failed", () => {
    const error = new Error(
      "AEAD decrypt failed: Unsupported state or unable to authenticate data",
    );
    error.name = "AeadError";
    expect(classifyCryptoError(error)?.kind).toBe("decrypt-failed");
  });

  test("unrelated errors are NOT classified (infra breakage must not stamp rows)", () => {
    expect(classifyCryptoError(new Error("connection terminated unexpectedly"))).toBeNull();
    expect(classifyCryptoError("boom")).toBeNull();
  });
});

describe("runBackupVerificationCycle (real PGlite + real memory KMS)", () => {
  test("happy path: decrypts, matches content_hash, stamps verified, no alert", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("happy"));
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary).toMatchObject({ sampled: 1, verified: 1, failed: 0, errored: 0 });
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("verified");
    expect(row.verified_at).not.toBeNull();
    expect(row.verification_error).toBeNull();
    expect(alerts).toHaveLength(0);
  });

  test("manifest-bearing backup: per-file + component hashes validated", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const state: AgentBackupStateData = {
      ...sampleState("manifest"),
      manifest: fixtureManifest(sandboxId),
    };
    const backupId = await seedFullBackup(sandboxId, state);

    const result = await verifyBackupRestorability(await readBackupRow(backupId));

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      decrypted: true,
      contentHashChecked: true,
      manifestChecked: true,
    });
  });

  test("manifest whose file bytes do not match its claimed sha256 fails as hash-mismatch", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const manifest = fixtureManifest(sandboxId);
    // The capture lied: claimed hash for real bytes it never had.
    manifest.components.media.files[0].sha256 = fixtureSha256("different bytes entirely");
    const state: AgentBackupStateData = { ...sampleState("bad-manifest"), manifest };
    const backupId = await seedFullBackup(sandboxId, state);
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary.failed).toBe(1);
    expect(summary.failures[0].kind).toBe("hash-mismatch");
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("failed");
    expect(row.verification_error).toStartWith("hash-mismatch:");
    expect(row.verification_error).toContain("media/avatar.png");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("corrupted ciphertext: AEAD failure is stamped decrypt-failed and alerts fire", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("corrupt"));

    // Bit-rot the stored envelope in place: same shape, tampered ciphertext.
    const stored = await readBackupRow(backupId);
    const envelope = stored.state_data as EncryptedAgentBackupStateData;
    expect(envelope.kind).toBe("encrypted-agent-backup-state");
    const tampered =
      (envelope.ciphertext.startsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA") +
      envelope.ciphertext.slice(8);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ state_data: { ...envelope, ciphertext: tampered } })
      .where(eq(agentSandboxBackups.id, backupId));

    const { alerts, alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary.failed).toBe(1);
    expect(summary.failures[0].kind).toBe("decrypt-failed");
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("failed");
    expect(row.verification_error).toStartWith("decrypt-failed:");
    expect(row.verification_error).toContain("AEAD decrypt failed");
    // 1/1 failed ≥ 50% threshold → both the failure alert and the systemic
    // escalation fire, on distinct dedup keys.
    expect(summary.escalated).toBe(true);
    expect(alerts.map((a) => a.dedupKey)).toEqual([
      "agent-backup-verification-failure",
      "agent-backup-verification-systemic",
    ]);
  });

  test("wrong KMS key (fresh memory backend, #15310): key-unavailable + systemic escalation", async () => {
    if (!pgliteReady) return;
    const sandboxA = await seedSandbox();
    const sandboxB = await seedSandbox();
    const backupA = await seedFullBackup(sandboxA, sampleState("kms-a"));
    const backupB = await seedFullBackup(sandboxB, sampleState("kms-b"));

    // Reproduce the incident: the memory backend "restarts" and every key it
    // held is gone. The ciphertext rows are intact; only the keys vanished.
    resetKmsClientForTests();

    const { alerts, alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary).toMatchObject({ sampled: 2, verified: 0, failed: 2 });
    expect(summary.failures.map((f) => f.kind)).toEqual(["key-unavailable", "key-unavailable"]);
    for (const backupId of [backupA, backupB]) {
      const row = await readBackupRow(backupId);
      expect(row.verification_status).toBe("failed");
      expect(row.verification_error).toStartWith("key-unavailable:");
    }
    expect(summary.escalated).toBe(true);
    const systemic = alerts.find((a) => a.dedupKey === "agent-backup-verification-systemic");
    expect(systemic).toBeDefined();
    expect(systemic?.message).toContain("KMS misconfiguration");
    expect(systemic?.details.keyUnavailable).toBe(2);
  });

  test("content_hash drift on an otherwise-decryptable backup is stamped hash-mismatch", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("drift"), {
      contentHash: computeStateHash(sampleState("some other state")),
    });
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary.failed).toBe(1);
    expect(summary.failures[0].kind).toBe("hash-mismatch");
    const row = await readBackupRow(backupId);
    expect(row.verification_error).toStartWith("hash-mismatch: content_hash");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("legacy row without content_hash still verifies decryptability (hash check skipped)", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("legacy"), { contentHash: null });

    const result = await verifyBackupRestorability(await readBackupRow(backupId));

    expect(result.ok).toBe(true);
    expect(result.checks.decrypted).toBe(true);
    expect(result.checks.contentHashChecked).toBe(false);
  });

  test("incremental backup: chain replays through the parent and verifies the reconstructed hash", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const base = sampleState("chain-base");
    const next: AgentBackupStateData = {
      memories: [
        ...base.memories,
        { role: "agent", text: "delta memory", timestamp: 1_700_000_100_000 },
      ],
      config: { ...base.config, added: true },
      workspaceFiles: { ...base.workspaceFiles, "new.txt": "delta file" },
    };
    const parentId = await seedFullBackup(sandboxId, base);
    const incremental = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: diffBackupState(base, next),
      size_bytes: 256,
      backup_kind: "incremental",
      parent_backup_id: parentId,
      content_hash: computeStateHash(next),
      // Ensure the incremental is strictly newer so DISTINCT ON picks it.
      created_at: new Date(Date.now() + 1_000),
    });
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    // Only the NEWEST backup per agent is sampled; verifying it transitively
    // decrypts the parent it restores from.
    expect(summary).toMatchObject({ sampled: 1, verified: 1, failed: 0 });
    expect((await readBackupRow(incremental.id)).verification_status).toBe("verified");
    expect((await readBackupRow(parentId)).verification_status).toBeNull();
    expect(alerts).toHaveLength(0);
  });

  test("incremental backup with a corrupted PARENT fails: the restore chain is dead", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const base = sampleState("chain-corrupt");
    const next: AgentBackupStateData = { ...base, config: { ...base.config, changed: 1 } };
    const parentId = await seedFullBackup(sandboxId, base);
    const incremental = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: diffBackupState(base, next),
      size_bytes: 256,
      backup_kind: "incremental",
      parent_backup_id: parentId,
      content_hash: computeStateHash(next),
      created_at: new Date(Date.now() + 1_000),
    });

    const parentRow = await readBackupRow(parentId);
    const envelope = parentRow.state_data as EncryptedAgentBackupStateData;
    const tampered =
      (envelope.ciphertext.startsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA") +
      envelope.ciphertext.slice(8);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ state_data: { ...envelope, ciphertext: tampered } })
      .where(eq(agentSandboxBackups.id, parentId));

    const { alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary.failed).toBe(1);
    expect(summary.failures[0].backupId).toBe(incremental.id);
    expect(summary.failures[0].kind).toBe("decrypt-failed");
  });

  test("fleet-coverage sampling honors the re-verify interval and newest-per-agent", async () => {
    if (!pgliteReady) return;
    const sandboxA = await seedSandbox();
    const sandboxB = await seedSandbox();
    // Agent A has an OLD unverified backup and a NEW recently-verified one;
    // agent B has one never-verified backup.
    await seedFullBackup(sandboxA, sampleState("a-old"));
    const aNewId = await agentSandboxesRepository
      .createBackup({
        sandbox_record_id: sandboxA,
        snapshot_type: "auto",
        state_data: sampleState("a-new"),
        size_bytes: 512,
        backup_kind: "full",
        content_hash: computeStateHash(sampleState("a-new")),
        created_at: new Date(Date.now() + 1_000),
      })
      .then((b) => b.id);
    const bId = await seedFullBackup(sandboxB, sampleState("b"));

    const now = new Date();
    await dbWrite
      .update(agentSandboxBackups)
      .set({ verification_status: "verified", verified_at: now })
      .where(eq(agentSandboxBackups.id, aNewId));

    const { alert } = makeAlertSpy();
    // Within the interval: only agent B's never-verified backup is due. Agent
    // A's OLD backup must not be sampled either — only the newest per agent.
    const first = await runBackupVerificationCycle({ config: CONFIG, alert, now: () => now });
    expect(first).toMatchObject({ sampled: 1, verified: 1, failed: 0 });
    expect((await readBackupRow(bId)).verification_status).toBe("verified");

    // Once the re-verify interval elapses, agent A's newest is due again.
    const later = new Date(now.getTime() + CONFIG.reVerifyIntervalMs + 60_000);
    const second = await runBackupVerificationCycle({ config: CONFIG, alert, now: () => later });
    expect(second.sampled).toBe(2);
    expect(second.verified).toBe(2);
    const aNewRow = await readBackupRow(aNewId);
    expect(aNewRow.verified_at?.getTime()).toBe(later.getTime());
  });

  test("batch size bounds a cycle; the next cycle picks up the remainder", async () => {
    if (!pgliteReady) return;
    for (let i = 0; i < 3; i++) {
      const sandboxId = await seedSandbox();
      await seedFullBackup(sandboxId, sampleState(`batch-${i}`));
    }
    const config = { ...CONFIG, batchSize: 2 };
    const { alert } = makeAlertSpy();

    const first = await runBackupVerificationCycle({ config, alert });
    expect(first.sampled).toBe(2);
    const second = await runBackupVerificationCycle({ config, alert });
    expect(second.sampled).toBe(1);
    const rows = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .orderBy(desc(agentSandboxBackups.created_at));
    expect(rows.every((r) => r.verification_status === "verified")).toBe(true);
  });

  test("disabled config is a no-op", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("disabled"));
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({
      config: { ...CONFIG, enabled: false },
      alert,
    });

    expect(summary).toMatchObject({ enabled: false, sampled: 0 });
    expect((await readBackupRow(backupId)).verification_status).toBeNull();
    expect(alerts).toHaveLength(0);
  });
});

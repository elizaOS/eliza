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
 * service queries through; fails LOUDLY when the ambient DATABASE_URL is a
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

import { KmsError, StewardKmsAdapter } from "@elizaos/security/kms";
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
import { resetObjectStorageClientForTests } from "../storage/s3-compatible-client";
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
  // Floor of 1 so the small-sample escalation tests exercise the threshold
  // semantics; the production floor (default 5) is pinned by its own test.
  minSystemicSample: 1,
  maxDecryptBytesPerCycle: 256 * 1024 * 1024,
  erroredAlertStreak: 3,
};

/** Set env overrides for the duration of `fn`, restoring prior values after. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prior = new Map<string, string | undefined>(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Insert a raw r2-offloaded backup row whose payload no configured object
 * store can serve — the shape a daemon host sees when a backup was offloaded
 * elsewhere but this host has no storage configured (verifier infra error).
 */
async function seedUnfetchableR2Backup(sandboxRecordId: string, createdAt: Date): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "auto",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "r2",
      state_data_key: "agent-sandbox-backups/none/2026-07-01/lost/state_data.json",
      size_bytes: 64,
      backup_kind: "full",
      created_at: createdAt,
    })
    .returning();
  return row.id;
}

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
      "[agent-backup-verifier.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
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
      "[agent-backup-verifier.test] PGlite/pushSchema unavailable — cannot drive the backup verifier against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("readBackupVerifierConfig", () => {
  test("defaults: enabled, batch 10, 24h re-verify, 50% escalation, floor 5, 256MiB budget, streak 3", () => {
    const config = readBackupVerifierConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.batchSize).toBe(10);
    expect(config.reVerifyIntervalMs).toBe(24 * 3_600_000);
    expect(config.escalationThresholdPct).toBe(50);
    expect(config.minSystemicSample).toBe(5);
    expect(config.maxDecryptBytesPerCycle).toBe(256 * 1024 * 1024);
    expect(config.erroredAlertStreak).toBe(3);
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
      BACKUP_VERIFICATION_MIN_SYSTEMIC_SAMPLE: "2",
      BACKUP_VERIFICATION_MAX_DECRYPT_BYTES: "1048576",
      BACKUP_VERIFICATION_ERRORED_ALERT_STREAK: "5",
    } as NodeJS.ProcessEnv);
    expect(tuned.batchSize).toBe(3);
    expect(tuned.reVerifyIntervalMs).toBe(6 * 3_600_000);
    expect(tuned.escalationThresholdPct).toBe(80);
    expect(tuned.minSystemicSample).toBe(2);
    expect(tuned.maxDecryptBytesPerCycle).toBe(1_048_576);
    expect(tuned.erroredAlertStreak).toBe(5);
    const garbage = readBackupVerifierConfig({
      BACKUP_VERIFICATION_BATCH_SIZE: "-5",
      BACKUP_VERIFICATION_REVERIFY_HOURS: "banana",
      BACKUP_VERIFICATION_MAX_DECRYPT_BYTES: "0",
    } as NodeJS.ProcessEnv);
    expect(garbage.batchSize).toBe(10);
    expect(garbage.reVerifyIntervalMs).toBe(24 * 3_600_000);
    expect(garbage.maxDecryptBytesPerCycle).toBe(256 * 1024 * 1024);
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

  test("steward KmsError 404 → key-unavailable (structured status and message fallback)", () => {
    const structured = new KmsError(
      "Steward KMS POST /v1/kms/keys/org%3Aabc%2Fdek/decrypt failed (404 Not Found): no such key material",
      404,
    );
    expect(classifyCryptoError(structured)?.kind).toBe("key-unavailable");

    // A KmsError serialized without the structured status still classifies
    // from the message the adapter formats.
    const messageOnly = new Error(
      "Steward KMS POST /v1/kms/keys/org%3Aabc%2Fdek/decrypt failed (404)",
    );
    messageOnly.name = "KmsError";
    expect(classifyCryptoError(messageOnly)?.kind).toBe("key-unavailable");
  });

  test("steward KmsError with a non-404 status stays unclassified (transport breakage, not a bad key)", () => {
    const unavailable = new KmsError(
      "Steward KMS POST /v1/kms/keys/org%3Aabc%2Fdek/decrypt failed (503 Service Unavailable)",
      503,
    );
    expect(classifyCryptoError(unavailable)).toBeNull();
  });

  test("REAL StewardKmsAdapter 404 decrypt classifies as key-unavailable", async () => {
    const adapter = new StewardKmsAdapter({
      baseUrl: "https://steward.example.test",
      tokenProvider: async () => "token-1",
      // Body deliberately avoids the words "key not found" so the test proves
      // the 404 classification, not the message-substring fallback.
      fetch: async () =>
        new Response(JSON.stringify({ error: "no such key material" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });
    const error = await adapter
      .decrypt("org:abc/dek", new Uint8Array(8), new Uint8Array(12), new Uint8Array(16))
      .then(
        () => {
          throw new Error("expected steward decrypt to reject");
        },
        (err: unknown) => err,
      );
    expect(classifyCryptoError(error)?.kind).toBe("key-unavailable");
  });
});

describe("runBackupVerificationCycle (real PGlite + real memory KMS)", () => {
  test("happy path: decrypts, matches content_hash, stamps verified, no alert", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("legacy"), { contentHash: null });

    const result = await verifyBackupRestorability(await readBackupRow(backupId));

    expect(result.ok).toBe(true);
    expect(result.checks.decrypted).toBe(true);
    expect(result.checks.contentHashChecked).toBe(false);
  });

  test("incremental backup: chain replays through the parent and verifies the reconstructed hash", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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

  test("systemic floor: 1-of-1 failure fires the per-row alert but NOT the systemic page", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("floor"));
    const stored = await readBackupRow(backupId);
    const envelope = stored.state_data as EncryptedAgentBackupStateData;
    const tampered =
      (envelope.ciphertext.startsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA") +
      envelope.ciphertext.slice(8);
    await dbWrite
      .update(agentSandboxBackups)
      .set({ state_data: { ...envelope, ciphertext: tampered } })
      .where(eq(agentSandboxBackups.id, backupId));

    const { alerts, alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({
      config: { ...CONFIG, minSystemicSample: 5 },
      alert,
    });

    // 100% failure rate, but one sampled row is no fleet-wide signature.
    expect(summary).toMatchObject({ sampled: 1, failed: 1, escalated: false });
    expect(alerts.map((a) => a.dedupKey)).toEqual(["agent-backup-verification-failure"]);
  });

  test("errored row is stamped with the attempt and cannot head-of-line-block the next cycle", async () => {
    if (!pgliteReady) return;
    const sandboxBad = await seedSandbox();
    const sandboxGood = await seedSandbox();
    const now = new Date();
    const badId = await seedUnfetchableR2Backup(sandboxBad, new Date(now.getTime() - 60_000));
    const goodState = sampleState("wedge-good");
    const good = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxGood,
      snapshot_type: "auto",
      state_data: goodState,
      size_bytes: 512,
      backup_kind: "full",
      content_hash: computeStateHash(goodState),
      created_at: now,
    });
    const config = { ...CONFIG, batchSize: 1 };
    const { alerts, alert } = makeAlertSpy();

    // Force inline heavy-payload mode so resolving the r2 row is a
    // deterministic no-object-storage-configured infra error on this host.
    await withEnv({ SQL_HEAVY_PAYLOAD_STORAGE: "inline" }, async () => {
      // Cycle 1 samples the older broken row: infra error, stamped `errored`
      // with the attempt timestamp — NOT `failed`.
      const first = await runBackupVerificationCycle({ config, alert, now: () => now });
      expect(first).toMatchObject({ sampled: 1, verified: 0, failed: 0, errored: 1 });
      const badRow = await readBackupRow(badId);
      expect(badRow.verification_status).toBe("errored");
      expect(badRow.verified_at?.getTime()).toBe(now.getTime());
      expect(badRow.verification_error).toStartWith("infra-error[1]:");

      // Cycle 2 at the same clock: the stamped row is no longer due, so the
      // batch-of-1 head moves on to the healthy agent instead of wedging.
      const second = await runBackupVerificationCycle({ config, alert, now: () => now });
      expect(second).toMatchObject({ sampled: 1, verified: 1, errored: 0 });
      expect((await readBackupRow(good.id)).verification_status).toBe("verified");
    });

    // Infra errors are not backup failures: no failure/systemic alert, and
    // the errored-streak alert has not reached its threshold yet.
    expect(alerts).toHaveLength(0);
  });

  test("a row that errors N consecutive attempts raises the errored-streak alert", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const t0 = new Date();
    const badId = await seedUnfetchableR2Backup(sandboxId, new Date(t0.getTime() - 60_000));
    const config = { ...CONFIG, erroredAlertStreak: 2 };
    const { alerts, alert } = makeAlertSpy();

    await withEnv({ SQL_HEAVY_PAYLOAD_STORAGE: "inline" }, async () => {
      const first = await runBackupVerificationCycle({ config, alert, now: () => t0 });
      expect(first.errored).toBe(1);
      expect(alerts).toHaveLength(0);

      // The next attempt happens a re-verify interval later and errors again.
      const t1 = new Date(t0.getTime() + config.reVerifyIntervalMs + 60_000);
      const second = await runBackupVerificationCycle({ config, alert, now: () => t1 });
      expect(second.errored).toBe(1);
    });

    const row = await readBackupRow(badId);
    expect(row.verification_error).toStartWith("infra-error[2]:");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupKey).toBe("agent-backup-verification-errored");
    expect(alerts[0].details.streak).toBe(2);
    expect(alerts[0].details.backupId).toBe(badId);
  });

  test("payload larger than the whole cycle budget is a bounded skip stamped errored", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("oversize"));
    const config = { ...CONFIG, maxDecryptBytesPerCycle: 16 };
    const { alerts, alert } = makeAlertSpy();
    const now = new Date();

    const summary = await runBackupVerificationCycle({ config, alert, now: () => now });

    expect(summary).toMatchObject({
      sampled: 1,
      verified: 0,
      failed: 0,
      errored: 0,
      oversizeSkipped: 1,
    });
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("errored");
    expect(row.verified_at?.getTime()).toBe(now.getTime());
    expect(row.verification_error).toMatch(
      /^infra-error\[1\]: stored payload of \d+ bytes exceeds BACKUP_VERIFICATION_MAX_DECRYPT_BYTES=16$/,
    );
    expect(alerts).toHaveLength(0);

    // Stamped: the next cycle inside the re-verify interval moves on.
    const again = await runBackupVerificationCycle({ config, alert, now: () => now });
    expect(again.sampled).toBe(0);
  });

  test("cycle budget exhaustion defers the remainder, unstamped, to the next cycle", async () => {
    if (!pgliteReady) return;
    const sandboxA = await seedSandbox();
    const sandboxB = await seedSandbox();
    const now = new Date();
    // Same-length markers keep both stored payloads the same size.
    const seed = async (sandbox: string, marker: string, createdAt: Date) => {
      const state = sampleState(marker);
      const backup = await agentSandboxesRepository.createBackup({
        sandbox_record_id: sandbox,
        snapshot_type: "auto",
        state_data: state,
        size_bytes: 512,
        backup_kind: "full",
        content_hash: computeStateHash(state),
        created_at: createdAt,
      });
      return backup.id;
    };
    const aId = await seed(sandboxA, "budget-a", new Date(now.getTime() - 1_000));
    const bId = await seed(sandboxB, "budget-b", now);
    const bytesOf = async (id: string) =>
      Buffer.byteLength(JSON.stringify((await readBackupRow(id)).state_data), "utf8");
    const aBytes = await bytesOf(aId);
    const bBytes = await bytesOf(bId);
    // Budget covers either row alone but never both in one cycle.
    const config = { ...CONFIG, maxDecryptBytesPerCycle: aBytes + bBytes - 1 };
    const { alerts, alert } = makeAlertSpy();

    const first = await runBackupVerificationCycle({ config, alert, now: () => now });
    expect(first).toMatchObject({ sampled: 1, verified: 1, budgetDeferred: 1 });
    expect((await readBackupRow(aId)).verification_status).toBe("verified");
    // Deferred, not stamped: still eligible at the head of the next cycle.
    expect((await readBackupRow(bId)).verification_status).toBeNull();

    const second = await runBackupVerificationCycle({ config, alert, now: () => now });
    expect(second).toMatchObject({ sampled: 1, verified: 1, budgetDeferred: 0 });
    expect((await readBackupRow(bId)).verification_status).toBe("verified");
    expect(alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R2-offloaded rows, driven through the REAL S3-compatible client against a
// local HTTP object-store stub (only the remote storage SERVER is simulated;
// the SDK, offload/hydrate code, KMS, and verifier all run for real). The
// stub speaks just enough S3: PUT stores, GET serves or returns the S3
// NoSuchKey XML error the AWS SDK deserializes into a thrown `NoSuchKey`.
// Per-key GET counters make the storage boundary observable, proving chain
// reconstruction touches only chain members.
// ---------------------------------------------------------------------------

describe("r2-offloaded backups (real S3 client against a local object-store stub)", () => {
  const objects = new Map<string, string>();
  const getCounts = new Map<string, number>();
  let server: ReturnType<typeof Bun.serve> | null = null;
  let priorEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Path-style addressing: /<bucket>/<key…>
        const key = url.pathname.split("/").slice(2).join("/");
        if (req.method === "PUT") {
          objects.set(key, await req.text());
          return new Response(null, { status: 200 });
        }
        if (req.method === "GET") {
          getCounts.set(key, (getCounts.get(key) ?? 0) + 1);
          const body = objects.get(key);
          if (body === undefined) {
            return new Response(
              '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${key}</Key></Error>`,
              { status: 404, headers: { "content-type": "application/xml" } },
            );
          }
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("unsupported", { status: 405 });
      },
    });
    const env: Record<string, string> = {
      STORAGE_PROVIDER: "s3",
      STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
      STORAGE_REGION: "local",
      STORAGE_ACCESS_KEY_ID: "verifier-test",
      STORAGE_SECRET_ACCESS_KEY: "verifier-test",
      STORAGE_FORCE_PATH_STYLE: "1",
      STORAGE_HEAVY_PAYLOADS_BUCKET: "verifier-test-bucket",
      SQL_HEAVY_PAYLOAD_STORAGE: "r2",
      SQL_HEAVY_PAYLOAD_MIN_BYTES: "0",
    };
    priorEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    resetObjectStorageClientForTests();
  });

  afterAll(() => {
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetObjectStorageClientForTests();
    server?.stop(true);
  });

  beforeEach(() => {
    objects.clear();
    getCounts.clear();
  });

  async function stateDataKeyOf(backupId: string): Promise<string> {
    const row = await readBackupRow(backupId);
    expect(row.state_data_storage).toBe("r2");
    if (!row.state_data_key) throw new Error(`backup ${backupId} has no state_data_key`);
    return row.state_data_key;
  }

  test("R2 payload lost out from under the row (NoSuchKey) stamps payload-missing and alerts", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const state = sampleState("r2-missing");
    const backup = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: state,
      size_bytes: 1024,
      backup_kind: "full",
      content_hash: computeStateHash(state),
    });
    const key = await stateDataKeyOf(backup.id);
    expect(objects.has(key)).toBe(true);
    // The bucket loses the object; the row still points at it.
    objects.delete(key);

    const { alerts, alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary).toMatchObject({ sampled: 1, verified: 0, failed: 1, errored: 0 });
    expect(summary.failures[0].kind).toBe("payload-missing");
    const row = await readBackupRow(backup.id);
    expect(row.verification_status).toBe("failed");
    expect(row.verified_at).not.toBeNull();
    expect(row.verification_error).toStartWith("payload-missing:");
    expect(row.verification_error).toContain(key);
    expect(alerts.map((a) => a.dedupKey)).toContain("agent-backup-verification-failure");
  });

  test("r2-offloaded backup verifies end to end through download + decrypt", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const state = sampleState("r2-happy");
    const backup = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: state,
      size_bytes: 1024,
      backup_kind: "full",
      content_hash: computeStateHash(state),
    });
    await stateDataKeyOf(backup.id);
    const { alerts, alert } = makeAlertSpy();

    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary).toMatchObject({ sampled: 1, verified: 1, failed: 0, errored: 0 });
    expect((await readBackupRow(backup.id)).verification_status).toBe("verified");
    expect(alerts).toHaveLength(0);
  });

  test("incremental verification fetches ONLY chain members from object storage", async () => {
    if (!pgliteReady) return;
    const sandboxId = await seedSandbox();
    const now = Date.now();

    // Retained NON-chain fulls a restore of the newest backup never touches.
    const unrelatedIds: string[] = [];
    for (const [index, marker] of ["r2-old-1", "r2-old-2"].entries()) {
      const state = sampleState(marker);
      const backup = await agentSandboxesRepository.createBackup({
        sandbox_record_id: sandboxId,
        snapshot_type: "auto",
        state_data: state,
        size_bytes: 512,
        backup_kind: "full",
        content_hash: computeStateHash(state),
        created_at: new Date(now - 30_000 + index * 5_000),
      });
      unrelatedIds.push(backup.id);
    }

    const base = sampleState("r2-chain-base");
    const parent = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: base,
      size_bytes: 512,
      backup_kind: "full",
      content_hash: computeStateHash(base),
      created_at: new Date(now - 10_000),
    });
    const next: AgentBackupStateData = {
      memories: [...base.memories, { role: "agent", text: "delta", timestamp: now }],
      config: { ...base.config, delta: true },
      workspaceFiles: { ...base.workspaceFiles, "delta.txt": "delta file" },
    };
    const incremental = await agentSandboxesRepository.createBackup({
      sandbox_record_id: sandboxId,
      snapshot_type: "auto",
      state_data: diffBackupState(base, next),
      size_bytes: 128,
      backup_kind: "incremental",
      parent_backup_id: parent.id,
      content_hash: computeStateHash(next),
      created_at: new Date(now),
    });

    const parentKey = await stateDataKeyOf(parent.id);
    const targetKey = await stateDataKeyOf(incremental.id);
    const unrelatedKeys = await Promise.all(unrelatedIds.map(stateDataKeyOf));
    // Discard the GETs createBackup's own hydration performed while seeding;
    // from here on, every GET is the verifier's.
    getCounts.clear();

    const { alerts, alert } = makeAlertSpy();
    const summary = await runBackupVerificationCycle({ config: CONFIG, alert });

    expect(summary).toMatchObject({ sampled: 1, verified: 1, failed: 0, errored: 0 });
    expect((await readBackupRow(incremental.id)).verification_status).toBe("verified");
    expect(alerts).toHaveLength(0);
    // Storage-boundary proof: the sampled row and its chain parent were each
    // downloaded exactly once; the sandbox's other retained backups (which
    // the repository restore path would have hydrated wholesale) were never
    // touched.
    expect(getCounts.get(targetKey)).toBe(1);
    expect(getCounts.get(parentKey)).toBe(1);
    for (const key of unrelatedKeys) {
      expect(getCounts.get(key)).toBeUndefined();
    }
  });
});

/** Real stored ciphertext, source CAS and the production recovery constraint; synthetic data only. */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentBackupManifest } from "@elizaos/contracts";
import { AGENT_BACKUP_CANONICAL_JSON, canonicalJsonString } from "@elizaos/core/protocol";
import { eq, is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { closeDatabaseConnectionsForTests } from "../../db/client";
import { encryptAgentBackupStateData } from "../../db/crypto/agent-backups";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import { dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import type {
  AgentBackupStateData,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { agentSandboxBackups, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import * as store from "../storage/object-store";
import { logger } from "../utils/logger";
import {
  createDecryptBudget,
  resetBackupVerificationSamplerForTests,
  runBackupVerificationCycle,
  verifyAndStampBackupRestorability,
  verifyBackupRestorability,
} from "./agent-backup-verifier";
import { SandboxBackup, type SandboxBackupHost } from "./eliza-sandbox/backup/service";
import { SandboxDeletion, type SandboxDeletionHost } from "./eliza-sandbox/lifecycle/deletion";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "./tenant-db/__tests__/ephemeral-postgres";

const enabled = process.env.REQUIRE_REAL_POSTGRES_BACKUP_VERIFICATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;
const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const AGENT = "20000000-0000-4000-8000-000000000001";
const USER = "30000000-0000-4000-8000-000000000001";
const ATTEMPT = "40000000-0000-4000-8000-000000000001";
const START = new Date("2026-01-01T00:00:00Z");
const CREATED = new Date("2026-01-01T00:00:01Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hashJson = (value: object) => sha(canonicalJsonString(value, AGENT_BACKUP_CANONICAL_JSON));

function fixtureDefault(value: unknown, type: string): string {
  if (value === undefined) return "";
  if (is(value, SQL)) {
    const query = new PgDialect().sqlToQuery(value);
    if (query.params.length) throw new Error("Fixture defaults must be literal production DDL");
    return ` DEFAULT ${query.sql}`;
  }
  if (value === null) return " DEFAULT NULL";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return ` DEFAULT ${String(value)}`;
  if (typeof value === "string") return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (type === "jsonb" || type === "json")
    return ` DEFAULT '${JSON.stringify(value).replaceAll("'", "''")}'::${type}`;
  throw new Error(`Unsupported literal schema default for ${type}`);
}

function state(): AgentBackupStateData {
  const empty = {
    kind: "file-set" as const,
    rootLabel: "state-dir" as const,
    files: [],
    sha256: hashJson([]),
  };
  const bytes = Buffer.from("synthetic backup fixture");
  const file = {
    path: "fixture.txt",
    bytesBase64: bytes.toString("base64"),
    size: bytes.length,
    sha256: sha(bytes.toString()),
  };
  const stateFiles = {
    ...empty,
    files: [file],
    sha256: hashJson([{ path: file.path, size: file.size, sha256: file.sha256 }]),
  };
  const character = {
    runtimeCharacter: { name: "Synthetic" },
    sha256: hashJson({ runtimeCharacter: { name: "Synthetic" }, configFile: undefined }),
  };
  const database = { kind: "none" as const, sha256: hashJson({ kind: "none" }) };
  const manifest: AgentBackupManifest = {
    schemaVersion: 1,
    format: "elizaos.agent-backup",
    createdAt: CREATED.toISOString(),
    agentId: AGENT,
    components: { database, media: empty, vault: empty, character, stateFiles },
    integrity: {
      componentHashes: {
        database: database.sha256,
        media: empty.sha256,
        vault: empty.sha256,
        character: character.sha256,
        stateFiles: stateFiles.sha256,
      },
    },
  };
  return { memories: [], config: {}, workspaceFiles: {}, manifest };
}

suite("persisted legacy backup verification and deletion retention", () => {
  let postgres: EphemeralPostgres;
  let client: Client;

  beforeAll(async () => {
    const supplied = process.env.APPS_TENANT_DB_TEST_DSN;
    postgres = (await acquireEphemeralPostgres())!;
    if (!postgres) throw new Error("A real isolated PostgreSQL instance is required");
    const url = new URL(postgres.dsn);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      (supplied && !url.pathname.endsWith("backup_verification_test"))
    ) {
      throw new Error(
        "Refusing destructive fixtures outside the isolated local backup verification database",
      );
    }
    if (process.env.DATABASE_URL !== postgres.dsn) {
      throw new Error("DATABASE_URL must bind the same isolated instance before source imports");
    }
    client = new Client({ connectionString: postgres.dsn });
    await client.connect();

    // Types and defaults come from the real schema: the actual producer uses
    // SQL DEFAULT, including full backup_kind. Unrelated table constraints are
    // absent; the exact recovery/catalog CHECK DDL is applied below.
    for (const table of [organizations, users, agentSandboxes, agentSandboxBackups]) {
      const config = getTableConfig(table);
      const columns = config.columns.map(
        (column) =>
          `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY" : table === agentSandboxBackups && column.notNull ? " NOT NULL" : ""}${fixtureDefault(column.default, column.getSQLType())}`,
      );
      await client.query(`CREATE TABLE "${config.name}" (${columns.join(",")})`);
    }
    // Real lazy schema setup also seeds its warm-pool owner and adds tenant FKs.
    await client.query("INSERT INTO organizations (id) VALUES ($1), ($2)", [ORG, OTHER_ORG]);
    await client.query("INSERT INTO users (id, organization_id) VALUES ($1, $2)", [USER, ORG]);
    const migration = await readFile(
      new URL("../../db/migrations/0222_agent_backup_catalog_identity_checks.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
  });

  beforeEach(async () => {
    await client.query("TRUNCATE agent_sandbox_backups, agent_sandboxes CASCADE");
    resetKmsClientForTests();
    resetBackupVerificationSamplerForTests();
    await client.query(
      `INSERT INTO agent_sandboxes
      (id,organization_id,user_id,status,execution_tier,pool_status,deleted_at,sandbox_id,node_id,container_name,
       environment_revision,lifecycle_revision,image_digest,deletion_attempt_id,deletion_started_at)
      VALUES ($1,$2,$3,'deletion_pending','dedicated-always',NULL,NULL,'container-fixture','node-fixture','agent-fixture',2,7,NULL,$4,$5)`,
      [AGENT, ORG, USER, ATTEMPT, START],
    );
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
    await client?.end();
    await postgres?.stop();
  });

  async function persisted(input = state(), id = randomUUID()): Promise<StoredAgentSandboxBackup> {
    const encrypted = await encryptAgentBackupStateData(ORG, id, input);
    await client.query(
      `INSERT INTO agent_sandbox_backups
      (id,sandbox_record_id,snapshot_type,backup_kind,state_data,state_data_storage,size_bytes,created_at)
      VALUES ($1,$2,'pre-delete','full',$3::jsonb,'inline',123,$4)`,
      [id, AGENT, JSON.stringify(encrypted), CREATED],
    );
    return (await agentSandboxesRepository.getStoredBackupById(id))!;
  }

  const authority = () => ({
    agentId: AGENT,
    organizationId: ORG,
    deletionAttemptId: ATTEMPT,
    deletionStartedAt: START,
    lifecycleRevision: 7,
    environmentRevision: 2,
    sandboxId: "container-fixture",
    nodeId: "node-fixture",
  });
  async function verification(id: string) {
    return (
      await client.query(
        "SELECT verification_status, verified_at, content_hash FROM agent_sandbox_backups WHERE id=$1",
        [id],
      )
    ).rows[0];
  }

  test("real ciphertext/manifest verification admits the exact PostgreSQL recovery shape without inventing a row hash", async () => {
    const row = await persisted();
    await expect(
      client.query(
        `UPDATE agent_sandbox_backups SET sandbox_record_id=NULL,
      recovery_agent_id=$2,recovery_organization_id=$3,recovery_deletion_attempt_id=$4,recovery_expires_at=$5 WHERE id=$1`,
        [row.id, AGENT, ORG, ATTEMPT, new Date("2026-02-01T00:00:00Z")],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_sandbox_backups_recovery_shape_check",
    });
    const result = await verifyAndStampBackupRestorability(row, { preDelete: authority() });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      decrypted: true,
      manifestChecked: true,
      contentHashChecked: false,
    });
    expect((await verification(row.id)).content_hash).toBeNull();
    const retained = await dbWrite.transaction((tx) =>
      agentSandboxesRepository.retainPreDeleteBackupForDeletedAgent(tx, {
        backupId: row.id,
        sandboxRecordId: AGENT,
        organizationId: ORG,
        deletionAttemptId: ATTEMPT,
        deletionStartedAt: START,
        expiresAt: new Date("2026-02-01T00:00:00Z"),
      }),
    );
    expect(retained).toBe(true);
    const recovery = (
      await client.query(
        "SELECT sandbox_record_id,recovery_agent_id,recovery_organization_id FROM agent_sandbox_backups WHERE id=$1",
        [row.id],
      )
    ).rows[0];
    expect(recovery).toEqual({
      sandbox_record_id: null,
      recovery_agent_id: AGENT,
      recovery_organization_id: ORG,
    });
  });

  test("real AEAD corruption never receives a verified recovery stamp", async () => {
    const row = await persisted();
    const encrypted = row.state_data;
    if (!("ciphertext" in encrypted)) throw new Error("Fixture must use real ciphertext");
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] ^= 1;
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data=jsonb_set(state_data,'{ciphertext}',$2::jsonb) WHERE id=$1",
      [row.id, JSON.stringify(bytes.toString("base64"))],
    );
    const current = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    const result = await verifyAndStampBackupRestorability(current, { preDelete: authority() });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("decrypt-failed");
    expect((await verification(row.id)).verification_status).toBe("failed");
  });

  test("a decrypted but inconsistent manifest cannot authorize retention", async () => {
    const input = state();
    input.manifest!.components.stateFiles.files[0].bytesBase64 =
      Buffer.from("tampered").toString("base64");
    const row = await persisted(input);
    const result = await verifyAndStampBackupRestorability(row, { preDelete: authority() });
    expect(result.failure?.kind).toBe("hash-mismatch");
    expect((await verification(row.id)).verification_status).toBe("failed");
  });

  test("missing full-agent manifest and bounded skips cannot become recovery points", async () => {
    const row = await persisted({ memories: [], config: {}, workspaceFiles: {} });
    const result = await verifyAndStampBackupRestorability(row, { preDelete: authority() });
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("invalid-payload");
    const another = await persisted();
    const skipped = await verifyAndStampBackupRestorability(another, {
      preDelete: authority(),
      budget: createDecryptBudget(1),
    });
    expect(skipped.skipped).toBeDefined();
    expect((await verification(another.id)).verification_status).toBeNull();
  });

  test("wrong tenant, attempt or source generation fails before publication", async () => {
    const row = await persisted();
    for (const change of [
      { organizationId: OTHER_ORG },
      { deletionAttemptId: randomUUID() },
      { lifecycleRevision: 8 },
      { environmentRevision: 3 },
    ]) {
      await expect(
        verifyAndStampBackupRestorability(row, { preDelete: { ...authority(), ...change } }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_VERIFICATION_AUTHORITY_CHANGED" });
    }
    expect((await verification(row.id)).verification_status).toBeNull();
  });

  test("a tenant move cannot verify ciphertext sealed under the original organization's DEK", async () => {
    const row = await persisted();
    await client.query("UPDATE agent_sandboxes SET organization_id=$2 WHERE id=$1", [
      AGENT,
      OTHER_ORG,
    ]);
    const result = await verifyAndStampBackupRestorability(row, {
      preDelete: { ...authority(), organizationId: OTHER_ORG },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.decrypted).toBe(false);
    expect(result.failure?.kind).toBe("invalid-payload");
    expect((await verification(row.id)).verification_status).toBe("failed");
  });

  test("artifact/key and generation mutation after actual verification rejects the CAS", async () => {
    for (const mutation of [
      "UPDATE agent_sandbox_backups SET state_data=jsonb_set(state_data,'{nonce}','\"changed\"') WHERE id=$1",
      "UPDATE agent_sandbox_backups SET state_data_key='other-object' WHERE id=$1",
      "UPDATE agent_sandboxes SET lifecycle_revision=lifecycle_revision+1 WHERE id=$1",
      "UPDATE agent_sandboxes SET node_id='other-node' WHERE id=$1",
      "UPDATE agent_sandboxes SET container_name='other-container' WHERE id=$1",
      "UPDATE agent_sandboxes SET organization_id='10000000-0000-4000-8000-000000000002' WHERE id=$1",
    ]) {
      const row = await persisted();
      const source = (await agentSandboxesRepository.getLegacyBackupVerificationSource(row))!;
      expect((await verifyBackupRestorability(row)).ok).toBe(true);
      await client.query(mutation, [mutation.includes("agent_sandboxes ") ? AGENT : row.id]);
      expect(
        await agentSandboxesRepository.stampBackupVerificationIfCurrent(row, source, {
          status: "verified",
          verifiedAt: CREATED,
          error: null,
        }),
      ).toBe(false);
      expect((await verification(row.id)).verification_status).toBeNull();
      await client.query(
        "UPDATE agent_sandboxes SET lifecycle_revision=7,organization_id=$2,node_id='node-fixture',container_name='agent-fixture' WHERE id=$1",
        [AGENT, ORG],
      );
    }
  });

  test("preserves native microseconds and rejects a same-millisecond timestamp mutation", async () => {
    const first = await persisted();
    await client.query(
      "UPDATE agent_sandbox_backups SET created_at='2026-01-01 00:00:01.123456+00' WHERE id=$1",
      [first.id],
    );
    const row = (await agentSandboxesRepository.getStoredBackupById(first.id))!;
    const source = (await agentSandboxesRepository.getLegacyBackupVerificationSource(row))!;
    expect(source.backupCreatedAtNative).toContain(".123456");
    expect((await verifyBackupRestorability(row)).ok).toBe(true);
    await client.query(
      "UPDATE agent_sandbox_backups SET created_at='2026-01-01 00:00:01.123457+00' WHERE id=$1",
      [row.id],
    );
    expect(
      await agentSandboxesRepository.stampBackupVerificationIfCurrent(row, source, {
        status: "verified",
        verifiedAt: CREATED,
        error: null,
      }),
    ).toBe(false);
    expect((await verification(row.id)).verification_status).toBeNull();
    const current = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    expect((await verifyAndStampBackupRestorability(current, { preDelete: authority() })).ok).toBe(
      true,
    );
  });

  test("a capture predating its intent within the same millisecond cannot authorize teardown", async () => {
    const first = await persisted();
    await client.query(
      "UPDATE agent_sandboxes SET deletion_started_at='2026-01-01 00:00:00.999999+00' WHERE id=$1",
      [AGENT],
    );
    await client.query(
      "UPDATE agent_sandbox_backups SET created_at='2026-01-01 00:00:00.999000+00' WHERE id=$1",
      [first.id],
    );
    const row = (await agentSandboxesRepository.getStoredBackupById(first.id))!;
    await expect(
      verifyAndStampBackupRestorability(row, {
        preDelete: { ...authority(), deletionStartedAt: new Date("2026-01-01T00:00:00.999Z") },
      }),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_VERIFICATION_AUTHORITY_CHANGED" });
    expect((await verification(row.id)).verification_status).toBeNull();
  });

  test("captured-success ACK still cannot reach provider teardown when the persisted manifest fails", async () => {
    await client.query(
      "UPDATE agent_sandboxes SET status='running',deletion_attempt_id=NULL,deletion_started_at=NULL,bridge_url='https://bridge.invalid' WHERE id=$1",
      [AGENT],
    );
    const input = state();
    input.manifest!.components.stateFiles.files[0].bytesBase64 =
      Buffer.from("corrupt capture").toString("base64");
    let captureCount = 0,
      providerCount = 0;
    const unexpected = () => {
      throw new Error("unexpected synthetic host operation");
    };
    const backupHost: SandboxBackupHost = {
      lockLifecycle: unexpected,
      getAgentForLifecycleMutation: unexpected,
      fetchAgentApi: unexpected,
      getSafeBridgeEndpoint: unexpected,
      getAgentJsonHeaders: unexpected,
    };
    const backup = new SandboxBackup(backupHost);
    const host: SandboxDeletionHost = {
      getAgentForWrite: (id, org) => agentSandboxesRepository.findByIdAndOrgForWrite(id, org),
      fetchSnapshotState: async () => {
        captureCount += 1;
        return { stateData: input, sizeBytes: 123, bridgeUrl: "https://bridge.invalid" };
      },
      runBoundedSandboxStop: async () => {
        providerCount += 1;
        return { kind: "stop-failed", error: new Error("synthetic provider boundary") };
      },
      isIgnorableSandboxStopError: () => false,
      lockLifecycle: unexpected,
      getAgentForLifecycleMutation: unexpected,
      getReplacementCleanupLocator: unexpected,
      hasActiveProvisionJobTx: unexpected,
      hasActiveReplacementJobTx: unexpected,
      persistSnapshotWithinTransaction: (...args) =>
        backup.persistSnapshotWithinTransaction(...args),
      retirePersistedReplacementCleanup: unexpected,
    };
    const deletion = new SandboxDeletion(host);
    const prepare = spyOn(deletion, "prepareAgentDelete").mockImplementation(
      async (_id, _org, _authorization, captured) => {
        if (!captured?.snapshot)
          throw new Error("capture must succeed before the prepared transaction");
        return dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              status: "deletion_pending",
              deletion_attempt_id: ATTEMPT,
              deletion_started_at: START,
            })
            .where(eq(agentSandboxes.id, AGENT));
          const persisted = await backup.persistSnapshotWithinTransaction(
            tx,
            AGENT,
            ORG,
            "pre-delete",
            captured.snapshot!.stateData,
            captured.snapshot!.sizeBytes,
          );
          const [stored] = await tx
            .select()
            .from(agentSandboxBackups)
            .where(eq(agentSandboxBackups.id, persisted.backupId));
          expect(stored.backup_kind).toBe("full");
          expect(stored.parent_backup_id).toBeNull();
          expect(stored.snapshot_type).toBe("pre-delete");
          expect(stored.state_data_storage).toBe("inline");
          expect(stored.catalog_version ?? 1).toBe(1);
          return {
            ok: true as const,
            sandboxId: "container-fixture",
            nodeId: "node-fixture",
            status: "running" as const,
            sourcePoolId: null,
            environmentRevision: 2,
            lifecycleRevision: persisted.lifecycleRevision,
            deletionAttemptId: ATTEMPT,
            deletionStartedAt: START,
            preDeleteBackupId: persisted.backupId,
            deletionLocator: null,
          };
        });
      },
    );
    try {
      const result = await deletion.deleteAgent(AGENT, ORG, {
        authorization: "user_request",
        stateLossAcknowledged: true,
      });
      expect(captureCount).toBe(1);
      expect(result.success).toBe(false);
      expect(providerCount).toBe(0);
      const rows = await client.query("SELECT verification_status FROM agent_sandbox_backups");
      expect(rows.rows).toEqual([{ verification_status: "failed" }]);
    } finally {
      prepare.mockRestore();
    }
  });

  test("detached recovery tenant mismatch and absent row never publish a successful stamp", async () => {
    const row = await persisted();
    await verifyAndStampBackupRestorability(row, { preDelete: authority() });
    await client.query(
      `UPDATE agent_sandbox_backups SET sandbox_record_id=NULL,recovery_agent_id=$2,
      recovery_organization_id=$3,recovery_deletion_attempt_id=$4,recovery_expires_at=$5 WHERE id=$1`,
      [row.id, AGENT, ORG, ATTEMPT, new Date("2026-02-01T00:00:00Z")],
    );
    const detached = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    const source = (await agentSandboxesRepository.getLegacyBackupVerificationSource(detached))!;
    expect(
      await agentSandboxesRepository.stampBackupVerificationIfCurrent(
        detached,
        { ...source, organizationId: OTHER_ORG },
        { status: "verified", verifiedAt: CREATED, error: null },
      ),
    ).toBe(false);
    await client.query("DELETE FROM agent_sandbox_backups WHERE id=$1", [row.id]);
    expect(
      await agentSandboxesRepository.stampBackupVerificationIfCurrent(detached, source, {
        status: "verified",
        verifiedAt: CREATED,
        error: null,
      }),
    ).toBe(false);
  });

  test("object bytes changed before the stamp cannot borrow the first verification result", async () => {
    const row = await persisted();
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data_storage='r2',state_data_key='synthetic-object' WHERE id=$1",
      [row.id],
    );
    const current = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    let reads = 0;
    const configured = spyOn(store, "shouldUseObjectStorage").mockReturnValue(true);
    const object = spyOn(store, "getObjectText").mockImplementation(async () =>
      ++reads === 1 ? JSON.stringify(row.state_data) : JSON.stringify({ changed: true }),
    );
    try {
      await expect(
        verifyAndStampBackupRestorability(current, { preDelete: authority() }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_VERIFICATION_AUTHORITY_CHANGED" });
      expect((await verification(row.id)).verification_status).toBeNull();
    } finally {
      object.mockRestore();
      configured.mockRestore();
    }
  });

  test("fleet infrastructure fallback cannot stamp a source that moved while storage failed", async () => {
    const row = await persisted();
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data_storage='r2',state_data_key='synthetic-object' WHERE id=$1",
      [row.id],
    );
    const configured = spyOn(store, "shouldUseObjectStorage").mockReturnValue(true);
    const object = spyOn(store, "getObjectText").mockImplementation(async () => {
      await client.query("UPDATE agent_sandboxes SET lifecycle_revision=8 WHERE id=$1", [AGENT]);
      throw new Error("synthetic storage transport failure");
    });
    try {
      const summary = await runBackupVerificationCycle({
        alert: async () => {},
        config: {
          enabled: true,
          batchSize: 1,
          reVerifyIntervalMs: 1,
          escalationThresholdPct: 50,
          minSystemicSample: 5,
          maxDecryptBytesPerCycle: 1024 * 1024,
          erroredAlertStreak: 3,
        },
      });
      expect(summary.errored).toBe(1);
      expect((await verification(row.id)).verification_status).toBeNull();
    } finally {
      object.mockRestore();
      configured.mockRestore();
    }
  });

  test("detached legacy failed rechecks preserve historical proof and the recovery artifact", async () => {
    const row = await persisted();
    await verifyAndStampBackupRestorability(row, { preDelete: authority(), now: CREATED });
    const expiry = new Date("2026-02-01T00:00:00Z");
    await client.query(
      `UPDATE agent_sandbox_backups SET sandbox_record_id=NULL,
      recovery_agent_id=$2,recovery_organization_id=$3,recovery_deletion_attempt_id=$4,
      recovery_expires_at=$5 WHERE id=$1`,
      [row.id, AGENT, ORG, ATTEMPT, expiry],
    );
    const historical = await client.query(
      `SELECT verification_status,verified_at::text,
      recovery_expires_at::text FROM agent_sandbox_backups WHERE id=$1`,
      [row.id],
    );
    const detached = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    const encrypted = detached.state_data as { ciphertext: string };
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] ^= 1;
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data=jsonb_set(state_data,'{ciphertext}',$2::jsonb) WHERE id=$1",
      [row.id, JSON.stringify(bytes.toString("base64"))],
    );
    const current = (await agentSandboxesRepository.getStoredBackupById(row.id))!;
    const result = await verifyAndStampBackupRestorability(current);
    expect(result.ok).toBe(false);
    expect(result.historicalProofPreserved).toBe(true);
    expect(result.failure?.kind).toBe("decrypt-failed");
    const alerts: unknown[] = [];
    const config = {
      enabled: true,
      batchSize: 1,
      reVerifyIntervalMs: 1,
      escalationThresholdPct: 50,
      minSystemicSample: 5,
      maxDecryptBytesPerCycle: 1024 * 1024,
      erroredAlertStreak: 3,
    };
    const failed = await runBackupVerificationCycle({
      config,
      now: () => new Date("2026-01-02T00:00:00Z"),
      alert: async (value) => {
        alerts.push(value);
      },
    });
    expect(failed.failed).toBe(1);
    expect(failed.failures[0].message).toBe(
      "Retained legacy recovery backup failed its current recheck",
    );
    expect(alerts).toHaveLength(1);
    const unchanged = await client.query(
      `SELECT verification_status,verified_at::text,
      recovery_expires_at::text FROM agent_sandbox_backups WHERE id=$1`,
      [row.id],
    );
    expect(unchanged.rows).toEqual(historical.rows);
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data_storage='r2',state_data_key='synthetic-retained-object' WHERE id=$1",
      [row.id],
    );
    const configured = spyOn(store, "shouldUseObjectStorage").mockReturnValue(true);
    const object = spyOn(store, "getObjectText").mockRejectedValue(
      new Error("private-storage-context-sentinel"),
    );
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const errored = await runBackupVerificationCycle({
        config,
        now: () => new Date("2026-01-02T00:00:00Z"),
        alert: async () => {},
      });
      expect(errored.errored).toBe(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("private-storage-context-sentinel");
      const retained = await client.query(
        `SELECT verification_status,verified_at::text,
        recovery_expires_at::text,state_data_key FROM agent_sandbox_backups WHERE id=$1`,
        [row.id],
      );
      expect(retained.rows[0]).toEqual({
        ...historical.rows[0],
        state_data_key: "synthetic-retained-object",
      });
    } finally {
      object.mockRestore();
      configured.mockRestore();
      logged.mockRestore();
    }
  });

  test("a damaged retained legacy recovery point does not starve another stale agent", async () => {
    const damagedId = "50000000-0000-4000-8000-000000000001";
    const healthyId = "60000000-0000-4000-8000-000000000001";
    const healthyAgent = "20000000-0000-4000-8000-000000000002";
    const damaged = await persisted(state(), damagedId);
    await verifyAndStampBackupRestorability(damaged, { preDelete: authority(), now: CREATED });
    await client.query(
      `UPDATE agent_sandbox_backups SET sandbox_record_id=NULL,
       recovery_agent_id=$2,recovery_organization_id=$3,recovery_deletion_attempt_id=$4,
       recovery_expires_at=$5 WHERE id=$1`,
      [damagedId, AGENT, ORG, ATTEMPT, new Date("2026-02-01T00:00:00Z")],
    );
    const detached = (await agentSandboxesRepository.getStoredBackupById(damagedId))!;
    const bytes = Buffer.from((detached.state_data as { ciphertext: string }).ciphertext, "base64");
    bytes[0] ^= 1;
    await client.query(
      "UPDATE agent_sandbox_backups SET state_data=jsonb_set(state_data,'{ciphertext}',$2::jsonb) WHERE id=$1",
      [damagedId, JSON.stringify(bytes.toString("base64"))],
    );
    const historical = await client.query(
      `SELECT verification_status,verified_at::text,recovery_expires_at::text,
       verification_error FROM agent_sandbox_backups WHERE id=$1`,
      [damagedId],
    );
    await client.query(
      `INSERT INTO agent_sandboxes (id,organization_id,user_id,status,execution_tier)
       VALUES ($1,$2,$3,'running','dedicated-always')`,
      [healthyAgent, ORG, USER],
    );
    const healthyState = state();
    healthyState.manifest!.agentId = healthyAgent;
    const encrypted = await encryptAgentBackupStateData(ORG, healthyId, healthyState);
    await client.query(
      `INSERT INTO agent_sandbox_backups
       (id,sandbox_record_id,snapshot_type,backup_kind,state_data,state_data_storage,size_bytes,
        created_at,verification_status,verified_at)
       VALUES ($1,$2,'scheduled','full',$3::jsonb,'inline',123,$4,'verified',$5)`,
      [
        healthyId,
        healthyAgent,
        JSON.stringify(encrypted),
        CREATED,
        new Date(CREATED.getTime() + 1000),
      ],
    );
    const now = new Date("2026-01-02T00:00:00Z");
    const config = {
      enabled: true,
      batchSize: 1,
      reVerifyIntervalMs: 1,
      escalationThresholdPct: 50,
      minSystemicSample: 5,
      maxDecryptBytesPerCycle: 1024 * 1024,
      erroredAlertStreak: 3,
    };
    const first = await runBackupVerificationCycle({
      config,
      now: () => now,
      alert: async () => {},
    });
    expect(first.sampled).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.failures[0].backupId).toBe(damagedId);
    const second = await runBackupVerificationCycle({
      config,
      now: () => now,
      alert: async () => {},
    });
    expect(second.sampled).toBe(1);
    expect(second.verified).toBe(1);
    expect((await verification(healthyId)).verified_at.getTime()).toBe(now.getTime());
    const unchanged = await client.query(
      `SELECT verification_status,verified_at::text,recovery_expires_at::text,
       verification_error FROM agent_sandbox_backups WHERE id=$1`,
      [damagedId],
    );
    expect(unchanged.rows).toEqual(historical.rows);
    const wrapped = await runBackupVerificationCycle({
      config,
      now: () => now,
      alert: async () => {},
    });
    expect(wrapped.failed).toBe(1);
    expect(wrapped.failures[0].backupId).toBe(damagedId);
  });
});

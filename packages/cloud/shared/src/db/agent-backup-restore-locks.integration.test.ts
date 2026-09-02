/** Real-PostgreSQL proofs for restore clock and catalogue lock ordering. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  type AgentBackupManifestV3Draft,
  type AgentBackupRestoreV3SourceAuthority,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupRestoreV3SourceAuthority,
  computeAgentBackupChunkAadDigest,
  createAgentBackupManifestV3,
} from "@elizaos/shared";
import { pushSchema } from "drizzle-kit/api";
import { eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
  buildRestoreVolumeVaultSeedReceiptV1,
} from "../lib/services/agent-backup-restore-vault-seed";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { installAgentNodeOccurrenceTriggerForTests } from "./agent-node-occurrence-test-support";
import type { AgentBackupRestoreLeaseAuthorityReceipt } from "./repositories/agent-backup-restore-lease";
import {
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "./schemas/agent-backup-admission";
import {
  agentBackupCatalogAuthorities,
  agentBackupObjects,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "./schemas/agent-backup-catalog";
import {
  agentActivationPublications,
  agentBackupRestoreReceipts,
  agentNodeIncarnationHistories,
  agentVaultKeySeedReceipts,
} from "./schemas/agent-backup-restore-history";
import { agentSandboxReplacementAttempts } from "./schemas/agent-sandbox-replacement-attempts";
import { agentSandboxBackups, agentSandboxes } from "./schemas/agent-sandboxes";
import {
  agentVaultKeyAuthorities,
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "./schemas/agent-vault-key-authority";
import { dockerNodes } from "./schemas/docker-nodes";
import { organizations } from "./schemas/organizations";
import { userCharacters } from "./schemas/user-characters";
import { users } from "./schemas/users";

const SKIP_REASON =
  "[restore authority locks] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  MOCK_REDIS: process.env.MOCK_REDIS,
};
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const RESTORE_MIGRATIONS = [
  "0237_agent_restore_authority_prerequisites",
  "0238_agent_backup_restore_lease_core",
  "0239_agent_backup_restore_lease_authority",
  "0240_agent_vault_key_generations",
  "0241_agent_vault_key_current_authority",
  "0242_agent_vault_key_backup_bindings",
  "0243_agent_backup_catalog_authority_guard",
  "0244_agent_backup_restore_lease_guard",
  "0245_agent_vault_key_topology_guard",
].map((name) => readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8"));
const EXACT_FINAL_REPLACEMENT_GUARD_SQL = readFileSync(
  join(MIGRATIONS_DIR, "0371_agent_vault_key_seed_receipts_per_replacement.sql"),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(
    (statement) =>
      statement.startsWith(
        'CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_receipt_exact_replacement"',
      ) ||
      statement.startsWith(
        'CREATE TRIGGER "agent_backup_restore_receipts_guard_exact_replacement"',
      ),
  );
if (EXACT_FINAL_REPLACEMENT_GUARD_SQL.length !== 2) {
  throw new Error("0371 exact final replacement guard fixture is incomplete");
}
const RESTORE_V3_CANDIDATE_MIGRATIONS = [
  "0373_agent_backup_restore_v3_candidates",
  "0374_agent_backup_restore_v3_candidate_guards",
].map((name) => readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8"));

const ORG_ID = "00000000-0000-4000-8000-00000000b101";
const USER_ID = "00000000-0000-4000-8000-00000000b102";
const AGENT_ID = "00000000-0000-4000-8000-00000000b103";
const OPERATION_ID = "00000000-0000-4000-8000-00000000b104";
const SCHEDULER_REPLAY_OPERATION_ID = "00000000-0000-4000-8000-00000000b108";
const EXPIRATION_OPERATION_ID = "00000000-0000-4000-8000-00000000b10a";
const EXPIRATION_VAULT_GENERATION_ID = "00000000-0000-4000-8000-00000000b10b";
const EXPIRATION_KEY_BUNDLE_GENERATION_ID = "00000000-0000-4000-8000-00000000b10c";
const EXPIRATION_SANITY_ATTEMPT_ID = "00000000-0000-4000-8000-00000000b10d";
const EXPIRATION_SANITY_FENCE = "00000000-0000-4000-8000-00000000b10e";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000b105";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000b106";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000b107";
const SOURCE_CONTAINER_ID = "f".repeat(64);
const SHA = "a".repeat(64);

const CLOCK_ORG_ID = "00000000-0000-4000-8000-00000000b201";
const CLOCK_AGENT_ID = "00000000-0000-4000-8000-00000000b202";
const CLOCK_BACKUP_ID = "00000000-0000-4000-8000-00000000b203";
const CLOCK_OPERATION_ID = "00000000-0000-4000-8000-00000000b204";
const CLOCK_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000b205";
const CLOCK_VAULT_GENERATION = "00000000-0000-4000-8000-00000000b206";
const CLOCK_ATTEMPT_ID = "00000000-0000-4000-8000-00000000b207";
const CLOCK_LEASE_ID = "00000000-0000-4000-8000-00000000b208";
const CLOCK_FENCE = "00000000-0000-4000-8000-00000000b209";
const RECEIPT_SHA = "b".repeat(64);

const WRITER_BACKUP_ID = "00000000-0000-4000-8000-00000000b301";
const WRITER_OPERATION_ID = "00000000-0000-4000-8000-00000000b302";
const WRITER_RESTORE_OPERATION_ROW_ID = "00000000-0000-4000-8000-00000000b303";
const WRITER_LEASE_ID = "00000000-0000-4000-8000-00000000b304";
const WRITER_FENCE = "00000000-0000-4000-8000-00000000b305";
const WRITER_SEED_ID = "00000000-0000-4000-8000-00000000b306";
const WRITER_PUBLICATION_ID = "00000000-0000-4000-8000-00000000b307";
const WRITER_FINAL_ID = "00000000-0000-4000-8000-00000000b308";
const WRITER_TARGET_GENERATION = "00000000-0000-4000-8000-00000000b309";
const WRITER_ATTEMPT_ID = WRITER_TARGET_GENERATION;
const WRITER_REPLACEMENT_ATTEMPT_ID = "00000000-0000-4000-8000-00000000b30c";
const WRITER_MISMATCH_FINAL_ID = "00000000-0000-4000-8000-00000000b30d";
const WRITER_MISMATCH_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000b30e";
const WRITER_MISMATCH_NODE_INCARNATION = "00000000-0000-4000-8000-00000000b30f";
const WRITER_VAULT_GENERATION = "00000000-0000-4000-8000-00000000b30a";
const WRITER_RESERVE_ONE = "00000000-0000-4000-8000-00000000b30b";
const WRITER_SEED_DIGEST = buildRestoreVolumeVaultSeedReceiptV1({
  agentId: AGENT_ID,
  restoreAttemptId: WRITER_ATTEMPT_ID,
  replacementAttemptId: WRITER_REPLACEMENT_ATTEMPT_ID,
  passphraseByteLength: AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
}).receiptDigest;

const LOCK_BACKUP_ONE = "00000000-0000-4000-8000-00000000b401";
const LOCK_BACKUP_TWO = "00000000-0000-4000-8000-00000000b402";
const LOCK_OPERATION_ONE = "00000000-0000-4000-8000-00000000b403";
const LOCK_OPERATION_TWO = "00000000-0000-4000-8000-00000000b404";
const LOCK_ATTEMPT_ID = "00000000-0000-4000-8000-00000000b405";
const LOCK_LEASE_ID = "00000000-0000-4000-8000-00000000b406";
const LOCK_FENCE = "00000000-0000-4000-8000-00000000b407";
const LOCK_VAULT_GENERATION = "00000000-0000-4000-8000-00000000b408";
const LOCK_KEY_BUNDLE_GENERATION = "00000000-0000-4000-8000-00000000b409";
const LOCK_TARGET_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000b40a";
const LOCK_TARGET_NODE_INCARNATION = "00000000-0000-4000-8000-00000000b40b";
const LOCK_OWNER_ID = "restore-lock-order-owner";
const LOCK_KEY_BUNDLE = Buffer.alloc(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes, 0x55);
const LOCK_KEY_BUNDLE_SHA = createHash("sha256").update(LOCK_KEY_BUNDLE).digest("hex");

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let sourceNodeHistoryId: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("./client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("./client").dbWrite | undefined;
let reserveAgentBackupOperation:
  | typeof import("./repositories/agent-backup-catalog").reserveAgentBackupOperation
  | undefined;
let lockAgentBackupReservationReplayInTransaction:
  | typeof import("./repositories/agent-backup-catalog").lockAgentBackupReservationReplayInTransaction
  | undefined;
let transitionAgentBackupOperation:
  | typeof import("./repositories/agent-backup-catalog").transitionAgentBackupOperation
  | undefined;
let acquireAgentBackupRestoreLease:
  | typeof import("./repositories/agent-backup-restore-lease").acquireAgentBackupRestoreLease
  | undefined;
let releaseAgentBackupRestoreLease:
  | typeof import("./repositories/agent-backup-restore-lease").releaseAgentBackupRestoreLease
  | undefined;
let agentBackupObjectInventoryDigest:
  | typeof import("./repositories/agent-backup-catalog").agentBackupObjectInventoryDigest
  | undefined;
let recordAgentActivationPublication:
  | typeof import("./repositories/agent-backup-restore-history").recordAgentActivationPublication
  | undefined;
let recordAgentVaultKeySeedReceipt:
  | typeof import("./repositories/agent-backup-restore-history").recordAgentVaultKeySeedReceipt
  | undefined;
let commitAgentBackupRestore:
  | typeof import("./repositories/agent-backup-restore-history").commitAgentBackupRestore
  | undefined;
let openAgentBackupRestoreOperation:
  | typeof import("./repositories/agent-backup-restore-operations").openAgentBackupRestoreOperation
  | undefined;
let claimAgentBackupRestoreOperation:
  | typeof import("./repositories/agent-backup-restore-operations").claimAgentBackupRestoreOperation
  | undefined;
let reserveAgentBackupRestoreTarget:
  | typeof import("./repositories/agent-backup-restore-operations").reserveAgentBackupRestoreTarget
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function expectPostgresFailure(operation: Promise<unknown>, expected: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  const details: string[] = [];
  let current = failure;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error) details.push(current.message);
    if (typeof current !== "object") break;
    const record = current as { cause?: unknown; constraint?: unknown };
    if (typeof record.constraint === "string") details.push(record.constraint);
    current = record.cause;
  }
  expect(details.join("\n")).toMatch(expected);
}

async function createIsolatedDatabase(baseDsn: string): Promise<{ name: string; dsn: string }> {
  const name = `eliza_restore_locks_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${name}`;
  return { name, dsn: url.toString() };
}

async function dropIsolatedDatabase(baseDsn: string, name: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}

async function waitUntilBlockedBy(observer: Client, blockedByPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'active'
         AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [blockedByPid],
    );
    const pid = result.rows[0]?.pid;
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a blocked restore-authority backend");
}

async function waitUntilAdvisoryBlockedBy(
  observer: Client,
  blockedByPid: number,
): Promise<{ pid: number; wait_event_type: string; wait_event: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      pid: number;
      wait_event_type: string;
      wait_event: string;
    }>(
      `SELECT pid, wait_event_type, wait_event FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'active'
         AND wait_event_type = 'Lock' AND wait_event = 'advisory'
         AND $1 = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [blockedByPid],
    );
    const blocked = result.rows[0];
    if (blocked) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the restore-v3 advisory attempt fence");
}

async function waitForLeaseExpiry(observer: Client, leaseId = CLOCK_LEASE_ID): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ expired: boolean }>(
      "SELECT expires_at <= clock_timestamp() AS expired " +
        "FROM agent_backup_restore_leases WHERE id = $1",
      [leaseId],
    );
    if (result.rows[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the restore lease to expire");
}

async function waitUntilDatabaseTime(observer: Client, threshold: Date): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ reached: boolean }>(
      "SELECT clock_timestamp() >= $1::timestamptz AS reached",
      [threshold.toISOString()],
    );
    if (result.rows[0]?.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the primary database clock");
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function createRestoreV3CandidatePrerequisiteTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE agent_backup_catalog_authorities (
      organization_id uuid NOT NULL REFERENCES organizations(id), agent_id uuid NOT NULL,
      catalog_revision bigint NOT NULL, restore_generation bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, agent_id)
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY, catalog_organization_id uuid NOT NULL,
      catalog_agent_id uuid NOT NULL, backup_operation_id uuid NOT NULL,
      lifecycle_generation uuid NOT NULL, lifecycle_revision numeric(20, 0) NOT NULL,
      manifest_digest text NOT NULL, operation_key_bundle_generation_id uuid NOT NULL,
      catalog_state text NOT NULL, manifest_version integer NOT NULL
    );
    CREATE TABLE agent_backup_objects (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, backup_id uuid NOT NULL,
      copy_role text NOT NULL, component text NOT NULL, chunk_index integer NOT NULL,
      state text NOT NULL, provider_write_started boolean NOT NULL, verified_at timestamptz,
      content_hmac_sha256 text NOT NULL, transport text NOT NULL, provider text NOT NULL,
      endpoint_identity_fingerprint text NOT NULL, endpoint_alias text NOT NULL,
      bucket text NOT NULL, region text NOT NULL, key_fingerprint text NOT NULL,
      provider_version_id text, provider_etag text, provider_checksum text,
      upload_receipt_digest text, ciphertext_sha256 text NOT NULL, size_bytes bigint NOT NULL
    );
    CREATE TABLE agent_backup_restore_leases (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      backup_id uuid NOT NULL, restore_attempt_id uuid NOT NULL, owner_id text NOT NULL,
      generation uuid NOT NULL, catalog_epoch bigint NOT NULL, copy_role text NOT NULL,
      operation_id uuid NOT NULL, activation_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL, expected_manifest_sha256 text NOT NULL,
      expires_at timestamptz NOT NULL, released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_backup_restore_leases_operation_authority_unique UNIQUE (
        id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
        generation, catalog_epoch, copy_role, operation_id, activation_generation,
        lifecycle_revision, expected_manifest_sha256)
    );
    CREATE TABLE agent_backup_restore_operations (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      backup_id uuid NOT NULL, restore_attempt_id uuid NOT NULL, lease_id uuid NOT NULL,
      lease_owner_id text NOT NULL, lease_generation uuid NOT NULL, catalog_epoch bigint NOT NULL,
      copy_role text NOT NULL, expected_operation_id uuid NOT NULL,
      expected_activation_generation uuid NOT NULL,
      expected_lifecycle_revision numeric(20, 0) NOT NULL,
      expected_manifest_sha256 text NOT NULL, phase text NOT NULL
    );
  `);
}

async function buildLockManifest(
  operationId: string,
  vaultKeyGenerationId = LOCK_VAULT_GENERATION,
): Promise<{
  canonicalDraft: string;
  digest: string;
}> {
  const emptyComponent = (name: "character" | "media" | "state-files" | "vault") => ({
    name,
    format: "raw-v1",
    compression: "none" as const,
    payloadContentHmacSha256: SHA,
    state: { kind: "full" as const, resultContentHmacSha256: SHA },
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    chunks: [],
  });
  const plainBytes = 4;
  const encryptedBytes = 32;
  const aadSha256 = await computeAgentBackupChunkAadDigest({
    identity: {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "0",
    },
    operationId,
    component: { name: "database", format: "raw-v1", compression: "none" },
    chunk: {
      index: 0,
      offsetBytes: 0,
      plainBytes,
      compressedBytes: plainBytes,
      contentHmacSha256: SHA,
    },
  });
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 3,
    operationId,
    createdAt: "2026-08-20T00:00:00.000Z",
    identity: {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "0",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: NODE_INCARNATION,
      nodeId: "robot-node-lock",
      containerId: SOURCE_CONTAINER_ID,
    },
    runtime: {
      imageDigest: `sha256:${SHA}`,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
    components: [
      emptyComponent("character"),
      {
        name: "database",
        format: "raw-v1",
        compression: "none",
        payloadContentHmacSha256: SHA,
        state: { kind: "full", resultContentHmacSha256: SHA },
        totals: {
          plainBytes,
          compressedBytes: plainBytes,
          encryptedBytes,
          chunkCount: 1,
        },
        chunks: [
          {
            index: 0,
            offsetBytes: 0,
            plainBytes,
            compressedBytes: plainBytes,
            encryptedBytes,
            contentHmacSha256: SHA,
            aadSha256,
            sha256: SHA,
          },
        ],
      },
      emptyComponent("media"),
      emptyComponent("state-files"),
      emptyComponent("vault"),
    ],
    watermarks: [{ namespace: "database.lsn", value: "0/1" }],
    totals: {
      plainBytes,
      compressedBytes: plainBytes,
      encryptedBytes,
      chunkCount: 1,
    },
    vaultKeyAuthority: {
      format: "kms-aead-vault-passphrase-v1",
      generationId: vaultKeyGenerationId,
      receiptDerivation: "elizaos.agent-vault-key.authority-receipt.v1",
      receiptDigest: RECEIPT_SHA,
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
      kms: { provider: "steward", keyId: `org:${ORG_ID}/dek/v1`, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: LOCK_KEY_BUNDLE_GENERATION,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${operationId}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: LOCK_KEY_BUNDLE_SHA,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: SHA,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: SHA,
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "operation",
        derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
        keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        keyOffsetBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
        keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
      },
    },
  };
  const manifest = await createAgentBackupManifestV3(draft);
  return {
    canonicalDraft: canonicalizeAgentBackupManifestV3(draft),
    digest: manifest.integrity.manifestSha256,
  };
}

async function seedLockBackup(input: {
  backupId: string;
  operationId: string;
  manifest: Awaited<ReturnType<typeof buildLockManifest>>;
  catalogRevision: bigint;
  objectInventoryDigest: string;
}): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  await dbWrite.insert(agentSandboxBackups).values({
    id: input.backupId,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: LOCK_KEY_BUNDLE.byteLength,
    backup_kind: "full",
    backup_operation_id: input.operationId,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: SHA,
    catalog_revision: input.catalogRevision,
    catalog_organization_id: ORG_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 0n,
    source_provider: "operator-onboarded",
    source_node_record_id: NODE_RECORD_ID,
    source_node_id: "robot-node-lock",
    source_node_incarnation: NODE_INCARNATION,
    source_provider_server_id: null,
    source_provider_handle: "container-generation-lock",
    source_container_id: SOURCE_CONTAINER_ID,
    retention_reason: "schedule",
    retention_until: new Date(Date.now() + 86_400_000),
    manifest_format: AGENT_BACKUP_MANIFEST_FORMAT,
    manifest_version: 3,
    manifest_digest: input.manifest.digest,
    manifest_canonical_draft: input.manifest.canonicalDraft,
    manifest_object_count: 1,
    object_inventory_digest: input.objectInventoryDigest,
    image_digest: `sha256:${SHA}`,
    database_schema_version: "1",
    plugin_set_digest: SHA,
    watermark_digest: SHA,
    raw_size_bytes: 4,
    compressed_size_bytes: 4,
    encrypted_size_bytes: 32,
    kms_key_id: `org:${ORG_ID}/backup/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: LOCK_KEY_BUNDLE_GENERATION,
    operation_key_bundle_format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
    operation_key_bundle_ref: `backup-key-bundle:${input.operationId}`,
    operation_key_bundle_ciphertext_base64: LOCK_KEY_BUNDLE.toString("base64"),
    operation_key_bundle_sha256: LOCK_KEY_BUNDLE_SHA,
    operation_key_bundle_size_bytes: LOCK_KEY_BUNDLE.byteLength,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
    operation_key_bundle_local_receipt_derivation:
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
    operation_key_bundle_local_receipt_digest: SHA,
    vault_key_generation_id: LOCK_VAULT_GENERATION,
    vault_key_authority_receipt_digest: RECEIPT_SHA,
  });
  await dbWrite.insert(agentVaultKeyBackupBindings).values({
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    backup_id: input.backupId,
    operation_id: input.operationId,
    source_activation_generation: ACTIVATION_GENERATION,
    source_lifecycle_revision: 0n,
    manifest_sha256: input.manifest.digest,
    vault_key_generation_id: LOCK_VAULT_GENERATION,
    vault_key_authority_receipt_digest: RECEIPT_SHA,
  });
}

async function seedRestoreOperationLockFixture(includeSecondBackup = false): Promise<{
  operationId: string;
  authority: AgentBackupRestoreLeaseAuthorityReceipt;
}> {
  const open = openAgentBackupRestoreOperation;
  const acquire = acquireAgentBackupRestoreLease;
  const inventoryDigest = agentBackupObjectInventoryDigest;
  if (!dbWrite || !open || !acquire || !inventoryDigest) {
    throw new Error("real PostgreSQL harness was not initialized");
  }
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: ORG_ID, agent_id: AGENT_ID })
    .onConflictDoNothing();
  const [catalog] = await dbWrite
    .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
    .from(agentBackupCatalogAuthorities)
    .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
  if (!catalog) throw new Error("restore lock fixture catalogue authority is missing");
  await dbWrite
    .insert(agentVaultKeyGenerations)
    .values({
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      generation_id: LOCK_VAULT_GENERATION,
      source_activation_generation: ACTIVATION_GENERATION,
      supersedes_generation_id: null,
      format: "kms-aead-vault-passphrase-v1",
      kms_key_id: `org:${ORG_ID}/lock-order/dek/v1`,
      kms_key_version: 1n,
      kms_context: "{}",
      kms_context_derivation: "elizaos.agent-vault-key.kms-context.v1",
      wrapped_ciphertext_base64: Buffer.alloc(32, 0x11).toString("base64"),
      wrapped_nonce_base64: Buffer.alloc(12, 0x22).toString("base64"),
      wrapped_auth_tag_base64: Buffer.alloc(16, 0x33).toString("base64"),
      wrapped_envelope_sha256: SHA,
      authority_receipt_derivation: "elizaos.agent-vault-key.authority-receipt.v1",
      authority_receipt_digest: RECEIPT_SHA,
    })
    .onConflictDoNothing();
  const firstManifest = await buildLockManifest(LOCK_OPERATION_ONE);
  const exactObjectInventoryDigest = await inventoryDigest([
    {
      component: "database",
      chunkIndex: 0,
      contentHmacSha256: SHA,
      ciphertextSha256: SHA,
      sizeBytes: 32,
    },
  ]);
  await seedLockBackup({
    backupId: LOCK_BACKUP_ONE,
    operationId: LOCK_OPERATION_ONE,
    manifest: firstManifest,
    catalogRevision: catalog.revision,
    objectInventoryDigest: exactObjectInventoryDigest,
  });
  if (includeSecondBackup) {
    await seedLockBackup({
      backupId: LOCK_BACKUP_TWO,
      operationId: LOCK_OPERATION_TWO,
      manifest: await buildLockManifest(LOCK_OPERATION_TWO),
      catalogRevision: catalog.revision,
      objectInventoryDigest: exactObjectInventoryDigest,
    });
  }
  await dbWrite.insert(agentBackupRestoreLeases).values({
    id: LOCK_LEASE_ID,
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    backup_id: LOCK_BACKUP_ONE,
    operation_id: LOCK_OPERATION_ONE,
    activation_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 0n,
    expected_manifest_sha256: firstManifest.digest,
    copy_role: "primary",
    restore_attempt_id: LOCK_ATTEMPT_ID,
    owner_id: LOCK_OWNER_ID,
    generation: LOCK_FENCE,
    catalog_epoch: catalog.revision,
    expires_at: new Date(Date.now() + 300_000),
  });
  const acquired = await acquire({
    organizationId: ORG_ID,
    backupId: LOCK_BACKUP_ONE,
    operationId: LOCK_OPERATION_ONE,
    sourceActivationGeneration: ACTIVATION_GENERATION,
    sourceLifecycleRevision: "0",
    expectedManifestSha256: firstManifest.digest,
    restoreAttemptId: LOCK_ATTEMPT_ID,
    ownerId: LOCK_OWNER_ID,
    fencingToken: LOCK_FENCE,
    copyRole: "primary",
    leaseMs: 300_000,
  });
  const authority = acquired.authority;
  const opened = await open({ authority, leaseId: LOCK_LEASE_ID });
  return { operationId: opened.operation.id, authority };
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.name;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  process.env.MOCK_REDIS = "1";
  const [clientModule, repositoryModule, leaseModule, restoreHistoryModule, operationsModule] =
    await Promise.all([
      import("./client"),
      import("./repositories/agent-backup-catalog"),
      import("./repositories/agent-backup-restore-lease"),
      import("./repositories/agent-backup-restore-history"),
      import("./repositories/agent-backup-restore-operations"),
    ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  reserveAgentBackupOperation = repositoryModule.reserveAgentBackupOperation;
  lockAgentBackupReservationReplayInTransaction =
    repositoryModule.lockAgentBackupReservationReplayInTransaction;
  transitionAgentBackupOperation = repositoryModule.transitionAgentBackupOperation;
  agentBackupObjectInventoryDigest = repositoryModule.agentBackupObjectInventoryDigest;
  acquireAgentBackupRestoreLease = leaseModule.acquireAgentBackupRestoreLease;
  releaseAgentBackupRestoreLease = leaseModule.releaseAgentBackupRestoreLease;
  recordAgentActivationPublication = restoreHistoryModule.recordAgentActivationPublication;
  recordAgentVaultKeySeedReceipt = restoreHistoryModule.recordAgentVaultKeySeedReceipt;
  commitAgentBackupRestore = restoreHistoryModule.commitAgentBackupRestore;
  openAgentBackupRestoreOperation = operationsModule.openAgentBackupRestoreOperation;
  claimAgentBackupRestoreOperation = operationsModule.claimAgentBackupRestoreOperation;
  reserveAgentBackupRestoreTarget = operationsModule.reserveAgentBackupRestoreTarget;
}

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && isolatedDatabaseName) {
    await dropIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("restore authority PostgreSQL lock proofs", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("isolated database was not initialized");
    const schemaDatabase = dbWrite;
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentNodeIncarnationHistories,
        agentBackupOrganizationAdmissionCursors,
        agentBackupNodeAdmissionCursors,
        dockerNodes,
        agentSandboxes,
        agentBackupCatalogAuthorities,
        agentSandboxBackups,
        agentBackupObjects,
        agentBackupRestoreLeases,
        agentBackupRestoreOperations,
        agentSandboxReplacementAttempts,
        agentActivationPublications,
        agentVaultKeySeedReceipts,
        agentBackupRestoreReceipts,
        agentVaultKeyGenerations,
        agentVaultKeyAuthorities,
        agentVaultKeyBackupBindings,
      } as never,
      schemaDatabase as never,
    );
    await apply();
    for (const statement of EXACT_FINAL_REPLACEMENT_GUARD_SQL) {
      await schemaDatabase.execute(sql.raw(statement));
    }
    await installAgentNodeOccurrenceTriggerForTests((statement) =>
      schemaDatabase.execute(sql.raw(statement)),
    );
    await dbWrite.insert(organizations).values({
      id: ORG_ID,
      name: "Restore Lock Org",
      slug: "restore-lock-org",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      steward_user_id: "restore-lock-user",
      organization_id: ORG_ID,
    });
    const [sourceNode] = await dbWrite
      .insert(dockerNodes)
      .values({
        id: NODE_RECORD_ID,
        node_id: "robot-node-lock",
        hostname: "robot-node-lock.example.test",
        host_key_fingerprint: "sha256:restore-lock-host-key",
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        node_incarnation: NODE_INCARNATION,
        metadata: { architecture: "amd64" },
        status: "healthy",
        enabled: true,
      })
      .returning({ historyId: dockerNodes.current_node_history_id });
    sourceNodeHistoryId = sourceNode?.historyId ?? null;
    if (!sourceNodeHistoryId) throw new Error("source node occurrence token fixture is missing");
    await dbWrite.insert(agentSandboxes).values({
      id: AGENT_ID,
      organization_id: ORG_ID,
      user_id: USER_ID,
      agent_name: "Restore Lock Agent",
      status: "running",
      sandbox_id: "container-generation-lock",
      node_id: "robot-node-lock",
      image_digest: `sha256:${SHA}`,
      lifecycle_revision: 0,
      activation_generation: ACTIVATION_GENERATION,
      activation_lifecycle_revision: 0n,
      activation_purpose: "provision",
      activation_phase: "active",
      activation_receipt: {
        schemaVersion: 1,
        generation: ACTIVATION_GENERATION,
        purpose: "provision",
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        lifecycleRevision: "0",
        backupId: null,
        backupHash: null,
        manifestHash: null,
        componentHashes: null,
        freshAuthorization: null,
        containerId: SOURCE_CONTAINER_ID,
        imageDigest: `sha256:${SHA}`,
        receiptId: CLOCK_ATTEMPT_ID,
        receiptHash: SHA,
        receiptMac: SHA,
        appliedAt: "2026-08-17T00:00:02.000Z",
        restored: true,
        requiresRestart: false,
      },
      activation_receipt_hash: SHA,
      activation_container_id: SOURCE_CONTAINER_ID,
      activation_node_id: "robot-node-lock",
      activation_image_digest: `sha256:${SHA}`,
      activation_token_hash: SHA,
      activation_token_ciphertext: "sealed-token",
      activation_boot_id: NODE_INCARNATION,
      activation_funding_revision: 0n,
      activation_authority_published_at: new Date("2026-08-17T00:00:00.000Z"),
      activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
      activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
    });
  }, 60_000);

  afterEach(async () => {
    if (!dbWrite) return;
    await dbWrite
      .delete(agentBackupRestoreOperations)
      .where(
        inArray(agentBackupRestoreOperations.restore_attempt_id, [
          LOCK_ATTEMPT_ID,
          WRITER_ATTEMPT_ID,
        ]),
      );
    await dbWrite
      .update(agentSandboxes)
      .set({
        lifecycle_revision: 0,
        activation_generation: ACTIVATION_GENERATION,
        activation_previous_generation: null,
        activation_lifecycle_revision: 0n,
        activation_purpose: "provision",
        activation_phase: "active",
        activation_backup_id: null,
        activation_backup_hash: null,
        activation_receipt: {
          schemaVersion: 1,
          generation: ACTIVATION_GENERATION,
          purpose: "provision",
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          lifecycleRevision: "0",
          backupId: null,
          backupHash: null,
          manifestHash: null,
          componentHashes: null,
          freshAuthorization: null,
          containerId: SOURCE_CONTAINER_ID,
          imageDigest: `sha256:${SHA}`,
          receiptId: CLOCK_ATTEMPT_ID,
          receiptHash: SHA,
          receiptMac: SHA,
          appliedAt: "2026-08-17T00:00:02.000Z",
          restored: true,
          requiresRestart: false,
        },
        activation_receipt_hash: SHA,
        activation_container_id: SOURCE_CONTAINER_ID,
        activation_node_id: "robot-node-lock",
        activation_boot_id: NODE_INCARNATION,
        activation_image_digest: `sha256:${SHA}`,
        activation_token_hash: SHA,
        activation_token_ciphertext: "sealed-token",
        activation_authority_published_at: new Date("2026-08-17T00:00:00.000Z"),
        activation_funding_revision: 0n,
        activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
        activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
        activation_consent_lifecycle_revision: null,
        activation_consent_head_backup_id: null,
        activation_consent_head_backup_hash: null,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await dbWrite
      .delete(agentBackupRestoreReceipts)
      .where(eq(agentBackupRestoreReceipts.id, WRITER_FINAL_ID));
    await dbWrite
      .delete(agentVaultKeySeedReceipts)
      .where(eq(agentVaultKeySeedReceipts.id, WRITER_SEED_ID));
    await dbWrite
      .delete(agentSandboxReplacementAttempts)
      .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));
    await dbWrite
      .delete(agentActivationPublications)
      .where(eq(agentActivationPublications.id, WRITER_PUBLICATION_ID));
    await dbWrite
      .delete(agentBackupRestoreLeases)
      .where(inArray(agentBackupRestoreLeases.id, [WRITER_LEASE_ID, LOCK_LEASE_ID]));
    await dbWrite
      .delete(agentVaultKeyBackupBindings)
      .where(
        inArray(agentVaultKeyBackupBindings.backup_id, [
          WRITER_BACKUP_ID,
          LOCK_BACKUP_ONE,
          LOCK_BACKUP_TWO,
        ]),
      );
    await dbWrite
      .delete(agentSandboxBackups)
      .where(
        inArray(agentSandboxBackups.backup_operation_id, [
          WRITER_OPERATION_ID,
          WRITER_RESERVE_ONE,
          LOCK_OPERATION_ONE,
          LOCK_OPERATION_TWO,
        ]),
      );
    await dbWrite
      .delete(agentVaultKeyAuthorities)
      .where(eq(agentVaultKeyAuthorities.current_generation_id, WRITER_VAULT_GENERATION));
    await dbWrite
      .delete(agentVaultKeyGenerations)
      .where(
        inArray(agentVaultKeyGenerations.generation_id, [
          WRITER_VAULT_GENERATION,
          LOCK_VAULT_GENERATION,
        ]),
      );
    await dbWrite.delete(agentBackupNodeAdmissionCursors);
    await dbWrite.delete(agentBackupOrganizationAdmissionCursors);
    await dbWrite.delete(dockerNodes).where(eq(dockerNodes.id, LOCK_TARGET_NODE_RECORD_ID));
    await dbWrite
      .delete(agentNodeIncarnationHistories)
      .where(eq(agentNodeIncarnationHistories.docker_node_record_id, LOCK_TARGET_NODE_RECORD_ID));
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
  });

  test("reservation replay and actual restore acquisition share backup-before-authority order", async () => {
    const reserve = reserveAgentBackupOperation;
    const acquire = acquireAgentBackupRestoreLease;
    if (!isolatedDsn || !dbWrite || !reserve || !acquire) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const input = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      sandboxRecordId: AGENT_ID,
      operationId: OPERATION_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "0",
      snapshotType: "auto" as const,
      backupKind: "full" as const,
      sourceProvider: "operator-onboarded" as const,
      sourceNodeRecordId: NODE_RECORD_ID,
      sourceNodeId: "robot-node-lock",
      sourceNodeIncarnation: NODE_INCARNATION,
      sourceProviderServerId: null,
      sourceProviderHandle: "container-generation-lock",
      sourceContainerId: SOURCE_CONTAINER_ID,
      retentionReason: "schedule" as const,
      retentionUntil: new Date("2026-09-17T00:00:00.000Z"),
    };
    const first = await reserve(input);
    // A legacy row may carry a digest without satisfying v3 restore authority.
    // That lets the real acquisition reach both locks, then fail closed.
    await dbWrite
      .update(agentSandboxBackups)
      .set({ catalog_version: 1, catalog_state: "legacy_unmigrated", manifest_digest: SHA })
      .where(eq(agentSandboxBackups.id, first.id));
    const authorityBlocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([authorityBlocker.connect(), observer.connect()]);
    let replayOutcome: { id: string } | undefined;
    let replayError: unknown;
    let replay: Promise<void> | undefined;
    let acquisitionError: unknown;
    let acquisition: Promise<void> | undefined;
    try {
      await authorityBlocker.query("BEGIN");
      const blockerPid = await authorityBlocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await authorityBlocker.query(
        "SELECT organization_id FROM agent_backup_catalog_authorities " +
          "WHERE organization_id = $1 AND agent_id = $2 FOR UPDATE",
        [ORG_ID, AGENT_ID],
      );
      replay = reserve(input).then(
        (value) => {
          replayOutcome = value;
        },
        (error: unknown) => {
          replayError = error;
        },
      );
      const replayPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
      acquisition = acquire({
        organizationId: ORG_ID,
        backupId: first.id,
        operationId: OPERATION_ID,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        sourceLifecycleRevision: "0",
        expectedManifestSha256: SHA,
        copyRole: "primary",
        restoreAttemptId: CLOCK_ATTEMPT_ID,
        ownerId: "restore-lock-test-owner",
        fencingToken: CLOCK_FENCE,
        leaseMs: 60_000,
      }).then(
        () => undefined,
        (error: unknown) => {
          acquisitionError = error;
        },
      );
      await waitUntilBlockedBy(observer, replayPid);
      await authorityBlocker.query("COMMIT");
      await Promise.all([replay, acquisition]);
      if (replayError) throw replayError;
      expect(replayOutcome?.id).toBe(first.id);
      expect(String(acquisitionError)).toContain("Backup is not in a restorable catalogue state");
    } finally {
      await authorityBlocker.query("ROLLBACK");
      if (replay) await replay;
      if (acquisition) await acquisition;
      await Promise.allSettled([authorityBlocker.end(), observer.end()]);
    }
  }, 30_000);

  test("scheduler replay first-lock leaves the sandbox available to a capture holder", async () => {
    const reserve = reserveAgentBackupOperation;
    const lockReplay = lockAgentBackupReservationReplayInTransaction;
    if (!isolatedDsn || !dbWrite || !reserve || !lockReplay) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const input = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      sandboxRecordId: AGENT_ID,
      operationId: SCHEDULER_REPLAY_OPERATION_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "0",
      snapshotType: "auto" as const,
      backupKind: "full" as const,
      sourceProvider: "operator-onboarded" as const,
      sourceNodeRecordId: NODE_RECORD_ID,
      sourceNodeId: "robot-node-lock",
      sourceNodeIncarnation: NODE_INCARNATION,
      sourceProviderServerId: null,
      sourceProviderHandle: "container-generation-lock",
      sourceContainerId: SOURCE_CONTAINER_ID,
      retentionReason: "schedule" as const,
      retentionUntil: new Date("2026-09-18T00:00:00.000Z"),
    };
    const backup = await reserve(input);
    const capture = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([capture.connect(), observer.connect()]);
    let scheduler: Promise<void> | undefined;
    try {
      await capture.query("BEGIN");
      await capture.query("SET LOCAL lock_timeout = '1s'");
      const capturePid = await capture.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await capture.query("SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE", [
        backup.id,
      ]);
      scheduler = dbWrite.transaction(async (tx) => {
        await lockReplay(tx, input);
        await tx
          .select({ id: agentSandboxes.id })
          .from(agentSandboxes)
          .where(eq(agentSandboxes.id, AGENT_ID))
          .for("update")
          .limit(1);
      });
      await waitUntilBlockedBy(observer, capturePid.rows[0]!.pid);

      // The scheduler is blocked on the operation backup and therefore cannot
      // already hold the sandbox. A sandbox-first regression times out here or
      // forms the capture backup -> sandbox / scheduler sandbox -> backup cycle.
      const sandbox = await capture.query<{ id: string }>(
        "SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE",
        [AGENT_ID],
      );
      expect(sandbox.rows[0]?.id).toBe(AGENT_ID);
      await capture.query("COMMIT");
      await scheduler;
    } finally {
      await capture.query("ROLLBACK");
      if (scheduler) await scheduler;
      await Promise.allSettled([capture.end(), observer.end()]);
    }
  }, 30_000);

  test("operation replay waits on its lease while a claimant waits on the operation", async () => {
    const open = openAgentBackupRestoreOperation;
    const claim = claimAgentBackupRestoreOperation;
    if (!isolatedDsn || !open || !claim) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await seedRestoreOperationLockFixture();
    const blocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([blocker.connect(), observer.connect()]);
    let replayResult: Awaited<ReturnType<typeof open>> | undefined;
    let replayError: unknown;
    let replay: Promise<void> | undefined;
    let claimResult: Awaited<ReturnType<typeof claim>> | undefined;
    let claimError: unknown;
    let claiming: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM agent_backup_restore_leases WHERE id = $1 FOR UPDATE", [
        LOCK_LEASE_ID,
      ]);

      // New order: backup -> operation -> lease -> catalogue. The replay owns
      // O before it queues for L, so a claimant cannot own O and close the old
      // C/L/O cycle when the lease holder is released.
      replay = open({ authority: fixture.authority, leaseId: LOCK_LEASE_ID }).then(
        (result) => {
          replayResult = result;
        },
        (error: unknown) => {
          replayError = error;
        },
      );
      const replayPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
      claiming = claim({
        operationId: fixture.operationId,
        ownerId: LOCK_OWNER_ID,
        claimMs: 60_000,
      }).then(
        (result) => {
          claimResult = result;
        },
        (error: unknown) => {
          claimError = error;
        },
      );
      const claimPid = await waitUntilBlockedBy(observer, replayPid);
      expect(claimPid).not.toBe(replayPid);

      await blocker.query("COMMIT");
      await Promise.all([replay, claiming]);

      expect(postgresErrorCode(replayError)).not.toBe("40P01");
      expect(postgresErrorCode(claimError)).not.toBe("40P01");
      if (replayError) throw replayError;
      if (claimError) throw claimError;
      expect(replayResult?.replayed).toBe(true);
      expect(replayResult?.operation.id).toBe(fixture.operationId);
      expect(claimResult?.operation.id).toBe(fixture.operationId);
      expect(claimResult?.operation.claim_owner).toBe(LOCK_OWNER_ID);
      expect(claimResult?.operation.claim_generation).toBe(claimResult?.claimGeneration);
    } finally {
      await blocker.query("ROLLBACK");
      if (replay) await replay;
      if (claiming) await claiming;
      await Promise.allSettled([blocker.end(), observer.end()]);
    }
  }, 30_000);

  test("divergent restore-attempt replay reaches catalogue without waiting on another backup lease", async () => {
    const open = openAgentBackupRestoreOperation;
    const acquire = acquireAgentBackupRestoreLease;
    if (!isolatedDsn || !open || !acquire) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await seedRestoreOperationLockFixture(true);
    const secondManifest = await buildLockManifest(LOCK_OPERATION_TWO);
    const blocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([blocker.connect(), observer.connect()]);
    let acquisitionResult: Awaited<ReturnType<typeof acquire>> | undefined;
    let acquisitionError: unknown;
    let acquisition: Promise<void> | undefined;
    let replayResult: Awaited<ReturnType<typeof open>> | undefined;
    let replayError: unknown;
    let replay: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT organization_id FROM agent_backup_catalog_authorities " +
          "WHERE organization_id = $1 AND agent_id = $2 FOR UPDATE",
        [ORG_ID, AGENT_ID],
      );

      // Queue the divergent B2 acquisition on C first. It must not subsequently
      // wait on L1, which belongs to B1 despite sharing the restore-attempt id.
      acquisition = acquire({
        organizationId: ORG_ID,
        backupId: LOCK_BACKUP_TWO,
        operationId: LOCK_OPERATION_TWO,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        sourceLifecycleRevision: "0",
        expectedManifestSha256: secondManifest.digest,
        copyRole: "primary",
        restoreAttemptId: LOCK_ATTEMPT_ID,
        ownerId: LOCK_OWNER_ID,
        fencingToken: LOCK_FENCE,
        leaseMs: 60_000,
      }).then(
        (result) => {
          acquisitionResult = result;
        },
        (error: unknown) => {
          acquisitionError = error;
        },
      );
      const acquisitionPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);

      // The B1 replay owns L1 before it joins the C queue behind B2. With the
      // old org+attempt FOR UPDATE, B2 then waited on L1 and closed C <-> L1.
      replay = open({ authority: fixture.authority, leaseId: LOCK_LEASE_ID }).then(
        (result) => {
          replayResult = result;
        },
        (error: unknown) => {
          replayError = error;
        },
      );
      // PostgreSQL reports the earlier catalogue waiter as the replay's soft
      // blocker, rather than reporting the row holder twice. This exact queue
      // is the old cycle's first half: replay already owns L1, then waits on C
      // behind the divergent acquisition.
      const replayPid = await waitUntilBlockedBy(observer, acquisitionPid);
      expect(replayPid).not.toBe(acquisitionPid);

      await blocker.query("COMMIT");
      await Promise.all([acquisition, replay]);

      expect(postgresErrorCode(acquisitionError)).not.toBe("40P01");
      expect(postgresErrorCode(replayError)).not.toBe("40P01");
      expect(acquisitionResult).toBeUndefined();
      expect(String(acquisitionError)).toContain("Restore attempt replay authority mismatch");
      if (replayError) throw replayError;
      expect(replayResult?.replayed).toBe(true);
      expect(replayResult?.operation.id).toBe(fixture.operationId);
    } finally {
      await blocker.query("ROLLBACK");
      if (acquisition) await acquisition;
      if (replay) await replay;
      await Promise.allSettled([blocker.end(), observer.end()]);
    }
  }, 30_000);

  test("target reservation reaches catalogue only after its exact node lock", async () => {
    const claim = claimAgentBackupRestoreOperation;
    const reserveTarget = reserveAgentBackupRestoreTarget;
    if (!isolatedDsn || !dbWrite || !claim || !reserveTarget) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await seedRestoreOperationLockFixture(true);
    const [targetNode] = await dbWrite
      .insert(dockerNodes)
      .values({
        id: LOCK_TARGET_NODE_RECORD_ID,
        node_id: "restore-lock-target",
        hostname: "restore-lock-target.example.test",
        capacity: 2,
        allocated_count: 0,
        enabled: true,
        status: "healthy",
        placement_state: "open",
        host_key_fingerprint: "SHA256:restore-lock-target-host-key",
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        provider_server_id: null,
        node_incarnation: LOCK_TARGET_NODE_INCARNATION,
        metadata: { architecture: "amd64" },
      })
      .returning({ historyId: dockerNodes.current_node_history_id });
    const targetNodeHistoryId = targetNode?.historyId;
    if (!targetNodeHistoryId) throw new Error("target node occurrence token fixture is missing");
    const claimed = await claim({
      operationId: fixture.operationId,
      ownerId: LOCK_OWNER_ID,
      claimMs: 60_000,
    });
    const blocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([blocker.connect(), observer.connect()]);
    let reservationResult: Awaited<ReturnType<typeof reserveTarget>> | undefined;
    let reservationError: unknown;
    let reservation: Promise<void> | undefined;
    let blockerError: unknown;
    let blockerBackupId: string | undefined;
    let blockerCatalogRevision: string | undefined;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM docker_nodes WHERE id = $1 FOR UPDATE", [
        LOCK_TARGET_NODE_RECORD_ID,
      ]);

      reservation = reserveTarget({
        operationId: fixture.operationId,
        ownerId: LOCK_OWNER_ID,
        claimGeneration: claimed.claimGeneration,
        targetNodeRecordId: LOCK_TARGET_NODE_RECORD_ID,
        targetNodeIncarnation: LOCK_TARGET_NODE_INCARNATION,
        targetNodeHistoryId,
      }).then(
        (result) => {
          reservationResult = result;
        },
        (error: unknown) => {
          reservationError = error;
        },
      );
      await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);

      // This independent B2 writer deliberately owns N before it follows
      // B2 -> C. A reserve implementation that owns C while waiting for N
      // creates the exact C/N cycle this proof guards against.
      try {
        const backup = await blocker.query<{ id: string }>(
          "SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE",
          [LOCK_BACKUP_TWO],
        );
        blockerBackupId = backup.rows[0]?.id;
        const catalog = await blocker.query<{ catalog_revision: string }>(
          "SELECT catalog_revision FROM agent_backup_catalog_authorities " +
            "WHERE organization_id = $1 AND agent_id = $2 FOR UPDATE",
          [ORG_ID, AGENT_ID],
        );
        blockerCatalogRevision = catalog.rows[0]?.catalog_revision;
      } catch (error) {
        blockerError = error;
      }
      await blocker.query("COMMIT");
      await reservation;

      expect(postgresErrorCode(blockerError)).not.toBe("40P01");
      expect(postgresErrorCode(reservationError)).not.toBe("40P01");
      if (blockerError) throw blockerError;
      if (reservationError) throw reservationError;
      expect(blockerBackupId).toBe(LOCK_BACKUP_TWO);
      expect(blockerCatalogRevision).toBe(fixture.authority.catalogEpoch);
      expect(reservationResult?.replayed).toBe(false);
      expect(reservationResult?.operation.id).toBe(fixture.operationId);
      expect(reservationResult?.target).toEqual({
        nodeRecordId: LOCK_TARGET_NODE_RECORD_ID,
        nodeId: "restore-lock-target",
        nodeIncarnation: LOCK_TARGET_NODE_INCARNATION,
        nodeHistoryId: targetNodeHistoryId,
        imageDigest: `sha256:${SHA}`,
        platform: "linux/amd64",
        imageReference: null,
        imagePlatformDigest: null,
      });
      expect(reservationResult?.operation.expected_node_record_id).toBe(LOCK_TARGET_NODE_RECORD_ID);
      expect(reservationResult?.operation.expected_node_incarnation).toBe(
        LOCK_TARGET_NODE_INCARNATION,
      );
      expect(reservationResult?.operation.expected_node_history_id).toBe(targetNodeHistoryId);
      expect(reservationResult?.operation.expected_image_digest).toBe(`sha256:${SHA}`);
      expect(reservationResult?.operation.expected_image_platform).toBe("linux/amd64");
      const [targetNode] = await dbWrite
        .select({ allocatedCount: dockerNodes.allocated_count })
        .from(dockerNodes)
        .where(eq(dockerNodes.id, LOCK_TARGET_NODE_RECORD_ID));
      expect(targetNode?.allocatedCount).toBe(1);
    } finally {
      await blocker.query("ROLLBACK");
      if (reservation) await reservation;
      await Promise.allSettled([blocker.end(), observer.end()]);
    }
  }, 30_000);

  test("final restore receipt writer cannot deadlock a concurrent sandbox-first reservation", async () => {
    const reserve = reserveAgentBackupOperation;
    const publish = recordAgentActivationPublication;
    const seed = recordAgentVaultKeySeedReceipt;
    const finalize = commitAgentBackupRestore;
    if (!isolatedDsn || !dbWrite || !reserve || !publish || !seed || !finalize) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const targetNodeHistoryId = sourceNodeHistoryId;
    if (!targetNodeHistoryId) throw new Error("source node occurrence token fixture is missing");

    await dbWrite
      .insert(agentBackupCatalogAuthorities)
      .values({ organization_id: ORG_ID, agent_id: AGENT_ID })
      .onConflictDoNothing();
    const [initialAuthority] = await dbWrite
      .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
      .from(agentBackupCatalogAuthorities)
      .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
    if (!initialAuthority) throw new Error("writer fixture catalogue authority is missing");
    const writerManifest = await buildLockManifest(WRITER_OPERATION_ID, WRITER_VAULT_GENERATION);

    await dbWrite.insert(agentVaultKeyGenerations).values({
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      generation_id: WRITER_VAULT_GENERATION,
      source_activation_generation: ACTIVATION_GENERATION,
      supersedes_generation_id: null,
      format: "kms-aead-vault-passphrase-v1",
      kms_key_id: `org:${ORG_ID}/writer-lock/dek/v1`,
      kms_key_version: 1n,
      kms_context: "{}",
      kms_context_derivation: "elizaos.agent-vault-key.kms-context.v1",
      wrapped_ciphertext_base64: Buffer.alloc(32, 0x11).toString("base64"),
      wrapped_nonce_base64: Buffer.alloc(12, 0x22).toString("base64"),
      wrapped_auth_tag_base64: Buffer.alloc(16, 0x33).toString("base64"),
      wrapped_envelope_sha256: SHA,
      authority_receipt_derivation: "elizaos.agent-vault-key.authority-receipt.v1",
      authority_receipt_digest: RECEIPT_SHA,
    });
    await dbWrite.insert(agentVaultKeyAuthorities).values({
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      current_generation_id: WRITER_VAULT_GENERATION,
    });
    await dbWrite.insert(agentSandboxBackups).values({
      id: WRITER_BACKUP_ID,
      sandbox_record_id: null,
      snapshot_type: "auto",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      size_bytes: 92,
      backup_kind: "full",
      backup_operation_id: WRITER_OPERATION_ID,
      catalog_version: 2,
      catalog_state: "protected",
      catalog_payload_digest: SHA,
      catalog_revision: initialAuthority.revision,
      catalog_organization_id: ORG_ID,
      catalog_agent_id: AGENT_ID,
      lifecycle_generation: ACTIVATION_GENERATION,
      lifecycle_revision: 0n,
      source_provider: "operator-onboarded",
      source_node_record_id: NODE_RECORD_ID,
      source_node_id: "robot-node-lock",
      source_node_incarnation: NODE_INCARNATION,
      source_provider_server_id: null,
      source_provider_handle: "container-generation-lock",
      source_container_id: SOURCE_CONTAINER_ID,
      retention_reason: "schedule",
      retention_until: new Date("2026-12-01T00:00:00.000Z"),
      manifest_format: "elizaos.agent-backup",
      manifest_version: 3,
      manifest_digest: writerManifest.digest,
      manifest_canonical_draft: writerManifest.canonicalDraft,
      manifest_object_count: 1,
      object_inventory_digest: SHA,
      image_digest: `sha256:${SHA}`,
      database_schema_version: "1",
      plugin_set_digest: SHA,
      watermark_digest: SHA,
      raw_size_bytes: 1,
      compressed_size_bytes: 1,
      encrypted_size_bytes: 92,
      kms_key_id: `org:${ORG_ID}/writer-lock/backup/v1`,
      kms_key_version: 1,
      operation_key_bundle_generation_id: WRITER_VAULT_GENERATION,
      operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
      operation_key_bundle_ref: `backup-key-bundle:${WRITER_OPERATION_ID}`,
      operation_key_bundle_ciphertext_base64: Buffer.alloc(92, 0x42).toString("base64"),
      operation_key_bundle_sha256: SHA,
      operation_key_bundle_size_bytes: 92,
      operation_key_bundle_context: "{}",
      operation_key_bundle_context_derivation:
        "elizaos.agent-backup.operation-key-bundle-context.v1",
      operation_key_bundle_local_receipt_derivation:
        "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
      operation_key_bundle_local_receipt_digest: SHA,
      vault_key_generation_id: WRITER_VAULT_GENERATION,
      vault_key_authority_receipt_digest: RECEIPT_SHA,
    });
    await dbWrite.insert(agentVaultKeyBackupBindings).values({
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      backup_id: WRITER_BACKUP_ID,
      operation_id: WRITER_OPERATION_ID,
      source_activation_generation: ACTIVATION_GENERATION,
      source_lifecycle_revision: 0n,
      manifest_sha256: writerManifest.digest,
      vault_key_generation_id: WRITER_VAULT_GENERATION,
      vault_key_authority_receipt_digest: RECEIPT_SHA,
    });
    const writerLeaseExpiresAt = new Date(Date.now() + 300_000);
    await dbWrite.insert(agentBackupRestoreLeases).values({
      id: WRITER_LEASE_ID,
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      backup_id: WRITER_BACKUP_ID,
      operation_id: WRITER_OPERATION_ID,
      activation_generation: ACTIVATION_GENERATION,
      lifecycle_revision: 0n,
      expected_manifest_sha256: writerManifest.digest,
      copy_role: "primary",
      restore_attempt_id: WRITER_ATTEMPT_ID,
      owner_id: "writer-lock-owner",
      generation: WRITER_FENCE,
      catalog_epoch: initialAuthority.revision,
      expires_at: writerLeaseExpiresAt,
    });
    await dbWrite.insert(agentBackupRestoreOperations).values({
      id: WRITER_RESTORE_OPERATION_ROW_ID,
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      backup_id: WRITER_BACKUP_ID,
      restore_attempt_id: WRITER_ATTEMPT_ID,
      lease_id: WRITER_LEASE_ID,
      lease_generation: WRITER_FENCE,
      lease_owner_id: "writer-lock-owner",
      catalog_epoch: initialAuthority.revision,
      copy_role: "primary",
      phase: "reserved",
      claim_owner: "writer-lock-owner",
      claim_generation: WRITER_RESTORE_OPERATION_ROW_ID,
      claim_expires_at: new Date(Date.now() + 300_000),
      expected_manifest_sha256: writerManifest.digest,
      expected_operation_id: WRITER_OPERATION_ID,
      expected_activation_generation: ACTIVATION_GENERATION,
      expected_lifecycle_revision: 0n,
      expected_node_history_id: targetNodeHistoryId,
      expected_node_record_id: NODE_RECORD_ID,
      expected_node_incarnation: NODE_INCARNATION,
      expected_container_id: null,
      expected_image_digest: `sha256:${SHA}`,
      expected_image_platform: "linux/amd64",
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        lifecycle_revision: 1,
        activation_generation: WRITER_TARGET_GENERATION,
        activation_previous_generation: ACTIVATION_GENERATION,
        activation_lifecycle_revision: 1n,
        activation_purpose: "restore",
        activation_phase: "container_pending",
        activation_backup_id: WRITER_BACKUP_ID,
        activation_backup_hash: writerManifest.digest,
        activation_receipt: null,
        activation_receipt_hash: null,
        activation_container_id: null,
        activation_node_id: null,
        activation_boot_id: null,
        activation_image_digest: null,
        activation_token_hash: SHA,
        activation_token_ciphertext: "sealed-writer-restore-token",
        activation_authority_published_at: null,
        activation_funding_revision: null,
        activation_dispatched_at: null,
        activation_completed_at: null,
        activation_consent_lifecycle_revision: null,
        activation_consent_head_backup_id: null,
        activation_consent_head_backup_hash: null,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    const writerContainerName = `agent-restore-${AGENT_ID}-${WRITER_ATTEMPT_ID}`;
    const writerIntentAt = new Date();
    await dbWrite.insert(agentSandboxReplacementAttempts).values({
      id: WRITER_REPLACEMENT_ATTEMPT_ID,
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      operation_kind: "provision",
      lifecycle_revision: 1n,
      activation_generation: WRITER_ATTEMPT_ID,
      lifecycle_job_id: null,
      lifecycle_execution_generation: null,
      restore_lease_id: WRITER_LEASE_ID,
      restore_backup_id: WRITER_BACKUP_ID,
      restore_attempt_id: WRITER_ATTEMPT_ID,
      restore_lease_owner_id: "writer-lock-owner",
      restore_lease_generation: WRITER_FENCE,
      restore_catalog_epoch: initialAuthority.revision,
      restore_copy_role: "primary",
      restore_operation_id: WRITER_OPERATION_ID,
      restore_source_activation_generation: ACTIVATION_GENERATION,
      restore_source_lifecycle_revision: 0n,
      restore_manifest_sha256: writerManifest.digest,
      restore_lease_expires_at: writerLeaseExpiresAt,
      locator_sandbox_id: writerContainerName,
      locator_node_id: "robot-node-lock",
      locator_container_name: writerContainerName,
      locator_node_record_id: NODE_RECORD_ID,
      locator_node_incarnation: NODE_INCARNATION,
      locator_node_history_id: targetNodeHistoryId,
      locator_node_hostname: "robot-node-lock.example.test",
      locator_node_ssh_port: 22,
      locator_node_ssh_user: "root",
      locator_node_host_key_fingerprint: "sha256:restore-lock-host-key",
      locator_secret_cleanup_version: 1,
      locator_allocation_counted: true,
      locator_recorded_at: writerIntentAt,
      created_at: writerIntentAt,
      updated_at: writerIntentAt,
    });

    const reservationInput = (operationId: string) => ({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      sandboxRecordId: AGENT_ID,
      operationId,
      activationGeneration: WRITER_TARGET_GENERATION,
      lifecycleRevision: "2",
      snapshotType: "manual" as const,
      backupKind: "full" as const,
      sourceProvider: "operator-onboarded" as const,
      sourceNodeRecordId: NODE_RECORD_ID,
      sourceNodeId: "robot-node-lock",
      sourceNodeIncarnation: NODE_INCARNATION,
      sourceProviderServerId: null,
      sourceProviderHandle: "container-generation-lock",
      sourceContainerId: SOURCE_CONTAINER_ID,
      retentionReason: "manual" as const,
      retentionUntil: new Date("2026-12-02T00:00:00.000Z"),
    });

    const interleaveWithReservation = async (
      operationId: string,
      writer: () => Promise<unknown>,
    ): Promise<void> => {
      const blocker = new Client({ connectionString: isolatedDsn });
      const observer = new Client({ connectionString: isolatedDsn });
      await Promise.all([blocker.connect(), observer.connect()]);
      let writerError: unknown;
      let writerPromise: Promise<void> | undefined;
      let reservationError: unknown;
      let reservationPromise: Promise<void> | undefined;
      try {
        await blocker.query("BEGIN");
        const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await blocker.query(
          "SELECT organization_id FROM agent_backup_catalog_authorities " +
            "WHERE organization_id = $1 AND agent_id = $2 FOR UPDATE",
          [ORG_ID, AGENT_ID],
        );
        writerPromise = writer().then(
          () => undefined,
          (error: unknown) => {
            writerError = error;
          },
        );
        const writerPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
        reservationPromise = reserve(reservationInput(operationId)).then(
          () => undefined,
          (error: unknown) => {
            reservationError = error;
          },
        );
        await waitUntilBlockedBy(observer, writerPid);
        await blocker.query("COMMIT");
        await Promise.all([writerPromise, reservationPromise]);
        if (writerError) throw writerError;
        if (reservationError) throw reservationError;
      } finally {
        await blocker.query("ROLLBACK");
        if (writerPromise) await writerPromise;
        if (reservationPromise) await reservationPromise;
        await Promise.allSettled([blocker.end(), observer.end()]);
      }
    };

    await seed({
      receiptId: WRITER_SEED_ID,
      receiptDigest: WRITER_SEED_DIGEST,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: WRITER_BACKUP_ID,
      restoreAttemptId: WRITER_ATTEMPT_ID,
      replacementAttemptId: WRITER_REPLACEMENT_ATTEMPT_ID,
      leaseId: WRITER_LEASE_ID,
      leaseOwnerId: "writer-lock-owner",
      leaseFencingToken: WRITER_FENCE,
      restoreOperationId: WRITER_RESTORE_OPERATION_ROW_ID,
      restoreClaimGeneration: WRITER_RESTORE_OPERATION_ROW_ID,
      targetActivationGeneration: WRITER_TARGET_GENERATION,
      targetNodeRecordId: NODE_RECORD_ID,
      targetNodeIncarnation: NODE_INCARNATION,
      targetNodeHistoryId,
      targetImageDigest: `sha256:${SHA}`,
      expectedActivationTokenSha256: SHA,
    });

    const providerStartedAt = new Date(writerIntentAt.getTime() + 1);
    const containerRecordedAt = new Date(providerStartedAt.getTime() + 1);
    const providerSucceededAt = new Date(containerRecordedAt.getTime() + 1);
    const lifecycleCommittedAt = new Date(providerSucceededAt.getTime() + 1);
    await dbWrite
      .update(agentSandboxReplacementAttempts)
      .set({ provider_started_at: providerStartedAt, updated_at: providerStartedAt })
      .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));
    await dbWrite
      .update(agentSandboxReplacementAttempts)
      .set({
        locator_container_id: SOURCE_CONTAINER_ID,
        locator_container_recorded_at: containerRecordedAt,
        updated_at: containerRecordedAt,
      })
      .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));
    await dbWrite
      .update(agentSandboxReplacementAttempts)
      .set({
        state: "provider_succeeded",
        provider_succeeded_at: providerSucceededAt,
        provider_receipt_digest: SHA,
        updated_at: providerSucceededAt,
      })
      .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));
    await dbWrite
      .update(agentSandboxReplacementAttempts)
      .set({
        state: "lifecycle_committed",
        lifecycle_committed_at: lifecycleCommittedAt,
        lifecycle_receipt_digest: SHA,
        updated_at: lifecycleCommittedAt,
      })
      .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));

    await dbWrite
      .update(agentBackupRestoreOperations)
      .set({ phase: "restart_attested", expected_container_id: SOURCE_CONTAINER_ID })
      .where(eq(agentBackupRestoreOperations.id, WRITER_RESTORE_OPERATION_ROW_ID));
    await dbWrite
      .update(agentSandboxes)
      .set({
        lifecycle_revision: 2,
        activation_lifecycle_revision: 2n,
        activation_phase: "restart_attested",
        activation_receipt: {
          schemaVersion: 1,
          generation: WRITER_TARGET_GENERATION,
          purpose: "restore",
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          lifecycleRevision: "2",
          backupId: WRITER_BACKUP_ID,
          backupHash: writerManifest.digest,
          manifestHash: writerManifest.digest,
          componentHashes: null,
          freshAuthorization: null,
          containerId: SOURCE_CONTAINER_ID,
          imageDigest: `sha256:${SHA}`,
          receiptId: WRITER_PUBLICATION_ID,
          receiptHash: SHA,
          receiptMac: SHA,
          appliedAt: "2026-08-20T00:00:02.000Z",
          restored: true,
          requiresRestart: true,
        },
        activation_receipt_hash: SHA,
        activation_container_id: SOURCE_CONTAINER_ID,
        activation_node_id: "robot-node-lock",
        activation_boot_id: NODE_INCARNATION,
        activation_image_digest: `sha256:${SHA}`,
        activation_funding_revision: 0n,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));
    const published = await publish({
      publicationId: WRITER_PUBLICATION_ID,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: WRITER_TARGET_GENERATION,
      expectedActivationReceiptSha256: SHA,
      expectedContainerId: SOURCE_CONTAINER_ID,
      expectedNodeRecordId: NODE_RECORD_ID,
      expectedNodeIncarnation: NODE_INCARNATION,
      expectedNodeHistoryId: targetNodeHistoryId,
      expectedTokenSha256: SHA,
    });
    const dispatchedAt = new Date(published.publication.published_at.getTime() + 1_000);
    await dbWrite
      .update(agentSandboxes)
      .set({
        activation_phase: "active",
        activation_authority_published_at: published.publication.published_at,
        activation_dispatched_at: dispatchedAt,
        activation_completed_at: new Date(dispatchedAt.getTime() + 1_000),
      })
      .where(eq(agentSandboxes.id, AGENT_ID));

    await dbWrite.insert(agentNodeIncarnationHistories).values({
      id: WRITER_MISMATCH_NODE_HISTORY_ID,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: "robot-node-lock",
      node_incarnation: WRITER_MISMATCH_NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "sha256:restore-lock-host-key",
    });
    try {
      await dbWrite
        .update(agentVaultKeySeedReceipts)
        .set({
          node_history_id: WRITER_MISMATCH_NODE_HISTORY_ID,
          node_incarnation: WRITER_MISMATCH_NODE_INCARNATION,
        })
        .where(eq(agentVaultKeySeedReceipts.id, WRITER_SEED_ID));
      const [mismatchedSeed] = await dbWrite
        .select({
          nodeHistoryId: agentVaultKeySeedReceipts.node_history_id,
          nodeRecordId: agentVaultKeySeedReceipts.docker_node_record_id,
          nodeIncarnation: agentVaultKeySeedReceipts.node_incarnation,
        })
        .from(agentVaultKeySeedReceipts)
        .where(eq(agentVaultKeySeedReceipts.id, WRITER_SEED_ID));
      const [exactPublication] = await dbWrite
        .select({
          nodeHistoryId: agentActivationPublications.node_history_id,
          nodeRecordId: agentActivationPublications.docker_node_record_id,
          nodeIncarnation: agentActivationPublications.node_incarnation,
        })
        .from(agentActivationPublications)
        .where(eq(agentActivationPublications.id, WRITER_PUBLICATION_ID));
      const [exactReplacement] = await dbWrite
        .select({
          nodeHistoryId: agentSandboxReplacementAttempts.locator_node_history_id,
          nodeRecordId: agentSandboxReplacementAttempts.locator_node_record_id,
          nodeIncarnation: agentSandboxReplacementAttempts.locator_node_incarnation,
        })
        .from(agentSandboxReplacementAttempts)
        .where(eq(agentSandboxReplacementAttempts.id, WRITER_REPLACEMENT_ATTEMPT_ID));
      expect(mismatchedSeed).toEqual({
        nodeHistoryId: WRITER_MISMATCH_NODE_HISTORY_ID,
        nodeRecordId: NODE_RECORD_ID,
        nodeIncarnation: WRITER_MISMATCH_NODE_INCARNATION,
      });
      expect(exactPublication).toEqual({
        nodeHistoryId: targetNodeHistoryId,
        nodeRecordId: NODE_RECORD_ID,
        nodeIncarnation: NODE_INCARNATION,
      });
      expect(exactReplacement).toEqual(exactPublication);
      await expectPostgresFailure(
        dbWrite
          .insert(agentBackupRestoreReceipts)
          .values({
            id: WRITER_MISMATCH_FINAL_ID,
            organization_id: ORG_ID,
            agent_id: AGENT_ID,
            restore_attempt_id: WRITER_ATTEMPT_ID,
            backup_id: WRITER_BACKUP_ID,
            operation_id: WRITER_OPERATION_ID,
            source_activation_generation: ACTIVATION_GENERATION,
            source_lifecycle_revision: 0n,
            manifest_sha256: writerManifest.digest,
            seed_receipt_id: WRITER_SEED_ID,
            seed_receipt_digest: WRITER_SEED_DIGEST,
            replacement_attempt_id: WRITER_REPLACEMENT_ATTEMPT_ID,
            target_activation_generation: WRITER_TARGET_GENERATION,
            activation_purpose: "restore",
            activation_publication_id: WRITER_PUBLICATION_ID,
            activation_receipt_sha256: SHA,
            restore_generation: 1n,
            receipt_digest: SHA,
          })
          .execute(),
        /exact adopted replacement chain/i,
      );
    } finally {
      await dbWrite
        .delete(agentBackupRestoreReceipts)
        .where(eq(agentBackupRestoreReceipts.id, WRITER_MISMATCH_FINAL_ID));
      await dbWrite
        .update(agentVaultKeySeedReceipts)
        .set({
          node_history_id: targetNodeHistoryId,
          node_incarnation: NODE_INCARNATION,
        })
        .where(eq(agentVaultKeySeedReceipts.id, WRITER_SEED_ID));
      await dbWrite
        .delete(agentNodeIncarnationHistories)
        .where(eq(agentNodeIncarnationHistories.id, WRITER_MISMATCH_NODE_HISTORY_ID));
    }

    // Seed and finalization share the same backup -> operation -> lease ->
    // sandbox -> node -> catalogue prefix. Interleave the final writer because
    // it also proves the receipt/publication suffix while keeping the lease's
    // write-once catalogue epoch intact; the competing new reservation advances
    // the epoch only after this writer commits.
    await interleaveWithReservation(WRITER_RESERVE_ONE, () =>
      finalize({
        receiptId: WRITER_FINAL_ID,
        receiptDigest: SHA,
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        backupId: WRITER_BACKUP_ID,
        restoreAttemptId: WRITER_ATTEMPT_ID,
        replacementAttemptId: WRITER_REPLACEMENT_ATTEMPT_ID,
        seedReceiptId: WRITER_SEED_ID,
        seedReceiptDigest: WRITER_SEED_DIGEST,
        activationPublicationId: WRITER_PUBLICATION_ID,
        targetActivationGeneration: WRITER_TARGET_GENERATION,
        expectedActivationReceiptSha256: SHA,
      }),
    );

    expect(
      await dbWrite
        .select({ id: agentBackupRestoreReceipts.id })
        .from(agentBackupRestoreReceipts)
        .where(eq(agentBackupRestoreReceipts.id, WRITER_FINAL_ID)),
    ).toHaveLength(1);
  }, 60_000);

  test("direct expiration wins or fences a racing restore acquisition and replays", async () => {
    const reserve = reserveAgentBackupOperation;
    const transition = transitionAgentBackupOperation;
    const acquire = acquireAgentBackupRestoreLease;
    const release = releaseAgentBackupRestoreLease;
    const inventoryDigest = agentBackupObjectInventoryDigest;
    if (
      !isolatedDsn ||
      !dbWrite ||
      !reserve ||
      !transition ||
      !acquire ||
      !release ||
      !inventoryDigest
    ) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const input = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      sandboxRecordId: AGENT_ID,
      operationId: EXPIRATION_OPERATION_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "0",
      snapshotType: "auto" as const,
      backupKind: "full" as const,
      sourceProvider: "operator-onboarded" as const,
      sourceNodeRecordId: NODE_RECORD_ID,
      sourceNodeId: "robot-node-lock",
      sourceNodeIncarnation: NODE_INCARNATION,
      sourceProviderServerId: null,
      sourceProviderHandle: "container-generation-lock",
      sourceContainerId: SOURCE_CONTAINER_ID,
      retentionReason: "schedule" as const,
      // The sanity acquisition below must start from a genuinely protected,
      // non-expired backup. The race installs its short database-clock
      // retention window explicitly after releasing that sanity lease.
      retentionUntil: new Date("2100-01-01T00:00:00.000Z"),
    };
    const backup = await reserve(input);
    const objectAuthority = {
      component: "database",
      chunkIndex: 0,
      contentHmacSha256: SHA,
      ciphertextSha256: SHA,
      sizeBytes: 1,
    };
    const objectInventoryDigest = await inventoryDigest([objectAuthority]);
    const canonicalManifestDraft = JSON.stringify({
      schemaVersion: 3,
      format: "elizaos.agent-backup",
      operationId: EXPIRATION_OPERATION_ID,
      objectInventoryDigest,
      vaultKeyGenerationId: EXPIRATION_VAULT_GENERATION_ID,
    });
    const manifestDigest = createHash("sha256").update(canonicalManifestDraft).digest("hex");
    const wrappedKeyBundle = Buffer.alloc(92, 0x44);
    const wrappedKeyBundleSha256 = createHash("sha256").update(wrappedKeyBundle).digest("hex");
    await dbWrite.transaction(async (tx) => {
      await tx.insert(agentVaultKeyGenerations).values({
        organization_id: ORG_ID,
        agent_id: AGENT_ID,
        generation_id: EXPIRATION_VAULT_GENERATION_ID,
        source_activation_generation: ACTIVATION_GENERATION,
        supersedes_generation_id: null,
        format: "kms-aead-vault-passphrase-v1",
        kms_key_id: `org:${ORG_ID}/vault/v1`,
        kms_key_version: 1n,
        kms_context: "{}",
        kms_context_derivation: "elizaos.agent-vault-key.kms-context.v1",
        wrapped_ciphertext_base64: Buffer.alloc(32, 0x11).toString("base64"),
        wrapped_nonce_base64: Buffer.alloc(12, 0x22).toString("base64"),
        wrapped_auth_tag_base64: Buffer.alloc(16, 0x33).toString("base64"),
        wrapped_envelope_sha256: SHA,
        authority_receipt_derivation: "elizaos.agent-vault-key.authority-receipt.v1",
        authority_receipt_digest: RECEIPT_SHA,
      });
      await tx.insert(agentVaultKeyAuthorities).values({
        organization_id: ORG_ID,
        agent_id: AGENT_ID,
        current_generation_id: EXPIRATION_VAULT_GENERATION_ID,
      });
      await tx
        .update(agentSandboxBackups)
        .set({
          catalog_state: "protected",
          manifest_format: "elizaos.agent-backup",
          manifest_version: 3,
          manifest_digest: manifestDigest,
          manifest_canonical_draft: canonicalManifestDraft,
          manifest_object_count: 1,
          object_inventory_digest: objectInventoryDigest,
          image_digest: `sha256:${SHA}`,
          database_schema_version: "restore-lock-test-v1",
          plugin_set_digest: SHA,
          watermark_digest: SHA,
          raw_size_bytes: 1,
          compressed_size_bytes: 1,
          encrypted_size_bytes: 1,
          kms_key_id: "restore-lock-test-key",
          kms_key_version: 1,
          operation_key_bundle_generation_id: EXPIRATION_KEY_BUNDLE_GENERATION_ID,
          operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
          operation_key_bundle_ref: `backup-key-bundle:${EXPIRATION_OPERATION_ID}`,
          operation_key_bundle_ciphertext_base64: wrappedKeyBundle.toString("base64"),
          operation_key_bundle_sha256: wrappedKeyBundleSha256,
          operation_key_bundle_size_bytes: 92,
          operation_key_bundle_context: "{}",
          operation_key_bundle_context_derivation:
            "elizaos.agent-backup.operation-key-bundle-context.v1",
          operation_key_bundle_local_receipt_derivation:
            "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
          operation_key_bundle_local_receipt_digest: RECEIPT_SHA,
          vault_key_generation_id: EXPIRATION_VAULT_GENERATION_ID,
          vault_key_authority_receipt_digest: RECEIPT_SHA,
        })
        .where(eq(agentSandboxBackups.id, backup.id));
      await tx.insert(agentVaultKeyBackupBindings).values({
        organization_id: ORG_ID,
        agent_id: AGENT_ID,
        backup_id: backup.id,
        operation_id: EXPIRATION_OPERATION_ID,
        source_activation_generation: ACTIVATION_GENERATION,
        source_lifecycle_revision: 0n,
        manifest_sha256: manifestDigest,
        vault_key_generation_id: EXPIRATION_VAULT_GENERATION_ID,
        vault_key_authority_receipt_digest: RECEIPT_SHA,
      });
      await tx.insert(agentBackupObjects).values([
        {
          organization_id: ORG_ID,
          backup_id: backup.id,
          copy_role: "primary",
          component: objectAuthority.component,
          chunk_index: objectAuthority.chunkIndex,
          state: "verified",
          transport: "worker-r2",
          provider: "cloudflare-r2",
          endpoint_alias: "restore-lock-r2",
          endpoint_identity_fingerprint: `sha256:${"1".repeat(64)}`,
          bucket: "restore-lock-primary",
          region: "auto",
          object_key: `${backup.id}/database/0`,
          key_fingerprint: SHA,
          provider_write_started: true,
          provider_etag: "primary-etag",
          content_hmac_sha256: objectAuthority.contentHmacSha256,
          ciphertext_sha256: objectAuthority.ciphertextSha256,
          size_bytes: objectAuthority.sizeBytes,
          upload_receipt_digest: SHA,
          verified_at: new Date(),
        },
        {
          organization_id: ORG_ID,
          backup_id: backup.id,
          copy_role: "secondary",
          component: objectAuthority.component,
          chunk_index: objectAuthority.chunkIndex,
          state: "verified",
          transport: "s3-compatible",
          provider: "hetzner-object-storage",
          endpoint_alias: "restore-lock-hetzner",
          endpoint_identity_fingerprint: `sha256:${"2".repeat(64)}`,
          bucket: "restore-lock-secondary",
          region: "fsn1",
          object_key: `${backup.id}/database/0`,
          key_fingerprint: SHA,
          provider_write_started: true,
          provider_etag: "secondary-etag",
          content_hmac_sha256: objectAuthority.contentHmacSha256,
          ciphertext_sha256: objectAuthority.ciphertextSha256,
          size_bytes: objectAuthority.sizeBytes,
          upload_receipt_digest: SHA,
          verified_at: new Date(),
        },
      ]);
    });
    const sanity = await acquire({
      organizationId: ORG_ID,
      backupId: backup.id,
      operationId: EXPIRATION_OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "0",
      expectedManifestSha256: manifestDigest,
      copyRole: "primary",
      restoreAttemptId: EXPIRATION_SANITY_ATTEMPT_ID,
      ownerId: "expiration-sanity-owner",
      fencingToken: EXPIRATION_SANITY_FENCE,
      leaseMs: 60_000,
    });
    expect(sanity.status).toBe("acquired");
    const sanityRelease = await release(sanity.authority);
    expect(sanityRelease.released_at).not.toBeNull();
    const [protectedBackup] = await dbWrite
      .update(agentSandboxBackups)
      .set({ retention_until: sql`clock_timestamp() + INTERVAL '500 milliseconds'` })
      .where(eq(agentSandboxBackups.id, backup.id))
      .returning({ retentionUntil: agentSandboxBackups.retention_until });
    if (!protectedBackup?.retentionUntil) {
      throw new Error("expiration race fixture update was lost");
    }
    const blocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([blocker.connect(), observer.connect()]);
    let expirationError: unknown;
    let expiration: Promise<void> | undefined;
    let acquisitionError: unknown;
    let acquisition: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT organization_id FROM agent_backup_catalog_authorities " +
          "WHERE organization_id = $1 AND agent_id = $2 FOR UPDATE",
        [ORG_ID, AGENT_ID],
      );
      expiration = transition({
        organizationId: ORG_ID,
        backupId: backup.id,
        operationId: EXPIRATION_OPERATION_ID,
        lifecycleGeneration: ACTIVATION_GENERATION,
        expectedState: "protected",
        to: "expiration_pending",
      }).then(
        () => undefined,
        (error: unknown) => {
          expirationError = error;
        },
      );
      const expirationPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
      acquisition = acquire({
        organizationId: ORG_ID,
        backupId: backup.id,
        operationId: EXPIRATION_OPERATION_ID,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        sourceLifecycleRevision: "0",
        expectedManifestSha256: manifestDigest,
        copyRole: "primary",
        restoreAttemptId: CLOCK_ATTEMPT_ID,
        ownerId: "expiration-race-owner",
        fencingToken: CLOCK_FENCE,
        leaseMs: 60_000,
      }).then(
        () => undefined,
        (error: unknown) => {
          acquisitionError = error;
        },
      );
      await waitUntilBlockedBy(observer, expirationPid);
      await waitUntilDatabaseTime(observer, protectedBackup.retentionUntil);
      await blocker.query("COMMIT");
      await Promise.all([expiration, acquisition]);
      if (expirationError) throw expirationError;
      expect(String(acquisitionError)).toContain("Backup is not in a restorable catalogue state");
      const replay = await transition({
        organizationId: ORG_ID,
        backupId: backup.id,
        operationId: EXPIRATION_OPERATION_ID,
        lifecycleGeneration: ACTIVATION_GENERATION,
        expectedState: "protected",
        to: "expiration_pending",
      });
      expect(replay.catalog_state).toBe("expiration_pending");
    } finally {
      await blocker.query("ROLLBACK");
      if (expiration) await expiration;
      if (acquisition) await acquisition;
      await Promise.allSettled([blocker.end(), observer.end()]);
    }
  }, 30_000);

  test("candidate begin rechecks lease expiry after waiting for the backup lock", async () => {
    if (!isolatedDsn) throw new Error("real PostgreSQL harness was not initialized");
    const setup = new Client({ connectionString: isolatedDsn });
    const blocker = new Client({ connectionString: isolatedDsn });
    const candidate = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([
      setup.connect(),
      blocker.connect(),
      candidate.connect(),
      observer.connect(),
    ]);
    const schemaName = `restore_v3_candidate_clock_${randomUUID().replaceAll("-", "")}`;
    const organizationId = "00000000-0000-4000-8000-00000000b501";
    const agentId = "00000000-0000-4000-8000-00000000b502";
    const backupId = "00000000-0000-4000-8000-00000000b503";
    const operationId = "00000000-0000-4000-8000-00000000b504";
    const sourceGeneration = "00000000-0000-4000-8000-00000000b505";
    const restoreAttemptId = "00000000-0000-4000-8000-00000000b506";
    const leaseId = "00000000-0000-4000-8000-00000000b507";
    const leaseGeneration = "00000000-0000-4000-8000-00000000b508";
    const restoreOperationId = "00000000-0000-4000-8000-00000000b509";
    const keyBundleGenerationId = "00000000-0000-4000-8000-00000000b50a";
    const cleanupId = "00000000-0000-4000-8000-00000000b50b";
    const candidateId = "00000000-0000-4000-8000-00000000b50c";
    const manifestSha256 = "3".repeat(64);
    const executionTokenSha256 = "4".repeat(64);
    const cleanupCommandSha256 = "5".repeat(64);
    const digest = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const objectFixtures = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(
      (componentName, index) => ({
        objectId: `00000000-0000-4000-8000-${String(0xb601 + index).padStart(12, "0")}`,
        componentIndex: index,
        componentName,
        endpointIdentityFingerprint: `sha256:${digest(`candidate-identity-${index}`)}`,
        endpointAlias: `candidate-alias-${index}`,
        bucket: `candidate-bucket-${index}`,
        region: `candidate-region-${index}`,
        keyFingerprint: digest(`candidate-key-${index}`),
        contentHmacSha256: digest(`candidate-content-${index}`),
        uploadReceiptDigest: digest(`candidate-upload-${index}`),
        ciphertextSha256: digest(`candidate-ciphertext-${index}`),
        providerVersionId: `candidate-version-${index}`,
        sizeBytes: index + 1,
      }),
    );
    const sourceAuthority: AgentBackupRestoreV3SourceAuthority = {
      derivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
      organizationId,
      agentId,
      backupId,
      operationId,
      sourceActivationGeneration: sourceGeneration,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: manifestSha256,
      copyRole: "primary",
      catalogEpoch: "9",
      objects: objectFixtures.map((fixture) => ({
        objectId: fixture.objectId,
        componentIndex: fixture.componentIndex,
        componentName: fixture.componentName,
        chunkIndex: 0,
        copyRole: "primary",
        contentHmacSha256: fixture.contentHmacSha256,
        catalog: {
          transport: "worker-r2",
          provider: "cloudflare-r2",
          endpointIdentityFingerprint: fixture.endpointIdentityFingerprint,
          endpointAliasFingerprint: `sha256:${digest(fixture.endpointAlias)}`,
          bucketFingerprint: `sha256:${digest(fixture.bucket)}`,
          regionFingerprint: `sha256:${digest(fixture.region)}`,
          keyFingerprint: `sha256:${fixture.keyFingerprint}`,
          providerVersionId: fixture.providerVersionId,
          providerEtag: null,
          providerChecksum: null,
          uploadReceiptDigest: fixture.uploadReceiptDigest,
          ciphertextSha256: fixture.ciphertextSha256,
          sizeBytes: fixture.sizeBytes,
        },
      })),
    };
    const sourceCanonical = canonicalizeAgentBackupRestoreV3SourceAuthority(sourceAuthority);
    const sourceSha256 = digest(sourceCanonical);
    let candidateInsert: Promise<void> | undefined;
    let candidateError: unknown;
    let schemaCreated = false;
    try {
      await setup.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await setup.query(`CREATE SCHEMA "${schemaName}"`);
      schemaCreated = true;
      for (const client of [setup, blocker, candidate, observer]) {
        await client.query(`SET search_path TO "${schemaName}", public`);
      }
      await createRestoreV3CandidatePrerequisiteTables(setup);
      for (const migration of RESTORE_V3_CANDIDATE_MIGRATIONS) {
        await setup.query(migration);
      }
      await setup.query("INSERT INTO organizations VALUES ($1)", [organizationId]);
      await setup.query(
        `INSERT INTO agent_backup_catalog_authorities
          (organization_id, agent_id, catalog_revision) VALUES ($1, $2, 9)`,
        [organizationId, agentId],
      );
      await setup.query(
        `INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_agent_id, backup_operation_id,
          lifecycle_generation, lifecycle_revision, manifest_digest,
          operation_key_bundle_generation_id, catalog_state, manifest_version
        ) VALUES ($1, $2, $3, $4, $5, 7, $6, $7, 'protected', 3)`,
        [
          backupId,
          organizationId,
          agentId,
          operationId,
          sourceGeneration,
          manifestSha256,
          keyBundleGenerationId,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_leases (
          id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
          generation, catalog_epoch, copy_role, operation_id, activation_generation,
          lifecycle_revision, expected_manifest_sha256, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'candidate-clock-owner', $6, 9, 'primary',
          $7, $8, 7, $9, clock_timestamp() + INTERVAL '1 hour', clock_timestamp())`,
        [
          leaseId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          leaseGeneration,
          operationId,
          sourceGeneration,
          manifestSha256,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_operations (
          id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
          lease_owner_id, lease_generation, catalog_epoch, copy_role,
          expected_operation_id, expected_activation_generation,
          expected_lifecycle_revision, expected_manifest_sha256, phase
        ) VALUES ($1, $2, $3, $4, $5, $6, 'candidate-clock-owner', $7, 9, 'primary',
          $8, $9, 7, $10, 'reserved')`,
        [
          restoreOperationId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          leaseId,
          leaseGeneration,
          operationId,
          sourceGeneration,
          manifestSha256,
        ],
      );
      for (const fixture of objectFixtures) {
        await setup.query(
          `INSERT INTO agent_backup_objects (
            id, organization_id, backup_id, copy_role, component, chunk_index, state,
            provider_write_started, verified_at, content_hmac_sha256, transport, provider,
            endpoint_identity_fingerprint, endpoint_alias, bucket, region, key_fingerprint,
            provider_version_id, provider_etag, provider_checksum, upload_receipt_digest,
            ciphertext_sha256, size_bytes
          ) VALUES ($1, $2, $3, 'primary', $4, 0, 'verified', true, clock_timestamp(),
            $5, 'worker-r2', 'cloudflare-r2', $6, $7, $8, $9, $10, $11,
            NULL, NULL, $12, $13, $14)`,
          [
            fixture.objectId,
            organizationId,
            backupId,
            fixture.componentName,
            fixture.contentHmacSha256,
            fixture.endpointIdentityFingerprint,
            fixture.endpointAlias,
            fixture.bucket,
            fixture.region,
            fixture.keyFingerprint,
            fixture.providerVersionId,
            fixture.uploadReceiptDigest,
            fixture.ciphertextSha256,
            fixture.sizeBytes,
          ],
        );
      }
      await setup.query(
        `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
          id, organization_id, agent_id, backup_id, restore_attempt_id,
          operation_id, cleanup_command_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          cleanupId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          operationId,
          cleanupCommandSha256,
        ],
      );

      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE", [
        backupId,
      ]);
      const expiry = await setup.query(
        `UPDATE agent_backup_restore_leases
         SET expires_at = clock_timestamp() + INTERVAL '10 seconds'
         WHERE id = $1`,
        [leaseId],
      );
      expect(expiry.rowCount).toBe(1);
      candidateInsert = candidate
        .query(
          `INSERT INTO agent_backup_restore_v3_candidates (
            id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
            restore_operation_id, lease_id, lease_owner_id, lease_generation,
            lease_expires_at, catalog_epoch, source_copy_role, source_activation_generation,
            source_lifecycle_revision, expected_manifest_sha256, key_bundle_generation_id,
            source_authority_canonical, source_authority_sha256, object_count,
            cleanup_outbox_id, execution_token_sha256
          ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'candidate-clock-owner', $9,
            lease.expires_at, 9, 'primary', $10, 7, $11, $12, $13, $14, 5, $15, $16
          FROM agent_backup_restore_leases AS lease WHERE lease.id = $8`,
          [
            candidateId,
            organizationId,
            agentId,
            backupId,
            restoreAttemptId,
            operationId,
            restoreOperationId,
            leaseId,
            leaseGeneration,
            sourceGeneration,
            manifestSha256,
            keyBundleGenerationId,
            sourceCanonical,
            sourceSha256,
            cleanupId,
            executionTokenSha256,
          ],
        )
        .then(
          () => undefined,
          (error: unknown) => {
            candidateError = error;
          },
        );
      const blockedPid = await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
      const startProof = await observer.query<{ started_before_expiry: boolean }>(
        `SELECT activity.query_start < lease.expires_at AS started_before_expiry
         FROM pg_stat_activity AS activity
         CROSS JOIN agent_backup_restore_leases AS lease
         WHERE activity.pid = $1 AND lease.id = $2`,
        [blockedPid, leaseId],
      );
      expect(startProof.rows).toEqual([{ started_before_expiry: true }]);
      await waitForLeaseExpiry(observer, leaseId);
      await blocker.query("COMMIT");
      await candidateInsert;
      expect(String(candidateError)).toContain(
        "restore-v3 lease authority is released, stale, or expired",
      );
      const persisted = await observer.query<{
        candidate_count: string;
        cleanup_state: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM agent_backup_restore_v3_candidates) AS candidate_count,
          (SELECT state FROM agent_backup_restore_v3_candidate_cleanup_outbox WHERE id = $1)
            AS cleanup_state`,
        [cleanupId],
      );
      expect(persisted.rows).toEqual([{ candidate_count: "0", cleanup_state: "armed" }]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      if (candidateInsert) await candidateInsert;
      await Promise.allSettled([blocker.end(), candidate.end(), observer.end()]);
      if (schemaCreated) {
        await setup.query("SET search_path TO public");
        await setup.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
      await setup.end();
    }
  }, 45_000);

  test("GC tombstone fences a concurrent begin before it can resurrect cleanup", async () => {
    if (!isolatedDsn) throw new Error("real PostgreSQL harness was not initialized");
    const setup = new Client({ connectionString: isolatedDsn });
    const gc = new Client({ connectionString: isolatedDsn });
    const begin = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([setup.connect(), gc.connect(), begin.connect(), observer.connect()]);
    const schemaName = `restore_v3_gc_fence_${randomUUID().replaceAll("-", "")}`;
    const organizationId = "00000000-0000-4000-8000-00000000c501";
    const agentId = "00000000-0000-4000-8000-00000000c502";
    const backupId = "00000000-0000-4000-8000-00000000c503";
    const operationId = "00000000-0000-4000-8000-00000000c504";
    const sourceGeneration = "00000000-0000-4000-8000-00000000c505";
    const restoreAttemptId = "00000000-0000-4000-8000-00000000c506";
    const leaseId = "00000000-0000-4000-8000-00000000c507";
    const leaseGeneration = "00000000-0000-4000-8000-00000000c508";
    const restoreOperationId = "00000000-0000-4000-8000-00000000c509";
    const keyBundleGenerationId = "00000000-0000-4000-8000-00000000c50a";
    const cleanupId = "00000000-0000-4000-8000-00000000c50b";
    const candidateId = "00000000-0000-4000-8000-00000000c50c";
    const terminalCommandId = "00000000-0000-4000-8000-00000000c50d";
    const tombstoneId = "00000000-0000-4000-8000-00000000c50e";
    const replayCleanupId = "00000000-0000-4000-8000-00000000c50f";
    const manifestSha256 = "6".repeat(64);
    const sourceAuthorityCanonical = "{}";
    const sourceAuthoritySha256 = createHash("sha256")
      .update(sourceAuthorityCanonical, "utf8")
      .digest("hex");
    const executionTokenSha256 = "7".repeat(64);
    const cleanupCommandSha256 = "8".repeat(64);
    const abortReasonSha256 = "9".repeat(64);
    const terminalCommandSha256 = "a".repeat(64);
    const gcCommandSha256 = "b".repeat(64);
    const replayCleanupCommandSha256 = "c".repeat(64);
    let cleanupInsert: Promise<void> | undefined;
    let cleanupError: unknown;
    let gcCommitted = false;
    let schemaCreated = false;
    try {
      await setup.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await setup.query(`CREATE SCHEMA "${schemaName}"`);
      schemaCreated = true;
      for (const client of [setup, gc, begin, observer]) {
        await client.query(`SET search_path TO "${schemaName}", public`);
      }
      await createRestoreV3CandidatePrerequisiteTables(setup);
      await setup.query(RESTORE_V3_CANDIDATE_MIGRATIONS[0]!);
      await setup.query("INSERT INTO organizations VALUES ($1)", [organizationId]);
      await setup.query(
        `INSERT INTO agent_backup_catalog_authorities
          (organization_id, agent_id, catalog_revision) VALUES ($1, $2, 9)`,
        [organizationId, agentId],
      );
      await setup.query(
        `INSERT INTO agent_sandbox_backups (
          id, catalog_organization_id, catalog_agent_id, backup_operation_id,
          lifecycle_generation, lifecycle_revision, manifest_digest,
          operation_key_bundle_generation_id, catalog_state, manifest_version
        ) VALUES ($1, $2, $3, $4, $5, 7, $6, $7, 'protected', 3)`,
        [
          backupId,
          organizationId,
          agentId,
          operationId,
          sourceGeneration,
          manifestSha256,
          keyBundleGenerationId,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_leases (
          id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
          generation, catalog_epoch, copy_role, operation_id, activation_generation,
          lifecycle_revision, expected_manifest_sha256, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'gc-fence-owner', $6, 9, 'primary',
          $7, $8, 7, $9, clock_timestamp() + INTERVAL '1 hour',
          clock_timestamp() - INTERVAL '41 days')`,
        [
          leaseId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          leaseGeneration,
          operationId,
          sourceGeneration,
          manifestSha256,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_operations (
          id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
          lease_owner_id, lease_generation, catalog_epoch, copy_role,
          expected_operation_id, expected_activation_generation,
          expected_lifecycle_revision, expected_manifest_sha256, phase
        ) VALUES ($1, $2, $3, $4, $5, $6, 'gc-fence-owner', $7, 9, 'primary',
          $8, $9, 7, $10, 'reserved')`,
        [
          restoreOperationId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          leaseId,
          leaseGeneration,
          operationId,
          sourceGeneration,
          manifestSha256,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
          id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
          cleanup_command_sha256, state, receipt_sha256, completed_at, next_attempt_at,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8,
          statement_timestamp() - INTERVAL '40 days',
          statement_timestamp() - INTERVAL '41 days',
          statement_timestamp() - INTERVAL '41 days',
          statement_timestamp() - INTERVAL '40 days')`,
        [
          cleanupId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          operationId,
          cleanupCommandSha256,
          cleanupCommandSha256,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_v3_candidates (
          id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
          restore_operation_id, lease_id, lease_owner_id, lease_generation,
          lease_expires_at, catalog_epoch, source_copy_role, source_activation_generation,
          source_lifecycle_revision, expected_manifest_sha256, key_bundle_generation_id,
          source_authority_canonical, source_authority_sha256, object_count,
          cleanup_outbox_id, execution_token_sha256, state, abort_reason_sha256,
          aborted_at, retention_until, created_at, updated_at
        ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'gc-fence-owner', $9,
          lease.expires_at, 9, 'primary', $10, 7, $11, $12, $13, $14, 5, $15, $16,
          'aborted', $17, clock_timestamp() - INTERVAL '40 days',
          clock_timestamp() - INTERVAL '10 days', clock_timestamp() - INTERVAL '41 days',
          clock_timestamp() - INTERVAL '40 days'
        FROM agent_backup_restore_leases AS lease WHERE lease.id = $8`,
        [
          candidateId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          operationId,
          restoreOperationId,
          leaseId,
          leaseGeneration,
          sourceGeneration,
          manifestSha256,
          keyBundleGenerationId,
          sourceAuthorityCanonical,
          sourceAuthoritySha256,
          cleanupId,
          executionTokenSha256,
          abortReasonSha256,
        ],
      );
      await setup.query(
        `INSERT INTO agent_backup_restore_v3_candidate_terminal_commands (
          id, candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
          operation_id, execution_token_sha256, command_kind, abort_reason_sha256,
          command_sha256, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'abort', $9, $10,
          clock_timestamp() - INTERVAL '40 days')`,
        [
          terminalCommandId,
          candidateId,
          organizationId,
          agentId,
          backupId,
          restoreAttemptId,
          operationId,
          executionTokenSha256,
          abortReasonSha256,
          terminalCommandSha256,
        ],
      );
      await setup.query(RESTORE_V3_CANDIDATE_MIGRATIONS[1]!);

      await gc.query("BEGIN");
      const gcPid = await gc.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await gc.query(
        `INSERT INTO agent_backup_restore_v3_candidate_gc_tombstones (
          id, candidate_id, cleanup_outbox_id, organization_id, agent_id, backup_id,
          restore_attempt_id, operation_id, terminal_state, terminal_evidence_sha256,
          retention_until, gc_command_sha256
        ) SELECT $1, candidate.id, candidate.cleanup_outbox_id, candidate.organization_id,
          candidate.agent_id, candidate.backup_id, candidate.restore_attempt_id,
          candidate.operation_id, candidate.state, candidate.abort_reason_sha256,
          candidate.retention_until, $2
        FROM agent_backup_restore_v3_candidates AS candidate WHERE candidate.id = $3`,
        [tombstoneId, gcCommandSha256, candidateId],
      );
      cleanupInsert = begin
        .query(
          `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
            id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
            cleanup_command_sha256
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            replayCleanupId,
            organizationId,
            agentId,
            backupId,
            restoreAttemptId,
            operationId,
            replayCleanupCommandSha256,
          ],
        )
        .then(
          () => undefined,
          (error: unknown) => {
            cleanupError = error;
          },
        );
      const blocked = await waitUntilAdvisoryBlockedBy(observer, gcPid.rows[0]!.pid);
      expect(blocked.wait_event_type).toBe("Lock");
      expect(blocked.wait_event).toBe("advisory");
      await gc.query("COMMIT");
      gcCommitted = true;
      await cleanupInsert;
      expect(String(cleanupError)).toContain(
        "restore-v3 restore attempt is permanently closed by GC tombstone",
      );
      const persisted = await observer.query<{
        cleanups: string;
        candidates: string;
        tombstones: string;
      }>(`SELECT
        (SELECT count(*)::text FROM agent_backup_restore_v3_candidate_cleanup_outbox)
          AS cleanups,
        (SELECT count(*)::text FROM agent_backup_restore_v3_candidates) AS candidates,
        (SELECT count(*)::text FROM agent_backup_restore_v3_candidate_gc_tombstones)
          AS tombstones`);
      expect(persisted.rows).toEqual([{ cleanups: "0", candidates: "0", tombstones: "1" }]);

      for (const [isolation, cleanupIdForIsolation] of [
        ["REPEATABLE READ", "00000000-0000-4000-8000-00000000c510"],
        ["SERIALIZABLE", "00000000-0000-4000-8000-00000000c511"],
      ] as const) {
        await begin.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        let isolationError: unknown;
        try {
          await begin.query(
            `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
              id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
              cleanup_command_sha256
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              cleanupIdForIsolation,
              organizationId,
              agentId,
              backupId,
              restoreAttemptId,
              operationId,
              replayCleanupCommandSha256,
            ],
          );
        } catch (error) {
          isolationError = error;
        } finally {
          await begin.query("ROLLBACK");
        }
        expect(isolationError).toBeInstanceOf(Error);
        expect((isolationError as Error).message).toBe(
          "restore-v3 attempt fencing requires read committed isolation",
        );
        expect(postgresErrorCode(isolationError)).toBe("55000");
        const afterRejectedIsolation = await observer.query<{
          cleanups: string;
          candidates: string;
          tombstones: string;
        }>(`SELECT
          (SELECT count(*)::text FROM agent_backup_restore_v3_candidate_cleanup_outbox)
            AS cleanups,
          (SELECT count(*)::text FROM agent_backup_restore_v3_candidates) AS candidates,
          (SELECT count(*)::text FROM agent_backup_restore_v3_candidate_gc_tombstones)
            AS tombstones`);
        expect(afterRejectedIsolation.rows).toEqual([
          { cleanups: "0", candidates: "0", tombstones: "1" },
        ]);
      }
    } finally {
      if (!gcCommitted) await gc.query("ROLLBACK").catch(() => undefined);
      if (cleanupInsert) await cleanupInsert;
      await Promise.allSettled([gc.end(), begin.end(), observer.end()]);
      if (schemaCreated) {
        await setup.query("SET search_path TO public");
        await setup.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
      await setup.end();
    }
  }, 30_000);

  test("raw renewal takes its database clock after a blocking relation lock", async () => {
    if (!isolatedDsn) throw new Error("real PostgreSQL harness was not initialized");
    const setup = new Client({ connectionString: isolatedDsn });
    const blocker = new Client({ connectionString: isolatedDsn });
    const renewer = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([setup.connect(), blocker.connect(), renewer.connect(), observer.connect()]);
    let renewal: Promise<void> | undefined;
    try {
      await setup.query("CREATE SCHEMA restore_clock_test");
      for (const client of [setup, blocker, renewer, observer]) {
        await client.query("SET search_path TO restore_clock_test, public");
      }
      await setup.query(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE agent_backup_catalog_authorities (
          organization_id uuid NOT NULL REFERENCES organizations(id), agent_id uuid NOT NULL,
          catalog_revision bigint NOT NULL DEFAULT 0, restore_generation bigint NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT NOW(), PRIMARY KEY (organization_id, agent_id)
        );
        CREATE TABLE agent_sandbox_backups (
          id uuid PRIMARY KEY, catalog_organization_id uuid NOT NULL REFERENCES organizations(id),
          catalog_agent_id uuid NOT NULL, backup_operation_id uuid NOT NULL,
          lifecycle_generation uuid NOT NULL, lifecycle_revision numeric(20, 0) NOT NULL,
          manifest_digest text NOT NULL, manifest_version integer, catalog_state text,
          vault_key_generation_id uuid, vault_key_authority_receipt_digest text,
          CONSTRAINT agent_sandbox_backups_catalog_chain_identity_unique
            UNIQUE (id, catalog_organization_id, catalog_agent_id)
        );
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id),
          activation_backup_id uuid,
          activation_consent_head_backup_id uuid
        );
        INSERT INTO organizations VALUES ('${CLOCK_ORG_ID}');
        INSERT INTO agent_backup_catalog_authorities
          (organization_id, agent_id, catalog_revision, restore_generation)
          VALUES ('${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}', 9, 4);
        INSERT INTO agent_sandbox_backups VALUES (
          '${CLOCK_BACKUP_ID}', '${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}',
          '${CLOCK_OPERATION_ID}', '${CLOCK_ACTIVATION_GENERATION}', 7, '${SHA}', 3,
          'protected', '${CLOCK_VAULT_GENERATION}', '${RECEIPT_SHA}'
        );
      `);
      for (const migration of RESTORE_MIGRATIONS) await setup.query(migration);
      await setup.query(`
        BEGIN;
        INSERT INTO agent_vault_key_generations (
          organization_id, agent_id, generation_id, source_activation_generation,
          supersedes_generation_id, format, kms_key_id, kms_key_version, kms_context,
          kms_context_derivation, wrapped_ciphertext_base64, wrapped_nonce_base64,
          wrapped_auth_tag_base64, wrapped_envelope_sha256,
          authority_receipt_derivation, authority_receipt_digest
        ) VALUES (
          '${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}', '${CLOCK_VAULT_GENERATION}',
          '${CLOCK_ACTIVATION_GENERATION}', NULL, 'kms-aead-vault-passphrase-v1',
          'org:${CLOCK_ORG_ID}/dek/v1', 1, '{}', 'elizaos.agent-vault-key.kms-context.v1',
          '${Buffer.alloc(32, 0x11).toString("base64")}',
          '${Buffer.alloc(12, 0x22).toString("base64")}',
          '${Buffer.alloc(16, 0x33).toString("base64")}', '${SHA}',
          'elizaos.agent-vault-key.authority-receipt.v1', '${RECEIPT_SHA}'
        );
        INSERT INTO agent_vault_key_authorities
          (organization_id, agent_id, current_generation_id)
          VALUES ('${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}', '${CLOCK_VAULT_GENERATION}');
        COMMIT;
        INSERT INTO agent_vault_key_backup_bindings VALUES (
          '${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}', '${CLOCK_BACKUP_ID}',
          '${CLOCK_OPERATION_ID}', '${CLOCK_ACTIVATION_GENERATION}', 7, '${SHA}',
          '${CLOCK_VAULT_GENERATION}', '${RECEIPT_SHA}', clock_timestamp()
        );
        INSERT INTO agent_backup_restore_leases (
          id, organization_id, agent_id, backup_id, operation_id, activation_generation,
          lifecycle_revision, expected_manifest_sha256, copy_role, restore_attempt_id,
          owner_id, generation, catalog_epoch, expires_at, created_at
        ) SELECT '${CLOCK_LEASE_ID}', '${CLOCK_ORG_ID}', '${CLOCK_AGENT_ID}',
          '${CLOCK_BACKUP_ID}', '${CLOCK_OPERATION_ID}', '${CLOCK_ACTIVATION_GENERATION}', 7,
          '${SHA}', 'primary', '${CLOCK_ATTEMPT_ID}', 'clock-test-owner', '${CLOCK_FENCE}', 9,
          db_now + INTERVAL '500 milliseconds', db_now
          FROM (SELECT clock_timestamp() AS db_now) AS clock;
      `);
      await blocker.query("BEGIN");
      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("LOCK TABLE agent_sandbox_backups IN ACCESS EXCLUSIVE MODE");
      let renewalError: unknown;
      renewal = renewer
        .query(
          "UPDATE agent_backup_restore_leases " +
            "SET expires_at = clock_timestamp() + INTERVAL '1 minute' WHERE id = $1",
          [CLOCK_LEASE_ID],
        )
        .then(
          () => undefined,
          (error: unknown) => {
            renewalError = error;
          },
        );
      await waitUntilBlockedBy(observer, blockerPid.rows[0]!.pid);
      await waitForLeaseExpiry(observer);
      await blocker.query("COMMIT");
      await renewal;
      expect(String(renewalError)).toMatch(/renewal must be live, monotone, and bounded/);
      const persisted = await observer.query<{ expired: boolean }>(
        "SELECT expires_at <= clock_timestamp() AS expired " +
          "FROM agent_backup_restore_leases WHERE id = $1",
        [CLOCK_LEASE_ID],
      );
      expect(persisted.rows).toEqual([{ expired: true }]);
    } finally {
      await blocker.query("ROLLBACK");
      if (renewal) await renewal;
      await Promise.allSettled([setup.end(), blocker.end(), renewer.end(), observer.end()]);
    }
  }, 30_000);
});

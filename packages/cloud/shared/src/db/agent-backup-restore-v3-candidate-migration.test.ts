/** Replay, drift, and fail-closed proofs for restore-v3 candidate migrations 0373/0374. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3SourceAuthority,
  canonicalizeAgentBackupRestoreV3CandidateReceipt,
  canonicalizeAgentBackupRestoreV3SourceAuthority,
} from "@elizaos/shared";
import { AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMPONENTS } from "./schemas/agent-backup-restore-v3-candidates";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const FOUNDATION_TAG = "0373_agent_backup_restore_v3_candidates";
const GUARDS_TAG = "0374_agent_backup_restore_v3_candidate_guards";
const FOUNDATION = readFileSync(join(MIGRATIONS_DIR, `${FOUNDATION_TAG}.sql`), "utf8");
const GUARDS = readFileSync(join(MIGRATIONS_DIR, `${GUARDS_TAG}.sql`), "utf8");
const CANDIDATE_SCHEMA = readFileSync(
  join(import.meta.dir, "schemas", "agent-backup-restore-v3-candidates.ts"),
  "utf8",
);
const CATALOG_SCHEMA = readFileSync(
  join(import.meta.dir, "schemas", "agent-backup-catalog.ts"),
  "utf8",
);

const IDS = {
  organization: "00000000-0000-4000-8000-00000000a001",
  agent: "00000000-0000-4000-8000-00000000a002",
  backup: "00000000-0000-4000-8000-00000000a003",
  operation: "00000000-0000-4000-8000-00000000a004",
  sourceGeneration: "00000000-0000-4000-8000-00000000a005",
  restoreAttempt: "00000000-0000-4000-8000-00000000a006",
  lease: "00000000-0000-4000-8000-00000000a007",
  leaseGeneration: "00000000-0000-4000-8000-00000000a008",
  restoreOperation: "00000000-0000-4000-8000-00000000a009",
  keyBundleGeneration: "00000000-0000-4000-8000-00000000a00a",
  cleanup: "00000000-0000-4000-8000-00000000a00b",
  candidate: "00000000-0000-4000-8000-00000000a00c",
  authorization: "00000000-0000-4000-8000-00000000a00d",
  terminal: "00000000-0000-4000-8000-00000000a00e",
  gc: "00000000-0000-4000-8000-00000000a00f",
} as const;
const OBJECT_IDS = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(
  (_, index) => `00000000-0000-4000-8000-${String(0xa101 + index).padStart(12, "0")}`,
);
const MANIFEST_SHA256 = "a".repeat(64);
const EXECUTION_TOKEN_SHA256 = "b".repeat(64);
const CLEANUP_COMMAND_SHA256 = "c".repeat(64);
const AUTHORIZATION_REQUEST_SHA256 = "d".repeat(64);
const PROOF_TOKEN_SHA256 = "e".repeat(64);
const COMMAND_SHA256 = "f".repeat(64);
const ABORT_REASON_SHA256 = "1".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tableBody(table: string): string {
  const start = FOUNDATION.indexOf(`CREATE TABLE IF NOT EXISTS "${table}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = FOUNDATION.slice(start);
  const end = tail.indexOf("\n);\n");
  expect(end).toBeGreaterThan(0);
  return tail.slice(0, end + 3);
}

function sourceAuthority(): AgentBackupRestoreV3SourceAuthority {
  return {
    derivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    organizationId: IDS.organization,
    agentId: IDS.agent,
    backupId: IDS.backup,
    operationId: IDS.operation,
    sourceActivationGeneration: IDS.sourceGeneration,
    sourceLifecycleRevision: "7",
    expectedManifestSha256: MANIFEST_SHA256,
    copyRole: "primary",
    catalogEpoch: "9",
    objects: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, index) => ({
      objectId: OBJECT_IDS[index] as string,
      componentIndex: index,
      componentName,
      chunkIndex: 0,
      copyRole: "primary" as const,
      contentHmacSha256: sha256(`content-${index}`),
      catalog: {
        transport: "worker-r2" as const,
        provider: "cloudflare-r2" as const,
        endpointIdentityFingerprint: `sha256:${sha256(`endpoint-identity-${index}`)}`,
        endpointAliasFingerprint: `sha256:${sha256(`endpoint-alias-${index}`)}`,
        bucketFingerprint: `sha256:${sha256(`bucket-${index}`)}`,
        regionFingerprint: `sha256:${sha256(`region-${index}`)}`,
        keyFingerprint: `sha256:${sha256(`key-${index}`)}`,
        providerVersionId: `version-${index}`,
        providerEtag: null,
        providerChecksum: null,
        uploadReceiptDigest: sha256(`upload-${index}`),
        ciphertextSha256: sha256(`ciphertext-${index}`),
        sizeBytes: index + 1,
      },
    })),
  };
}

function candidateReceipt(sourceAuthoritySha256: string): AgentBackupRestoreV3CandidateReceipt {
  return {
    format: AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
    restoreAttemptId: IDS.restoreAttempt,
    operationId: IDS.operation,
    expectedManifestSha256: MANIFEST_SHA256,
    keyBundleGenerationId: IDS.keyBundleGeneration,
    sourceCopyRole: "primary",
    sourceAuthorityDerivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    sourceAuthoritySha256,
    objectCount: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length,
    stagedPayloadBytes: 0,
    stagedDataRecordCount: 0,
    sourceObjects: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, index) => ({
      componentIndex: index,
      componentName,
      chunkIndex: 0,
      copyRole: "primary" as const,
      objectId: OBJECT_IDS[index] as string,
      exactReadReceiptDerivation: AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
      exactReadReceiptSha256: sha256(`exact-read-${index}`),
      ciphertextSha256: sha256(`ciphertext-${index}`),
      sizeBytes: index + 1,
    })),
    components: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, index) => ({
      componentIndex: index,
      componentName,
      descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[index],
      dataFrameCount: 0,
      payloadBytes: 0,
      payloadSha256: sha256(`component-payload-${index}`),
      recordStreamContentHmacSha256: sha256(`record-stream-${index}`),
    })),
    authorityRevalidated: true,
  };
}

async function prerequisiteDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
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
  return database;
}

async function applyFoundation(database: PGlite): Promise<void> {
  await database.exec(FOUNDATION);
}

async function applyGuards(database: PGlite): Promise<void> {
  await database.exec(GUARDS);
}

interface SeededAuthority {
  sourceCanonical: string;
  sourceSha256: string;
}

async function seedCurrentAuthority(database: PGlite): Promise<SeededAuthority> {
  const sourceCanonical = canonicalizeAgentBackupRestoreV3SourceAuthority(sourceAuthority());
  const sourceSha256 = sha256(sourceCanonical);
  await database.exec(`
    INSERT INTO organizations VALUES ('${IDS.organization}');
    INSERT INTO agent_backup_catalog_authorities (organization_id, agent_id, catalog_revision)
      VALUES ('${IDS.organization}', '${IDS.agent}', 9);
    INSERT INTO agent_sandbox_backups (
      id, catalog_organization_id, catalog_agent_id, backup_operation_id,
      lifecycle_generation, lifecycle_revision, manifest_digest,
      operation_key_bundle_generation_id, catalog_state, manifest_version
    ) VALUES ('${IDS.backup}', '${IDS.organization}', '${IDS.agent}', '${IDS.operation}',
      '${IDS.sourceGeneration}', 7, '${MANIFEST_SHA256}', '${IDS.keyBundleGeneration}',
      'protected', 3);
    INSERT INTO agent_backup_restore_leases (
      id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
      generation, catalog_epoch, copy_role, operation_id, activation_generation,
      lifecycle_revision, expected_manifest_sha256, expires_at, created_at
    ) VALUES ('${IDS.lease}', '${IDS.organization}', '${IDS.agent}', '${IDS.backup}',
      '${IDS.restoreAttempt}', 'restore-worker', '${IDS.leaseGeneration}', 9,
      'primary', '${IDS.operation}', '${IDS.sourceGeneration}', 7,
      '${MANIFEST_SHA256}', statement_timestamp() + INTERVAL '60 minutes',
      statement_timestamp() - INTERVAL '1 minute');
    INSERT INTO agent_backup_restore_operations (
      id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
      lease_owner_id, lease_generation, catalog_epoch, copy_role,
      expected_operation_id, expected_activation_generation,
      expected_lifecycle_revision, expected_manifest_sha256, phase
    ) VALUES ('${IDS.restoreOperation}', '${IDS.organization}', '${IDS.agent}', '${IDS.backup}',
      '${IDS.restoreAttempt}', '${IDS.lease}', 'restore-worker', '${IDS.leaseGeneration}',
      9, 'primary', '${IDS.operation}', '${IDS.sourceGeneration}', 7,
      '${MANIFEST_SHA256}', 'reserved');
  `);
  for (const [index, component] of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.entries()) {
    await database.query(
      `INSERT INTO agent_backup_objects (
        id, organization_id, backup_id, copy_role, component, chunk_index, state,
        provider_write_started, verified_at, content_hmac_sha256, transport, provider,
        endpoint_identity_fingerprint, endpoint_alias, bucket, region, key_fingerprint,
        provider_version_id, provider_etag, provider_checksum, upload_receipt_digest,
        ciphertext_sha256, size_bytes
      ) VALUES ($1, $2, $3, 'primary', $4, 0, 'verified', true, statement_timestamp(),
        $5, 'worker-r2', 'cloudflare-r2', $6, $7, $8, $9, $10,
        $11, NULL, NULL, $12, $13, $14)`,
      [
        OBJECT_IDS[index],
        IDS.organization,
        IDS.backup,
        component,
        sha256(`content-${index}`),
        `sha256:${sha256(`endpoint-identity-${index}`)}`,
        `endpoint-alias-${index}`,
        `bucket-${index}`,
        `region-${index}`,
        sha256(`key-${index}`),
        `version-${index}`,
        sha256(`upload-${index}`),
        sha256(`ciphertext-${index}`),
        index + 1,
      ],
    );
  }
  await database.exec(`INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
    id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
    cleanup_command_sha256) VALUES ('${IDS.cleanup}', '${IDS.organization}', '${IDS.agent}',
    '${IDS.backup}', '${IDS.restoreAttempt}', '${IDS.operation}', '${CLEANUP_COMMAND_SHA256}')`);
  return { sourceCanonical, sourceSha256 };
}

async function insertCandidate(
  database: PGlite,
  authority: SeededAuthority,
  identity: {
    candidateId?: string;
    cleanupId?: string;
    executionTokenSha256?: string;
  } = {},
): Promise<void> {
  await database.query(
    `INSERT INTO agent_backup_restore_v3_candidates (
      id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
      restore_operation_id, lease_id, lease_owner_id, lease_generation,
      lease_expires_at, catalog_epoch, source_copy_role, source_activation_generation,
      source_lifecycle_revision, expected_manifest_sha256, key_bundle_generation_id,
      source_authority_canonical, source_authority_sha256, object_count,
      cleanup_outbox_id, execution_token_sha256
    ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'restore-worker', $9,
      lease.expires_at, 9, 'primary', $10, 7, $11, $12, $13, $14, 5, $15, $16
    FROM agent_backup_restore_leases AS lease WHERE lease.id = $8`,
    [
      identity.candidateId ?? IDS.candidate,
      IDS.organization,
      IDS.agent,
      IDS.backup,
      IDS.restoreAttempt,
      IDS.operation,
      IDS.restoreOperation,
      IDS.lease,
      IDS.leaseGeneration,
      IDS.sourceGeneration,
      MANIFEST_SHA256,
      IDS.keyBundleGeneration,
      authority.sourceCanonical,
      authority.sourceSha256,
      identity.cleanupId ?? IDS.cleanup,
      identity.executionTokenSha256 ?? EXECUTION_TOKEN_SHA256,
    ],
  );
}

async function insertFinishedComponent(
  database: PGlite,
  index: number,
  payloadBytes = 0,
  dataFrameCount = 0,
): Promise<void> {
  const componentName = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[index];
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[index];
  if (!componentName || !descriptor) throw new Error("missing restore-v3 descriptor");
  await database.query(
    `INSERT INTO agent_backup_restore_v3_candidate_stage_ledger (
        candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
        operation_id, execution_token_sha256, command_kind, component_index,
        component_name, payload_bytes, payload_sha256, data_frame_count,
        descriptor_format, descriptor_compression, descriptor_content_kind,
        descriptor_consistency, descriptor_sha256, record_stream_content_hmac_sha256,
        command_sha256, receipt_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'finish', $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      IDS.candidate,
      IDS.organization,
      IDS.agent,
      IDS.backup,
      IDS.restoreAttempt,
      IDS.operation,
      EXECUTION_TOKEN_SHA256,
      index,
      componentName,
      payloadBytes,
      sha256(`component-payload-${index}`),
      dataFrameCount,
      descriptor.format,
      descriptor.compression,
      descriptor.contentKind,
      descriptor.consistency,
      sha256(`descriptor-${index}`),
      sha256(`record-stream-${index}`),
      sha256(`finish-command-${index}`),
      sha256(`finish-receipt-${index}`),
    ],
  );
}

async function insertFinishedComponents(database: PGlite): Promise<void> {
  for (const index of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.keys()) {
    await insertFinishedComponent(database, index);
  }
}

interface TestStageFileEntry {
  path: string;
  fileOffsetBytes: number;
  fileSizeBytes: number;
  mode: number;
  mtimeMs: number;
}

async function insertStageRecord(
  database: PGlite,
  input: {
    componentIndex: number;
    dataIndex: number;
    offsetBytes: number;
    payloadBytes: number;
    entry: TestStageFileEntry | null;
  },
): Promise<void> {
  const componentName = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[input.componentIndex];
  if (!componentName) throw new Error("missing restore-v3 component");
  const entryCanonical =
    input.entry === null
      ? "null"
      : JSON.stringify({
          fileOffsetBytes: input.entry.fileOffsetBytes,
          fileSizeBytes: input.entry.fileSizeBytes,
          mode: input.entry.mode,
          mtimeMs: input.entry.mtimeMs,
          path: input.entry.path,
        });
  await database.query(
    `INSERT INTO agent_backup_restore_v3_candidate_stage_ledger (
      candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
      operation_id, execution_token_sha256, command_kind, component_index,
      component_name, data_index, offset_bytes, entry_path, entry_file_offset_bytes,
      entry_file_size_bytes, entry_mode, entry_mtime_ms, entry_metadata_sha256,
      payload_bytes, payload_sha256, command_sha256, receipt_sha256
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'record', $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      IDS.candidate,
      IDS.organization,
      IDS.agent,
      IDS.backup,
      IDS.restoreAttempt,
      IDS.operation,
      EXECUTION_TOKEN_SHA256,
      input.componentIndex,
      componentName,
      input.dataIndex,
      input.offsetBytes,
      input.entry?.path ?? null,
      input.entry?.fileOffsetBytes ?? null,
      input.entry?.fileSizeBytes ?? null,
      input.entry?.mode ?? null,
      input.entry?.mtimeMs ?? null,
      sha256(entryCanonical),
      input.payloadBytes,
      sha256(`payload-${input.componentIndex}-${input.dataIndex}`),
      sha256(`record-command-${input.componentIndex}-${input.dataIndex}`),
      sha256(`record-receipt-${input.componentIndex}-${input.dataIndex}`),
    ],
  );
}

async function insertAuthorization(database: PGlite, id: string, receiptSha256: string) {
  await database.query(
    `INSERT INTO agent_backup_restore_v3_candidate_seal_authorizations (
      id, candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
      operation_id, execution_token_sha256, expected_manifest_sha256,
      key_bundle_generation_id, source_copy_role, source_authority_sha256,
      object_count, candidate_receipt_sha256, authorization_request_sha256,
      proof_token_sha256, expires_at
    ) SELECT $1, id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
      execution_token_sha256, expected_manifest_sha256, key_bundle_generation_id,
      source_copy_role, source_authority_sha256, object_count, $2, $3, $4,
      statement_timestamp() + INTERVAL '90 minutes'
    FROM agent_backup_restore_v3_candidates WHERE id = $5`,
    [id, receiptSha256, AUTHORIZATION_REQUEST_SHA256, PROOF_TOKEN_SHA256, IDS.candidate],
  );
}

async function insertSealCommand(
  database: PGlite,
  id: string,
  authorizationId: string,
  receiptCanonical: string,
  receiptSha256: string,
) {
  await database.query(
    `INSERT INTO agent_backup_restore_v3_candidate_terminal_commands (
      id, candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
      operation_id, execution_token_sha256, command_kind, authorization_id,
      proof_token_sha256, sealed_receipt_canonical, sealed_receipt_sha256, command_sha256
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seal', $9, $10, $11, $12, $13)`,
    [
      id,
      IDS.candidate,
      IDS.organization,
      IDS.agent,
      IDS.backup,
      IDS.restoreAttempt,
      IDS.operation,
      EXECUTION_TOKEN_SHA256,
      authorizationId,
      PROOF_TOKEN_SHA256,
      receiptCanonical,
      receiptSha256,
      COMMAND_SHA256,
    ],
  );
}

async function expectBeginRejected(
  database: PGlite,
  authority: SeededAuthority,
  mutation: string,
  error: RegExp,
): Promise<void> {
  await database.exec("BEGIN");
  try {
    await database.exec(mutation);
    await expect(insertCandidate(database, authority)).rejects.toThrow(error);
  } finally {
    await database.exec("ROLLBACK");
  }
}

describe("0373/0374 restore-v3 candidate authority", () => {
  test("registers consecutive journal entries and exports the schema", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    expect(journal.entries.slice(-2)).toEqual([
      { idx: 356, version: "7", when: 1794254400064, tag: FOUNDATION_TAG, breakpoints: true },
      { idx: 357, version: "7", when: 1794254400065, tag: GUARDS_TAG, breakpoints: true },
    ]);
    expect(readFileSync(join(import.meta.dir, "schemas", "index.ts"), "utf8")).toContain(
      'export * from "./agent-backup-restore-v3-candidates"',
    );
  });

  test("shares the exact component contract and descriptor vocabulary", () => {
    expect(AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMPONENTS).toBe(
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
    );
    const compactFoundation = FOUNDATION.replace(/\s+/g, " ");
    for (const [index, component] of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.entries()) {
      expect(compactFoundation).toContain(`(${index}, '${component}')`);
      const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[index];
      expect(descriptor).toBeDefined();
      if (descriptor)
        for (const value of [
          descriptor.format,
          descriptor.compression,
          descriptor.contentKind,
          descriptor.consistency,
        ])
          expect(FOUNDATION).toContain(`'${value}'`);
    }
  });

  test("keeps cleanup parent-first and removes lease expiry from relational authority", () => {
    const cleanup = "agent_backup_restore_v3_candidate_cleanup_outbox";
    const candidate = "agent_backup_restore_v3_candidates";
    expect(FOUNDATION.indexOf(`CREATE TABLE IF NOT EXISTS "${cleanup}"`)).toBeLessThan(
      FOUNDATION.indexOf(`CREATE TABLE IF NOT EXISTS "${candidate}"`),
    );
    expect(tableBody(cleanup)).not.toContain(`REFERENCES "${candidate}"`);
    const leaseForeignKey = tableBody(candidate).match(
      /CONSTRAINT "agent_backup_restore_v3_candidates_lease_authority_fkey"[\s\S]*?ON DELETE RESTRICT/,
    )?.[0];
    expect(leaseForeignKey).toBeDefined();
    expect(leaseForeignKey).not.toContain('"lease_expires_at"');
    const operationParentUnique = CATALOG_SCHEMA.match(
      /v3_candidate_authority_unique:[\s\S]*?expected_manifest_sha256,[\s\S]*?\),/,
    )?.[0];
    expect(operationParentUnique).toContain(
      "agent_backup_restore_operations_v3_candidate_authority_unique",
    );
    expect(CATALOG_SCHEMA).toContain("agent_backup_restore_leases_operation_authority_unique");
  });

  test("uses scalar metadata and digest-only bearer authorities", () => {
    const ledger = tableBody("agent_backup_restore_v3_candidate_stage_ledger");
    expect(FOUNDATION).not.toMatch(/\bbytea\b/i);
    expect(ledger).not.toMatch(/"(?:entry|descriptor)_metadata"\s+jsonb/i);
    expect(ledger).toContain('"entry_path" text');
    expect(ledger).toContain('"entry_metadata_sha256" text');
    expect(ledger).toContain('"descriptor_format" text');
    expect(FOUNDATION).not.toMatch(/"execution_token"\s/);
    expect(FOUNDATION).not.toMatch(/"proof_token"\s/);
    expect(CANDIDATE_SCHEMA).not.toContain('execution_token: text("execution_token")');
    expect(CANDIDATE_SCHEMA).not.toContain('proof_token: text("proof_token")');
    expect(CANDIDATE_SCHEMA).toContain('execution_token_sha256: text("execution_token_sha256")');
    expect(CANDIDATE_SCHEMA).toContain('proof_token_sha256: text("proof_token_sha256")');
  });

  test("locks current authorities separately in canonical order", () => {
    const helper = GUARDS.slice(
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "lock_agent_backup_restore_v3_current_authority"'),
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_cleanup_outbox"'),
    );
    const orderedRelations = [
      'FROM "agent_sandbox_backups" AS backup',
      'FROM "agent_backup_restore_operations" AS operation',
      'FROM "agent_backup_restore_leases" AS lease',
      'FROM "agent_backup_catalog_authorities" AS authority',
      'FROM "agent_backup_objects" AS object',
    ];
    let previous = -1;
    for (const relation of orderedRelations) {
      const position = helper.indexOf(relation);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(helper).not.toMatch(/\bJOIN\b/i);
    expect(helper).toContain("FOR UPDATE OF backup");
    expect(GUARDS).toContain("phase\" NOT IN ('finalized', 'failed_terminal')");
    expect(GUARDS).toContain('released_at" IS NULL');
    const finalAuthorityLock = helper.indexOf("current_object_count <> p_object_count");
    const wallClockRead = helper.indexOf("observed_at := clock_timestamp()");
    const leaseExpiryCheck = helper.indexOf("current_lease_expires_at <= observed_at");
    expect(wallClockRead).toBeGreaterThan(finalAuthorityLock);
    expect(leaseExpiryCheck).toBeGreaterThan(wallClockRead);
    expect(helper).not.toContain('expires_at" > statement_timestamp()');
  });

  test("serializes permanent attempt closure before begin and GC relation locks", () => {
    expect(FOUNDATION).toContain('"agent_backup_restore_v3_candidate_gc_attempt_uidx"');
    expect(CANDIDATE_SCHEMA).toContain(
      'uniqueIndex("agent_backup_restore_v3_candidate_gc_attempt_uidx")',
    );
    expect(GUARDS).toContain("restore-v3 attempt fencing requires read committed isolation");
    const attemptLock = 'PERFORM "lock_agent_backup_restore_v3_attempt"(';
    const cleanupGuard = GUARDS.slice(
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_cleanup_outbox"'),
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_candidate"'),
    );
    const candidateGuard = GUARDS.slice(
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_candidate"'),
      GUARDS.indexOf(
        'CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_stage_ledger_insert"',
      ),
    );
    const gcGuard = GUARDS.slice(
      GUARDS.indexOf('CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_gc_tombstone"'),
      GUARDS.indexOf(
        'CREATE OR REPLACE FUNCTION "reject_agent_backup_restore_v3_gc_tombstone_mutation"',
      ),
    );
    expect(cleanupGuard.indexOf(attemptLock)).toBeLessThan(
      cleanupGuard.indexOf('SELECT 1 FROM "agent_backup_restore_v3_candidate_gc_tombstones"'),
    );
    expect(candidateGuard.indexOf(attemptLock)).toBeLessThan(
      candidateGuard.indexOf('PERFORM "lock_agent_backup_restore_v3_current_authority"'),
    );
    expect(gcGuard.indexOf(attemptLock)).toBeLessThan(
      gcGuard.indexOf('SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"'),
    );
  });

  test("recomputes receipt hashes, validates strict ledgers, and fences terminal GC", () => {
    for (const proof of [
      "sha256(convert_to(value, 'UTF8'))",
      "sealed receipt digest is not byte-exact",
      "sealed receipt top-level binding is invalid",
      "sealed component receipt differs from durable finish metadata",
      "sealed receipt aggregate differs from its durable ledger",
      "agent_backup_restore_v3_candidate_terminal_commands",
      "terminal state requires its append-only command",
      "INTERVAL '30 days'",
      "GC requires one exact terminal candidate past retention",
      "GC tombstones are permanent",
    ])
      expect(FOUNDATION + GUARDS).toContain(proof);
    expect(GUARDS.match(/BEFORE TRUNCATE/g)).toHaveLength(6);
    const oversizedIdentifiers = [...(FOUNDATION + GUARDS).matchAll(/"([A-Za-z0-9_]+)"/g)]
      .map((match) => match[1] as string)
      .filter((identifier) => identifier.length > 63);
    expect(oversizedIdentifiers).toEqual([]);
  });

  test("enforces canonical file-set paths and contiguous exact file records", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyFoundation(database);
      await applyGuards(database);
      const authority = await seedCurrentAuthority(database);
      await insertCandidate(database, authority);

      await expect(
        insertStageRecord(database, {
          componentIndex: 0,
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: 1,
          entry: {
            path: "character.json",
            fileOffsetBytes: 0,
            fileSizeBytes: 1,
            mode: 384,
            mtimeMs: 0,
          },
        }),
      ).rejects.toThrow(/command_shape_check/);
      await insertFinishedComponent(database, 0);
      await insertFinishedComponent(database, 1);

      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: 1,
          entry: null,
        }),
      ).rejects.toThrow(/command_shape_check/);
      for (const path of ["..\\secret", "C:\\x", "./x", "a//b", "a/"]) {
        await expect(
          insertStageRecord(database, {
            componentIndex: 2,
            dataIndex: 0,
            offsetBytes: 0,
            payloadBytes: 1,
            entry: { path, fileOffsetBytes: 0, fileSizeBytes: 1, mode: 384, mtimeMs: 0 },
          }),
        ).rejects.toThrow(/command_shape_check/);
      }
      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: 1,
          entry: {
            path: "unsafe-mtime",
            fileOffsetBytes: 0,
            fileSizeBytes: 1,
            mode: 384,
            mtimeMs: Number.MAX_SAFE_INTEGER + 1,
          },
        }),
      ).rejects.toThrow(/command_shape_check/);
      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: 1,
          entry: { path: "a", fileOffsetBytes: 99, fileSizeBytes: 100, mode: 384, mtimeMs: 0 },
        }),
      ).rejects.toThrow(/file-set must begin at offset zero/);

      const firstFile = {
        path: "a\tline\nbreak",
        fileOffsetBytes: 0,
        fileSizeBytes: 2,
        mode: 384,
        mtimeMs: 0,
      };
      await insertStageRecord(database, {
        componentIndex: 2,
        dataIndex: 0,
        offsetBytes: 0,
        payloadBytes: 1,
        entry: firstFile,
      });
      await expect(insertFinishedComponent(database, 2, 1, 1)).rejects.toThrow(
        /final file ended before its declared size/,
      );
      for (const entry of [
        { ...firstFile, fileOffsetBytes: 0 },
        { ...firstFile, fileOffsetBytes: 1, mode: 256 },
      ]) {
        await expect(
          insertStageRecord(database, {
            componentIndex: 2,
            dataIndex: 1,
            offsetBytes: 1,
            payloadBytes: 1,
            entry,
          }),
        ).rejects.toThrow(/file metadata or offset changed within one file/);
      }
      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 1,
          offsetBytes: 1,
          payloadBytes: 0,
          entry: { path: "b", fileOffsetBytes: 0, fileSizeBytes: 0, mode: 384, mtimeMs: 0 },
        }),
      ).rejects.toThrow(/file ended before its declared size/);
      await insertStageRecord(database, {
        componentIndex: 2,
        dataIndex: 1,
        offsetBytes: 1,
        payloadBytes: 1,
        entry: { ...firstFile, fileOffsetBytes: 1 },
      });

      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 2,
          offsetBytes: 2,
          payloadBytes: 0,
          entry: { path: "A", fileOffsetBytes: 0, fileSizeBytes: 0, mode: 384, mtimeMs: 0 },
        }),
      ).rejects.toThrow(/file paths must be unique and byte ordered/);
      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 2,
          offsetBytes: 2,
          payloadBytes: 1,
          entry: { path: "b", fileOffsetBytes: 1, fileSizeBytes: 2, mode: 384, mtimeMs: 0 },
        }),
      ).rejects.toThrow(/new file must begin at offset zero/);
      const emptyFile = {
        path: "b",
        fileOffsetBytes: 0,
        fileSizeBytes: 0,
        mode: 384,
        mtimeMs: 0,
      };
      await insertStageRecord(database, {
        componentIndex: 2,
        dataIndex: 2,
        offsetBytes: 2,
        payloadBytes: 0,
        entry: emptyFile,
      });
      await expect(
        insertStageRecord(database, {
          componentIndex: 2,
          dataIndex: 3,
          offsetBytes: 2,
          payloadBytes: 0,
          entry: emptyFile,
        }),
      ).rejects.toThrow(/file record made no canonical progress/);
      await insertFinishedComponent(database, 2, 2, 3);

      const ledger = await database.query<{
        command_kind: string;
        data_index: number | null;
        entry_path: string | null;
        entry_file_offset_bytes: string | null;
        payload_bytes: string;
      }>(`SELECT command_kind, data_index, entry_path,
        entry_file_offset_bytes::text, payload_bytes::text
        FROM agent_backup_restore_v3_candidate_stage_ledger
        WHERE candidate_id = '${IDS.candidate}' AND component_index = 2
        ORDER BY CASE WHEN command_kind = 'record' THEN 0 ELSE 1 END,
          data_index NULLS LAST`);
      expect(ledger.rows).toEqual([
        {
          command_kind: "record",
          data_index: 0,
          entry_path: "a\tline\nbreak",
          entry_file_offset_bytes: "0",
          payload_bytes: "1",
        },
        {
          command_kind: "record",
          data_index: 1,
          entry_path: "a\tline\nbreak",
          entry_file_offset_bytes: "1",
          payload_bytes: "1",
        },
        {
          command_kind: "record",
          data_index: 2,
          entry_path: "b",
          entry_file_offset_bytes: "0",
          payload_bytes: "0",
        },
        {
          command_kind: "finish",
          data_index: null,
          entry_path: null,
          entry_file_offset_bytes: null,
          payload_bytes: "2",
        },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("replays and enforces begin, authorization, and seal against live authority", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyFoundation(database);
      await applyGuards(database);
      await applyFoundation(database);
      await applyGuards(database);
      const authority = await seedCurrentAuthority(database);
      await expectBeginRejected(
        database,
        authority,
        `UPDATE agent_sandbox_backups SET catalog_state = 'deleted'`,
        /source backup authority is no longer current/,
      );
      await expectBeginRejected(
        database,
        authority,
        `UPDATE agent_backup_restore_operations SET phase = 'finalized'`,
        /operation authority is no longer open/,
      );
      await expectBeginRejected(
        database,
        authority,
        `UPDATE agent_backup_restore_leases SET released_at = statement_timestamp()`,
        /lease authority is released, stale, or expired/,
      );
      await expectBeginRejected(
        database,
        authority,
        `UPDATE agent_backup_catalog_authorities SET catalog_revision = 10`,
        /catalogue epoch is stale/,
      );
      await expectBeginRejected(
        database,
        authority,
        `UPDATE agent_backup_objects SET state = 'present' WHERE id = '${OBJECT_IDS[0]}'`,
        /source object differs from current catalogue authority/,
      );
      const typedSourceCanonical = authority.sourceCanonical.replace(
        '"componentIndex":0',
        '"componentIndex":"0"',
      );
      expect(typedSourceCanonical).not.toBe(authority.sourceCanonical);
      await expect(
        insertCandidate(database, {
          sourceCanonical: typedSourceCanonical,
          sourceSha256: sha256(typedSourceCanonical),
        }),
      ).rejects.toThrow(/source object structure is invalid/);

      await insertCandidate(database, authority);
      const held = await database.query<{ state: string }>(
        `SELECT state FROM agent_backup_restore_v3_candidate_cleanup_outbox`,
      );
      expect(held.rows).toEqual([{ state: "held" }]);
      await expect(
        database.query(
          `INSERT INTO agent_backup_restore_v3_candidate_stage_ledger (
          candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
          operation_id, execution_token_sha256, command_kind, component_index,
          component_name, data_index, offset_bytes, entry_path, entry_file_offset_bytes,
          entry_file_size_bytes, entry_mode, entry_mtime_ms, entry_metadata_sha256,
          payload_bytes, payload_sha256, command_sha256, receipt_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'record', 0, $8, 0, 0,
          '../secret', 0, 1, 384, 0, $9, 1, $10, $11, $12)`,
          [
            IDS.candidate,
            IDS.organization,
            IDS.agent,
            IDS.backup,
            IDS.restoreAttempt,
            IDS.operation,
            EXECUTION_TOKEN_SHA256,
            AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[0],
            sha256("entry"),
            sha256("payload"),
            sha256("record-command"),
            sha256("record-receipt"),
          ],
        ),
      ).rejects.toThrow(/command_shape_check/);
      await insertFinishedComponents(database);
      await database.exec(`UPDATE agent_backup_restore_leases
        SET expires_at = statement_timestamp() + INTERVAL '120 minutes'`);
      const leaseForeignKey = await database.query<{ definition: string }>(`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'agent_backup_restore_v3_candidates_lease_authority_fkey'`);
      expect(leaseForeignKey.rows[0]?.definition).not.toContain("lease_expires_at");

      const receiptCanonical = canonicalizeAgentBackupRestoreV3CandidateReceipt(
        candidateReceipt(authority.sourceSha256),
      );
      const receiptSha256 = sha256(receiptCanonical);
      await database.exec("BEGIN");
      try {
        await database.exec(`UPDATE agent_backup_catalog_authorities SET catalog_revision = 10`);
        await expect(
          insertAuthorization(database, IDS.authorization, receiptSha256),
        ).rejects.toThrow(/catalogue epoch is stale/);
      } finally {
        await database.exec("ROLLBACK");
      }

      await database.exec("BEGIN");
      try {
        const divergentSha = "2".repeat(64);
        await insertAuthorization(database, IDS.authorization, divergentSha);
        await expect(
          insertSealCommand(
            database,
            IDS.terminal,
            IDS.authorization,
            receiptCanonical,
            divergentSha,
          ),
        ).rejects.toThrow(/sealed receipt digest is not byte-exact/);
      } finally {
        await database.exec("ROLLBACK");
      }

      await database.exec("BEGIN");
      try {
        const emptyCanonical = "{}";
        const emptySha = sha256(emptyCanonical);
        await insertAuthorization(database, IDS.authorization, emptySha);
        await expect(
          insertSealCommand(database, IDS.terminal, IDS.authorization, emptyCanonical, emptySha),
        ).rejects.toThrow(/sealed receipt top-level binding is invalid/);
      } finally {
        await database.exec("ROLLBACK");
      }

      await database.exec("BEGIN");
      try {
        const typedReceiptCanonical = receiptCanonical.replace(
          '"objectCount":5',
          '"objectCount":"5"',
        );
        expect(typedReceiptCanonical).not.toBe(receiptCanonical);
        const typedReceiptSha = sha256(typedReceiptCanonical);
        await insertAuthorization(database, IDS.authorization, typedReceiptSha);
        await expect(
          insertSealCommand(
            database,
            IDS.terminal,
            IDS.authorization,
            typedReceiptCanonical,
            typedReceiptSha,
          ),
        ).rejects.toThrow(/sealed receipt top-level binding is invalid/);
      } finally {
        await database.exec("ROLLBACK");
      }

      await insertAuthorization(database, IDS.authorization, receiptSha256);
      const sealMutations = [
        {
          invalidate: `UPDATE agent_sandbox_backups SET catalog_state = 'deleted'`,
          restore: `UPDATE agent_sandbox_backups SET catalog_state = 'protected'`,
          error: /source backup authority is no longer current/,
        },
        {
          invalidate: `UPDATE agent_backup_restore_operations SET phase = 'finalized'`,
          restore: `UPDATE agent_backup_restore_operations SET phase = 'reserved'`,
          error: /operation authority is no longer open/,
        },
        {
          invalidate: `UPDATE agent_backup_restore_leases SET released_at = statement_timestamp()`,
          restore: `UPDATE agent_backup_restore_leases SET released_at = NULL`,
          error: /lease authority is released, stale, or expired/,
        },
        {
          invalidate: `UPDATE agent_backup_catalog_authorities SET catalog_revision = 10`,
          restore: `UPDATE agent_backup_catalog_authorities SET catalog_revision = 9`,
          error: /catalogue epoch is stale/,
        },
        {
          invalidate: `UPDATE agent_backup_objects SET state = 'present' WHERE id = '${OBJECT_IDS[0]}'`,
          restore: `UPDATE agent_backup_objects SET state = 'verified' WHERE id = '${OBJECT_IDS[0]}'`,
          error: /source object differs from current catalogue authority/,
        },
      ];
      for (const mutation of sealMutations) {
        await database.exec(mutation.invalidate);
        await expect(
          insertSealCommand(
            database,
            IDS.terminal,
            IDS.authorization,
            receiptCanonical,
            receiptSha256,
          ),
        ).rejects.toThrow(mutation.error);
        await database.exec(mutation.restore);
      }
      await insertSealCommand(
        database,
        IDS.terminal,
        IDS.authorization,
        receiptCanonical,
        receiptSha256,
      );
      const terminal = await database.query<{
        state: string;
        receipt: string;
        payload: string;
        records: number;
        authorization_state: string;
      }>(`
        SELECT candidate.state, candidate.sealed_receipt_sha256 AS receipt,
          candidate.sealed_staged_payload_bytes::text AS payload,
          candidate.sealed_staged_data_record_count AS records,
          seal_authorization.state AS authorization_state
        FROM agent_backup_restore_v3_candidates AS candidate
        JOIN agent_backup_restore_v3_candidate_seal_authorizations AS seal_authorization
          ON seal_authorization.candidate_id = candidate.id`);
      expect(terminal.rows).toEqual([
        {
          state: "sealed",
          receipt: receiptSha256,
          payload: "0",
          records: 0,
          authorization_state: "consumed",
        },
      ]);
      await expect(
        database.exec(`UPDATE agent_backup_restore_v3_candidates SET state = 'aborted'`),
      ).rejects.toThrow(/candidate is terminal/);
      await expect(
        database.exec(`UPDATE agent_backup_restore_v3_candidate_seal_authorizations
        SET state = 'revoked'`),
      ).rejects.toThrow(/authorization is terminal/);
      await expect(database.exec(`DELETE FROM agent_backup_restore_v3_candidates`)).rejects.toThrow(
        /candidate cannot be deleted/,
      );
      await expect(
        database.exec(`TRUNCATE agent_backup_restore_v3_candidate_stage_ledger`),
      ).rejects.toThrow(/cannot be truncated/);
      const retention = await database.query<{ retention_until: string }>(
        `SELECT retention_until::text FROM agent_backup_restore_v3_candidates`,
      );
      await expect(
        database.query(
          `INSERT INTO agent_backup_restore_v3_candidate_gc_tombstones (
          id, candidate_id, cleanup_outbox_id, organization_id, agent_id, backup_id,
          restore_attempt_id, operation_id, terminal_state, terminal_evidence_sha256,
          retention_until, gc_command_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sealed', $9, $10, $11)`,
          [
            IDS.gc,
            IDS.candidate,
            IDS.cleanup,
            IDS.organization,
            IDS.agent,
            IDS.backup,
            IDS.restoreAttempt,
            IDS.operation,
            receiptSha256,
            retention.rows[0]?.retention_until,
            sha256("gc-command"),
          ],
        ),
      ).rejects.toThrow(/past retention/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("permits only a cleanup-proven terminal GC and preserves its tombstone", async () => {
    const database = await prerequisiteDatabase();
    try {
      await applyFoundation(database);
      const authority = await seedCurrentAuthority(database);
      await database.exec(`UPDATE agent_backup_restore_v3_candidate_cleanup_outbox
        SET state = 'completed', receipt_sha256 = '${sha256("cleanup-receipt")}',
          completed_at = statement_timestamp()`);
      await database.query(
        `INSERT INTO agent_backup_restore_v3_candidates (
          id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
          restore_operation_id, lease_id, lease_owner_id, lease_generation,
          lease_expires_at, catalog_epoch, source_copy_role, source_activation_generation,
          source_lifecycle_revision, expected_manifest_sha256, key_bundle_generation_id,
          source_authority_canonical, source_authority_sha256, object_count,
          cleanup_outbox_id, execution_token_sha256, state, abort_reason_sha256,
          aborted_at, retention_until
        ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, 'restore-worker', $9, lease.expires_at,
          9, 'primary', $10, 7, $11, $12, $13, $14, 5, $15, $16, 'aborted', $17,
          statement_timestamp() - INTERVAL '40 days', statement_timestamp() - INTERVAL '10 days'
        FROM agent_backup_restore_leases AS lease WHERE lease.id = $8`,
        [
          IDS.candidate,
          IDS.organization,
          IDS.agent,
          IDS.backup,
          IDS.restoreAttempt,
          IDS.operation,
          IDS.restoreOperation,
          IDS.lease,
          IDS.leaseGeneration,
          IDS.sourceGeneration,
          MANIFEST_SHA256,
          IDS.keyBundleGeneration,
          authority.sourceCanonical,
          authority.sourceSha256,
          IDS.cleanup,
          EXECUTION_TOKEN_SHA256,
          ABORT_REASON_SHA256,
        ],
      );
      await database.exec(`INSERT INTO agent_backup_restore_v3_candidate_terminal_commands (
        id, candidate_id, organization_id, agent_id, backup_id, restore_attempt_id,
        operation_id, execution_token_sha256, command_kind, abort_reason_sha256, command_sha256)
        VALUES ('${IDS.terminal}', '${IDS.candidate}', '${IDS.organization}', '${IDS.agent}',
          '${IDS.backup}', '${IDS.restoreAttempt}', '${IDS.operation}',
          '${EXECUTION_TOKEN_SHA256}', 'abort', '${ABORT_REASON_SHA256}', '${COMMAND_SHA256}')`);
      await applyGuards(database);
      await database.exec(`INSERT INTO agent_backup_restore_v3_candidate_gc_tombstones (
        id, candidate_id, cleanup_outbox_id, organization_id, agent_id, backup_id,
        restore_attempt_id, operation_id, terminal_state, terminal_evidence_sha256,
        retention_until, gc_command_sha256)
        SELECT '${IDS.gc}', candidate.id, candidate.cleanup_outbox_id,
          candidate.organization_id, candidate.agent_id, candidate.backup_id,
          candidate.restore_attempt_id, candidate.operation_id, candidate.state,
          candidate.abort_reason_sha256, candidate.retention_until, '${sha256("gc-command")}'
        FROM agent_backup_restore_v3_candidates AS candidate
        WHERE candidate.id = '${IDS.candidate}'`);
      const remaining = await database.query<{
        candidates: number;
        cleanups: number;
        commands: number;
        tombstone_state: string;
      }>(`
        SELECT (SELECT count(*)::integer FROM agent_backup_restore_v3_candidates) AS candidates,
          (SELECT count(*)::integer FROM agent_backup_restore_v3_candidate_cleanup_outbox)
            AS cleanups,
          (SELECT count(*)::integer FROM agent_backup_restore_v3_candidate_terminal_commands)
            AS commands,
          (SELECT state FROM agent_backup_restore_v3_candidate_gc_tombstones) AS tombstone_state`);
      expect(remaining.rows).toEqual([
        { candidates: 0, cleanups: 0, commands: 0, tombstone_state: "completed" },
      ]);
      await expect(
        database.exec(`DELETE FROM agent_backup_restore_v3_candidate_gc_tombstones`),
      ).rejects.toThrow(/GC tombstones are permanent/);
      const replayCleanupId = "00000000-0000-4000-8000-00000000a101";
      const replayCandidateId = "00000000-0000-4000-8000-00000000a102";
      await expect(
        database.query(
          `INSERT INTO agent_backup_restore_v3_candidate_cleanup_outbox (
            id, organization_id, agent_id, backup_id, restore_attempt_id, operation_id,
            cleanup_command_sha256
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            replayCleanupId,
            IDS.organization,
            IDS.agent,
            IDS.backup,
            IDS.restoreAttempt,
            IDS.operation,
            sha256("replayed-cleanup-command"),
          ],
        ),
      ).rejects.toThrow(/restore attempt is permanently closed by GC tombstone/);
      await expect(
        insertCandidate(database, authority, {
          candidateId: replayCandidateId,
          cleanupId: replayCleanupId,
          executionTokenSha256: sha256("replayed-execution-token"),
        }),
      ).rejects.toThrow(/restore attempt is permanently closed by GC tombstone/);
      const afterReplay = await database.query<{
        candidates: number;
        cleanups: number;
        tombstones: number;
      }>(`SELECT
        (SELECT count(*)::integer FROM agent_backup_restore_v3_candidates) AS candidates,
        (SELECT count(*)::integer FROM agent_backup_restore_v3_candidate_cleanup_outbox)
          AS cleanups,
        (SELECT count(*)::integer FROM agent_backup_restore_v3_candidate_gc_tombstones)
          AS tombstones`);
      expect(afterReplay.rows).toEqual([{ candidates: 0, cleanups: 0, tombstones: 1 }]);
    } finally {
      await database.close();
    }
  }, 60_000);
});

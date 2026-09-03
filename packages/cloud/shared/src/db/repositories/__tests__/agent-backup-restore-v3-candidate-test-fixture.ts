/** Shared minimal authority fixture for restore-v3 candidate repository proofs. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  type AgentBackupRestoreV3AuthorityFence,
  type AgentBackupRestoreV3SourceAuthority,
  createAgentBackupManifestV3,
} from "@elizaos/shared";

export const CANDIDATE_IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  agent: "10000000-0000-4000-8000-000000000002",
  backup: "10000000-0000-4000-8000-000000000003",
  operation: "10000000-0000-4000-8000-000000000004",
  sourceGeneration: "10000000-0000-4000-8000-000000000005",
  restoreAttempt: "10000000-0000-4000-8000-000000000006",
  lease: "10000000-0000-4000-8000-000000000007",
  leaseGeneration: "10000000-0000-4000-8000-000000000008",
  restoreOperation: "10000000-0000-4000-8000-000000000009",
  keyBundleGeneration: "10000000-0000-4000-8000-00000000000a",
  vaultGeneration: "10000000-0000-4000-8000-00000000000b",
  sourceNodeRecord: "10000000-0000-4000-8000-00000000000c",
  sourceNodeIncarnation: "10000000-0000-4000-8000-00000000000d",
} as const;

export const CANDIDATE_OBJECT_IDS = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(
  (_, index) => `10000000-0000-4000-8000-${String(0x101 + index).padStart(12, "0")}`,
);

export const FIXTURE_SHA256 = "a".repeat(64);

export function fixtureSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CandidateFixture {
  readonly manifest: AgentBackupManifestV3;
  readonly sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  readonly authority: AgentBackupRestoreV3AuthorityFence;
  readonly leaseExpiresAt: Date;
}

export interface CandidateFixtureQueryClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  exec?(text: string): Promise<unknown>;
}

function emptyComponent(
  name: (typeof AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS)[number],
): AgentBackupManifestV3Draft["components"][number] {
  return {
    name,
    format: "raw-v1",
    compression: "none",
    payloadContentHmacSha256: FIXTURE_SHA256,
    state: { kind: "full", resultContentHmacSha256: FIXTURE_SHA256 },
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    chunks: [],
  };
}

export async function buildCandidateFixture(): Promise<CandidateFixture> {
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 3,
    operationId: CANDIDATE_IDS.operation,
    createdAt: "2026-08-30T00:00:00.000Z",
    identity: {
      organizationId: CANDIDATE_IDS.organization,
      agentId: CANDIDATE_IDS.agent,
      activationGeneration: CANDIDATE_IDS.sourceGeneration,
      lifecycleRevision: "7",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: CANDIDATE_IDS.sourceNodeRecord,
      nodeIncarnation: CANDIDATE_IDS.sourceNodeIncarnation,
      nodeId: "restore-v3-candidate-source",
      containerId: "c".repeat(64),
    },
    runtime: {
      imageDigest: `sha256:${FIXTURE_SHA256}`,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
    components: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(emptyComponent),
    watermarks: [{ namespace: "database.lsn", value: "0/1" }],
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: CANDIDATE_IDS.vaultGeneration,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: FIXTURE_SHA256,
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
      kms: {
        provider: "steward",
        keyId: `org:${CANDIDATE_IDS.organization}/dek/v1`,
        keyVersion: 1,
      },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: CANDIDATE_IDS.keyBundleGeneration,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${CANDIDATE_IDS.operation}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: FIXTURE_SHA256,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: FIXTURE_SHA256,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: FIXTURE_SHA256,
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
  const leaseExpiresAt = new Date(Date.now() + 600_000);
  const sourceAuthority: AgentBackupRestoreV3SourceAuthority = {
    derivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    organizationId: CANDIDATE_IDS.organization,
    agentId: CANDIDATE_IDS.agent,
    backupId: CANDIDATE_IDS.backup,
    operationId: CANDIDATE_IDS.operation,
    sourceActivationGeneration: CANDIDATE_IDS.sourceGeneration,
    sourceLifecycleRevision: "7",
    expectedManifestSha256: manifest.integrity.manifestSha256,
    copyRole: "primary",
    catalogEpoch: "9",
    objects: AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, index) => ({
      objectId: CANDIDATE_OBJECT_IDS[index] as string,
      componentIndex: index,
      componentName,
      chunkIndex: 0,
      copyRole: "primary" as const,
      contentHmacSha256: fixtureSha256(`content-${index}`),
      catalog: {
        transport: "worker-r2" as const,
        provider: "cloudflare-r2" as const,
        endpointIdentityFingerprint: `sha256:${fixtureSha256(`endpoint-identity-${index}`)}`,
        endpointAliasFingerprint: `sha256:${fixtureSha256(`endpoint-alias-${index}`)}`,
        bucketFingerprint: `sha256:${fixtureSha256(`bucket-${index}`)}`,
        regionFingerprint: `sha256:${fixtureSha256(`region-${index}`)}`,
        keyFingerprint: `sha256:${fixtureSha256(`key-${index}`)}`,
        providerVersionId: `version-${index}`,
        providerEtag: null,
        providerChecksum: null,
        uploadReceiptDigest: fixtureSha256(`upload-${index}`),
        ciphertextSha256: fixtureSha256(`ciphertext-${index}`),
        sizeBytes: index + 1,
      },
    })),
  };
  const authority: AgentBackupRestoreV3AuthorityFence = {
    organizationId: CANDIDATE_IDS.organization,
    agentId: CANDIDATE_IDS.agent,
    backupId: CANDIDATE_IDS.backup,
    operationId: CANDIDATE_IDS.operation,
    sourceActivationGeneration: CANDIDATE_IDS.sourceGeneration,
    sourceLifecycleRevision: "7",
    expectedManifestSha256: manifest.integrity.manifestSha256,
    copyRole: "primary",
    restoreAttemptId: CANDIDATE_IDS.restoreAttempt,
    leaseId: CANDIDATE_IDS.lease,
    ownerId: "restore-v3-worker",
    fencingToken: CANDIDATE_IDS.leaseGeneration,
    catalogEpoch: "9",
    leaseExpiresAtEpochMs: leaseExpiresAt.getTime(),
  };
  return Object.freeze({ manifest, sourceAuthority, authority, leaseExpiresAt });
}

export async function createCandidatePrerequisiteSchema(
  client: CandidateFixtureQueryClient,
): Promise<void> {
  const source = `
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
  `;
  if (client.exec) await client.exec(source);
  else await client.query(source);
}

async function applyMigration(
  client: CandidateFixtureQueryClient,
  migrationName: string,
): Promise<void> {
  const source = await readFile(
    new URL(`../../migrations/${migrationName}.sql`, import.meta.url),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

export async function applyCandidateMigrations(client: CandidateFixtureQueryClient): Promise<void> {
  await applyMigration(client, "0376_agent_backup_restore_v3_candidates");
  await applyMigration(client, "0377_agent_backup_restore_v3_candidate_guards");
}

export async function seedCandidateAuthority(
  client: CandidateFixtureQueryClient,
  fixture: CandidateFixture,
): Promise<void> {
  await client.query(`INSERT INTO organizations (id) VALUES ($1)`, [CANDIDATE_IDS.organization]);
  await client.query(
    `INSERT INTO agent_backup_catalog_authorities
      (organization_id, agent_id, catalog_revision) VALUES ($1, $2, 9)`,
    [CANDIDATE_IDS.organization, CANDIDATE_IDS.agent],
  );
  await client.query(
    `INSERT INTO agent_sandbox_backups (
      id, catalog_organization_id, catalog_agent_id, backup_operation_id,
      lifecycle_generation, lifecycle_revision, manifest_digest,
      operation_key_bundle_generation_id, catalog_state, manifest_version
    ) VALUES ($1, $2, $3, $4, $5, 7, $6, $7, 'protected', 3)`,
    [
      CANDIDATE_IDS.backup,
      CANDIDATE_IDS.organization,
      CANDIDATE_IDS.agent,
      CANDIDATE_IDS.operation,
      CANDIDATE_IDS.sourceGeneration,
      fixture.manifest.integrity.manifestSha256,
      CANDIDATE_IDS.keyBundleGeneration,
    ],
  );
  await client.query(
    `INSERT INTO agent_backup_restore_leases (
      id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
      generation, catalog_epoch, copy_role, operation_id, activation_generation,
      lifecycle_revision, expected_manifest_sha256, expires_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, 'restore-v3-worker', $6, 9, 'primary', $7, $8,
      7, $9, $10, clock_timestamp() - INTERVAL '1 minute')`,
    [
      CANDIDATE_IDS.lease,
      CANDIDATE_IDS.organization,
      CANDIDATE_IDS.agent,
      CANDIDATE_IDS.backup,
      CANDIDATE_IDS.restoreAttempt,
      CANDIDATE_IDS.leaseGeneration,
      CANDIDATE_IDS.operation,
      CANDIDATE_IDS.sourceGeneration,
      fixture.manifest.integrity.manifestSha256,
      fixture.leaseExpiresAt,
    ],
  );
  await client.query(
    `INSERT INTO agent_backup_restore_operations (
      id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
      lease_owner_id, lease_generation, catalog_epoch, copy_role,
      expected_operation_id, expected_activation_generation,
      expected_lifecycle_revision, expected_manifest_sha256, phase
    ) VALUES ($1, $2, $3, $4, $5, $6, 'restore-v3-worker', $7, 9, 'primary',
      $8, $9, 7, $10, 'reserved')`,
    [
      CANDIDATE_IDS.restoreOperation,
      CANDIDATE_IDS.organization,
      CANDIDATE_IDS.agent,
      CANDIDATE_IDS.backup,
      CANDIDATE_IDS.restoreAttempt,
      CANDIDATE_IDS.lease,
      CANDIDATE_IDS.leaseGeneration,
      CANDIDATE_IDS.operation,
      CANDIDATE_IDS.sourceGeneration,
      fixture.manifest.integrity.manifestSha256,
    ],
  );
  for (const [index, componentName] of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.entries()) {
    await client.query(
      `INSERT INTO agent_backup_objects (
        id, organization_id, backup_id, copy_role, component, chunk_index, state,
        provider_write_started, verified_at, content_hmac_sha256, transport, provider,
        endpoint_identity_fingerprint, endpoint_alias, bucket, region, key_fingerprint,
        provider_version_id, provider_etag, provider_checksum, upload_receipt_digest,
        ciphertext_sha256, size_bytes
      ) VALUES ($1, $2, $3, 'primary', $4, 0, 'verified', TRUE, clock_timestamp(),
        $5, 'worker-r2', 'cloudflare-r2', $6, $7, $8, $9, $10, $11, NULL, NULL,
        $12, $13, $14)`,
      [
        CANDIDATE_OBJECT_IDS[index],
        CANDIDATE_IDS.organization,
        CANDIDATE_IDS.backup,
        componentName,
        fixtureSha256(`content-${index}`),
        `sha256:${fixtureSha256(`endpoint-identity-${index}`)}`,
        `endpoint-alias-${index}`,
        `bucket-${index}`,
        `region-${index}`,
        fixtureSha256(`key-${index}`),
        `version-${index}`,
        fixtureSha256(`upload-${index}`),
        fixtureSha256(`ciphertext-${index}`),
        index + 1,
      ],
    );
  }
}

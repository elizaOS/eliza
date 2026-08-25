/**
 * Real-PGlite proofs for durable, one-shot sandbox replacement authority.
 * pushSchema supplies the table and a test-local trigger exercises immutable
 * guards that Drizzle's schema DSL cannot represent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  createAgentBackupManifestV3,
} from "@elizaos/shared";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { hashAgentActivationEndpointEnvelope } from "../../../lib/services/agent-activation-endpoint-authority";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../schemas/agent-backup-catalog";
import { agentActivationPublications } from "../../schemas/agent-backup-restore-history";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "../../schemas/agent-sandbox-replacement-attempts";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import {
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
} from "../../schemas/agent-vault-key-authority";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import {
  claimAgentBackupRestoreOperation,
  openAgentBackupRestoreOperation,
  reserveAgentBackupRestoreTarget,
} from "../agent-backup-restore-operations";
import {
  type AdmitAndStartAgentSandboxReplacementInput,
  type AgentSandboxReplacementAttemptReference,
  type AgentSandboxReplacementCapacityIntent,
  type AgentSandboxReplacementLocatorInput,
  type AgentSandboxReplacementRestoreAuthority,
  admitAndStartAgentSandboxReplacementInTransaction,
  type CommitAgentSandboxReplacementLifecycleAdoptionInput,
  commitAgentSandboxReplacementLifecycleAdoptionInTransaction,
  getAgentSandboxReplacementAttempt,
  recordAgentSandboxReplacementCleanupProvenInTransaction,
  recordAgentSandboxReplacementCreated,
  recordAgentSandboxReplacementCreatedInTransaction,
  recordAgentSandboxReplacementIntentInTransaction,
  recordAgentSandboxReplacementPreviousCleanupProvenInTransaction,
  recordAgentSandboxReplacementProviderSucceeded,
  recordAgentSandboxReplacementVpnRegistered,
  recordAgentSandboxReplacementVpnRegisteredInTransaction,
  type StartAgentSandboxReplacementAttemptInput,
  startAgentSandboxReplacementAttemptInTransaction,
} from "../agent-sandbox-replacement-attempts";

const TIMEOUT = 120_000;
const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000a001";
const AGENT_ID = "00000000-0000-4000-8000-00000000a002";
const USER_ID = "00000000-0000-4000-8000-00000000a022";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-00000000a023";
const ATTEMPT_ID = "00000000-0000-4000-8000-00000000a003";
const OTHER_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a004";
const THIRD_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a025";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a005";
const NEXT_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a027";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000a006";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000a030";
const NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000a031";
const OTHER_NODE_INCARNATION = "00000000-0000-4000-8000-00000000a032";
const OTHER_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000a033";
const ABA_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000a034";
const PREVIOUS_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000a035";
const PREVIOUS_NODE_INCARNATION = "00000000-0000-4000-8000-00000000a036";
const PREVIOUS_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000a037";
const PREVIOUS_REBOOT_INCARNATION = "00000000-0000-4000-8000-00000000a038";
const PREVIOUS_REBOOT_HISTORY_ID = "00000000-0000-4000-8000-00000000a039";
const ACTIVATION_PUBLICATION_ID = "00000000-0000-4000-8000-00000000a040";
const NEXT_ACTIVATION_PUBLICATION_ID = "00000000-0000-4000-8000-00000000a041";
const REUSED_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000a050";
const REUSED_NODE_INCARNATION = "00000000-0000-4000-8000-00000000a051";
const REUSED_NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000a052";
const LIFECYCLE_JOB_ID = "00000000-0000-4000-8000-00000000a007";
const LIFECYCLE_EXECUTION_GENERATION = "00000000-0000-4000-8000-00000000a008";
const NEXT_LIFECYCLE_JOB_ID = "00000000-0000-4000-8000-00000000a028";
const NEXT_LIFECYCLE_EXECUTION_GENERATION = "00000000-0000-4000-8000-00000000a029";
const BACKUP_ID = "00000000-0000-4000-8000-00000000a009";
const BACKUP_OPERATION_ID = "00000000-0000-4000-8000-00000000a00a";
const BACKUP_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a00b";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a00c";
const RESTORE_LEASE_ID = "00000000-0000-4000-8000-00000000a00d";
const RESTORE_FENCE = "00000000-0000-4000-8000-00000000a00e";
const REPLACEMENT_RESTORE_CLAIM = "00000000-0000-4000-8000-00000000a026";
const AGED_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a012";
const CONTAINER_ID = "a".repeat(64);
const PREVIOUS_CONTAINER_ID = "e".repeat(64);
const BACKUP_DIGEST = "9".repeat(64);
const PROVIDER_DIGEST = "b".repeat(64);
const LIFECYCLE_DIGEST = "c".repeat(64);
const CLEANUP_DIGEST = "d".repeat(64);
const RESTORE_HANDOFF_DIGEST = "7".repeat(64);
const IMAGE_DIGEST = `sha256:${"6".repeat(64)}`;
const CONTAINER_NAME = `agent-${AGENT_ID}`;
const ACTIVE_RESTORE_ENDPOINT = Object.freeze({
  version: 1,
  generation: ACTIVATION_GENERATION,
  kind: "dedicated-sandbox",
  serverName: `sandbox-${ACTIVATION_GENERATION}`,
  registryUrl: `https://sandbox-${ACTIVATION_GENERATION}.example.test/api`,
  bridgeUrl: "http://100.64.0.5:3000",
  healthUrl: "http://100.64.0.5:3000/health",
} as const);
const ACTIVE_RESTORE_ENDPOINT_SHA256 = hashAgentActivationEndpointEnvelope(ACTIVE_RESTORE_ENDPOINT);
let restoreManifestFixture: Readonly<{ canonicalDraft: string; digest: string }>;

function activationPublicationFixture(input: {
  id: string;
  generation: string;
  lifecycleRevision: number;
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  nodeHistoryId: string;
  containerId: string;
}) {
  return {
    id: input.id,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    activation_generation: input.generation,
    previous_activation_generation:
      input.generation === ACTIVATION_GENERATION ? null : ACTIVATION_GENERATION,
    lifecycle_revision: BigInt(input.lifecycleRevision),
    purpose: "provision" as const,
    backup_id: null,
    backup_manifest_sha256: null,
    activation_receipt: {
      schemaVersion: 1 as const,
      generation: input.generation,
      purpose: "provision" as const,
      agentId: AGENT_ID,
      organizationId: ORGANIZATION_ID,
      lifecycleRevision: input.lifecycleRevision.toString(),
      backupId: null,
      backupHash: null,
      manifestHash: null,
      componentHashes: null,
      freshAuthorization: {
        kind: "no_backup" as const,
        lifecycleRevision: input.lifecycleRevision.toString(),
        headBackupId: null,
        headBackupHash: null,
      },
      containerId: input.containerId,
      imageDigest: IMAGE_DIGEST,
      receiptId: input.id,
      receiptHash: "4".repeat(64),
      receiptMac: "5".repeat(64),
      appliedAt: "2026-08-23T11:55:00.000Z",
      restored: true as const,
      requiresRestart: false,
    },
    activation_receipt_sha256: "4".repeat(64),
    container_id: input.containerId,
    node_history_id: input.nodeHistoryId,
    docker_node_record_id: input.nodeRecordId,
    node_id: input.nodeId,
    node_incarnation: input.nodeIncarnation,
    image_digest: IMAGE_DIGEST,
    token_sha256: "1".repeat(64),
    funding_revision: 1n,
    published_at: new Date("2026-08-23T11:55:00.000Z"),
  };
}

async function buildRestoreManifestFixture(): Promise<typeof restoreManifestFixture> {
  const emptyComponent = (name: "character" | "database" | "media" | "state-files" | "vault") => ({
    name,
    format: "raw-v1",
    compression: "none" as const,
    payloadContentHmacSha256: BACKUP_DIGEST,
    state: { kind: "full" as const, resultContentHmacSha256: BACKUP_DIGEST },
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    chunks: [],
  });
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 3,
    operationId: BACKUP_OPERATION_ID,
    createdAt: "2026-08-20T00:00:00.000Z",
    identity: {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      activationGeneration: BACKUP_ACTIVATION_GENERATION,
      lifecycleRevision: "6",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: "00000000-0000-4000-8000-00000000a00f",
      nodeId: "backup-source-node",
      containerId: "8".repeat(64),
    },
    runtime: {
      imageDigest: `sha256:${BACKUP_DIGEST}`,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
    components: [
      emptyComponent("character"),
      emptyComponent("database"),
      emptyComponent("media"),
      emptyComponent("state-files"),
      emptyComponent("vault"),
    ],
    watermarks: [{ namespace: "database.lsn", value: "0/1" }],
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: "00000000-0000-4000-8000-00000000a011",
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: BACKUP_DIGEST,
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
      kms: { provider: "steward", keyId: `org:${ORGANIZATION_ID}/dek/v1`, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: "00000000-0000-4000-8000-00000000a010",
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: BACKUP_DIGEST,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: BACKUP_DIGEST,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: BACKUP_DIGEST,
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
  return Object.freeze({
    canonicalDraft: canonicalizeAgentBackupManifestV3(draft),
    digest: manifest.integrity.manifestSha256,
  });
}

async function startAgentSandboxReplacementAttempt(
  input: StartAgentSandboxReplacementAttemptInput,
) {
  return await dbWrite.transaction((tx) =>
    startAgentSandboxReplacementAttemptInTransaction(tx, input),
  );
}

async function recordAgentSandboxReplacementIntent(
  attemptReference: AgentSandboxReplacementAttemptReference,
  replacementLocator: AgentSandboxReplacementLocatorInput,
  capacityIntent: AgentSandboxReplacementCapacityIntent = { kind: "standalone" },
) {
  return await dbWrite.transaction((tx) =>
    recordIntentAndReserveCapacityInTransaction(
      tx,
      attemptReference,
      replacementLocator,
      capacityIntent,
    ),
  );
}

async function recordAgentSandboxReplacementLifecycleCommitted(
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
) {
  return await dbWrite.transaction((tx) => commitLifecyclePlacementInTransaction(tx, input));
}

async function recordAgentSandboxReplacementCleanupProven(
  attemptReference: AgentSandboxReplacementAttemptReference,
  receiptDigest: string,
) {
  return await dbWrite.transaction((tx) =>
    settleCleanupResourcesInTransaction(tx, attemptReference, receiptDigest),
  );
}

const reference = (attemptId = ATTEMPT_ID): AgentSandboxReplacementAttemptReference => ({
  attemptId,
  organizationId: ORGANIZATION_ID,
  agentId: AGENT_ID,
});

function startInput(
  overrides: Partial<StartAgentSandboxReplacementAttemptInput> = {},
): StartAgentSandboxReplacementAttemptInput {
  return {
    ...reference(),
    operationKind: "upgrade",
    lifecycleRevision: "7",
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleJobId: LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: LIFECYCLE_EXECUTION_GENERATION,
    restoreAuthority: null,
    ...overrides,
  };
}

function admissionInput(
  overrides: Partial<AdmitAndStartAgentSandboxReplacementInput> = {},
): AdmitAndStartAgentSandboxReplacementInput {
  return {
    ...reference(),
    operationKind: "upgrade",
    expectedLifecycleRevision: "8",
    targetActivationGeneration: NEXT_ACTIVATION_GENERATION,
    activationPurpose: "provision",
    activationTokenSha256: "2".repeat(64),
    activationTokenCiphertext: "test-only-next-activation-token",
    lifecycleJobId: LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: LIFECYCLE_EXECUTION_GENERATION,
    restoreAuthority: null,
    ...overrides,
  };
}

function locator(
  stage: "intent" | "created" | "vpn" | "final",
  overrides: Partial<AgentSandboxReplacementLocatorInput> = {},
): AgentSandboxReplacementLocatorInput {
  const hasContainer = stage !== "intent";
  const hasVpn = stage === "vpn" || stage === "final";
  return {
    replacementAttemptId: ATTEMPT_ID,
    sandboxId: CONTAINER_NAME,
    nodeId: "robot-node-a",
    containerName: CONTAINER_NAME,
    nodeRecordId: NODE_RECORD_ID,
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
    nodeHostname: "robot-node-a.internal",
    nodeSshPort: 22,
    nodeSshUser: "root",
    nodeHostKeyFingerprint: "SHA256:test-only-pinned-host-key",
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName: CONTAINER_NAME,
    vpnRegistrationStartedAt: "2026-08-23T12:00:00.000Z",
    previousVpnNodeId: "41",
    containerId: hasContainer ? CONTAINER_ID : null,
    vpnNodeId: hasVpn ? "42" : null,
    ...overrides,
  };
}

function adoptionInput(
  attemptId = ATTEMPT_ID,
  overrides: Partial<CommitAgentSandboxReplacementLifecycleAdoptionInput> = {},
): CommitAgentSandboxReplacementLifecycleAdoptionInput {
  return {
    ...startInput({ attemptId }),
    locator: locator("final", { replacementAttemptId: attemptId }),
    previousPlacement: {
      sandboxId: "old-sandbox",
      nodeId: "old-node",
      containerName: "old-container",
      allocationCounted: true,
    },
    canonicalPatch: {
      status: "provisioning",
      bridgeUrl: "http://100.64.0.42:3000",
      healthUrl: "http://100.64.0.42:3000/health",
      lastHeartbeatAt: new Date("2026-08-23T12:02:00.000Z"),
      errorMessage: null,
      bridgePort: 30_000,
      webUiPort: 30_001,
      headscaleIp: "100.64.0.42",
      dockerImage: "ghcr.io/elizaos/eliza:test",
      imageDigest: IMAGE_DIGEST,
      previousDockerImage: null,
      previousImageDigest: null,
    },
    providerReceiptDigest: PROVIDER_DIGEST,
    lifecycleReceiptDigest: LIFECYCLE_DIGEST,
    ...overrides,
  };
}

async function replacementAllocatedCount(): Promise<number | undefined> {
  const [node] = await dbWrite
    .select({ allocatedCount: dockerNodes.allocated_count })
    .from(dockerNodes)
    .where(eq(dockerNodes.id, NODE_RECORD_ID))
    .limit(1);
  return node?.allocatedCount;
}

function rotatedStartInput(
  lifecycleRevision: string,
  attemptId = OTHER_ATTEMPT_ID,
): StartAgentSandboxReplacementAttemptInput {
  return startInput({
    attemptId,
    lifecycleRevision,
    activationGeneration: NEXT_ACTIVATION_GENERATION,
    lifecycleJobId: NEXT_LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: NEXT_LIFECYCLE_EXECUTION_GENERATION,
  });
}

async function rotateSandboxLifecycle(expectedLifecycleRevision: number): Promise<void> {
  const rotated = await dbWrite
    .update(agentSandboxes)
    .set({
      lifecycle_job_id: NEXT_LIFECYCLE_JOB_ID,
      lifecycle_execution_generation: NEXT_LIFECYCLE_EXECUTION_GENERATION,
      activation_previous_generation: ACTIVATION_GENERATION,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_token_hash: "2".repeat(64),
      activation_token_ciphertext: "test-only-rotated-activation-token",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
        eq(agentSandboxes.activation_generation, ACTIVATION_GENERATION),
        eq(agentSandboxes.lifecycle_job_id, LIFECYCLE_JOB_ID),
        eq(agentSandboxes.lifecycle_execution_generation, LIFECYCLE_EXECUTION_GENERATION),
      ),
    )
    .returning({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      activationGeneration: agentSandboxes.activation_generation,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
      lifecycleJobId: agentSandboxes.lifecycle_job_id,
      lifecycleExecutionGeneration: agentSandboxes.lifecycle_execution_generation,
      nodeId: agentSandboxes.node_id,
    });
  const [current] = rotated;
  expect(current).toMatchObject({
    lifecycleRevision: expectedLifecycleRevision + 1,
    activationGeneration: NEXT_ACTIVATION_GENERATION,
    activationLifecycleRevision: BigInt(expectedLifecycleRevision + 1),
    lifecycleJobId: NEXT_LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: NEXT_LIFECYCLE_EXECUTION_GENERATION,
  });
  if (!current) throw new Error("Expected rotated activation fixture");
  const adoptedReplacement = current.nodeId === "robot-node-a";
  // A real activation publication follows the placement that became canonical.
  // Legacy low-level start fixtures do not publish during adoption, so refresh
  // that immutable-generation fixture before the next rotation consumes it as
  // `activation_previous_generation`.
  await dbWrite
    .delete(agentActivationPublications)
    .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));
  await dbWrite.insert(agentActivationPublications).values(
    activationPublicationFixture({
      id: ACTIVATION_PUBLICATION_ID,
      generation: ACTIVATION_GENERATION,
      lifecycleRevision: expectedLifecycleRevision,
      nodeRecordId: adoptedReplacement ? NODE_RECORD_ID : PREVIOUS_NODE_RECORD_ID,
      nodeId: adoptedReplacement ? "robot-node-a" : "old-node",
      nodeIncarnation: adoptedReplacement ? NODE_INCARNATION : PREVIOUS_NODE_INCARNATION,
      nodeHistoryId: adoptedReplacement ? NODE_HISTORY_ID : PREVIOUS_NODE_HISTORY_ID,
      containerId: adoptedReplacement ? CONTAINER_ID : PREVIOUS_CONTAINER_ID,
    }),
  );
  await dbWrite.insert(agentActivationPublications).values(
    activationPublicationFixture({
      id: NEXT_ACTIVATION_PUBLICATION_ID,
      generation: NEXT_ACTIVATION_GENERATION,
      lifecycleRevision: expectedLifecycleRevision + 1,
      nodeRecordId: adoptedReplacement ? NODE_RECORD_ID : PREVIOUS_NODE_RECORD_ID,
      nodeId: adoptedReplacement ? "robot-node-a" : "old-node",
      nodeIncarnation: adoptedReplacement ? NODE_INCARNATION : PREVIOUS_NODE_INCARNATION,
      nodeHistoryId: adoptedReplacement ? NODE_HISTORY_ID : PREVIOUS_NODE_HISTORY_ID,
      containerId: adoptedReplacement ? CONTAINER_ID : PREVIOUS_CONTAINER_ID,
    }),
  );
}

async function clearCanonicalPlacementForInitialProvision(): Promise<number> {
  const [cleared] = await dbWrite
    .update(agentSandboxes)
    .set({
      status: "provisioning",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      image_digest: null,
      previous_docker_image: null,
      previous_image_digest: null,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(eq(agentSandboxes.id, AGENT_ID), eq(agentSandboxes.organization_id, ORGANIZATION_ID)),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  if (!cleared) throw new Error("Expected initial-provision sandbox fixture");
  await dbWrite
    .update(dockerNodes)
    .set({ allocated_count: 0 })
    .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));
  return cleared.lifecycleRevision;
}

async function restampRotatedActivationAuthority(expectedLifecycleRevision: number): Promise<void> {
  const restamped = await dbWrite
    .update(agentSandboxes)
    .set({
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
        eq(agentSandboxes.activation_generation, NEXT_ACTIVATION_GENERATION),
        eq(agentSandboxes.lifecycle_job_id, NEXT_LIFECYCLE_JOB_ID),
        eq(agentSandboxes.lifecycle_execution_generation, NEXT_LIFECYCLE_EXECUTION_GENERATION),
      ),
    )
    .returning({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      activationLifecycleRevision: agentSandboxes.activation_lifecycle_revision,
    });
  expect(restamped).toEqual([
    {
      lifecycleRevision: expectedLifecycleRevision + 1,
      activationLifecycleRevision: BigInt(expectedLifecycleRevision + 1),
    },
  ]);
}

async function openRestoreActivationAuthority(expectedLifecycleRevision = 7): Promise<string> {
  const [opened] = await dbWrite
    .update(agentSandboxes)
    .set({
      activation_previous_generation: ACTIVATION_GENERATION,
      activation_generation: RESTORE_ATTEMPT_ID,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_purpose: "restore",
      activation_phase: "container_pending",
      activation_backup_id: BACKUP_ID,
      activation_backup_hash: restoreManifestFixture.digest,
      activation_receipt: null,
      activation_receipt_hash: null,
      activation_container_id: null,
      activation_node_id: null,
      activation_image_digest: null,
      activation_boot_id: null,
      activation_authority_published_at: null,
      activation_funding_revision: null,
      activation_dispatched_at: null,
      activation_completed_at: null,
      activation_consent_lifecycle_revision: null,
      activation_consent_head_backup_id: null,
      activation_consent_head_backup_hash: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
        eq(agentSandboxes.activation_generation, ACTIVATION_GENERATION),
      ),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  if (!opened) throw new Error("Expected restore activation fixture");
  return opened.lifecycleRevision.toString();
}

async function completeCurrentActivationForAdmission(): Promise<string> {
  const activePublication = activationPublicationFixture({
    id: ACTIVATION_PUBLICATION_ID,
    generation: ACTIVATION_GENERATION,
    lifecycleRevision: 8,
    nodeRecordId: PREVIOUS_NODE_RECORD_ID,
    nodeId: "old-node",
    nodeIncarnation: PREVIOUS_NODE_INCARNATION,
    nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
    containerId: PREVIOUS_CONTAINER_ID,
  });
  const publishedAt = new Date("2026-08-23T11:55:00.000Z");
  const dispatchedAt = new Date("2026-08-23T11:56:00.000Z");
  const completedAt = new Date("2026-08-23T11:57:00.000Z");
  const [active] = await dbWrite
    .update(agentSandboxes)
    .set({
      docker_image: "ghcr.io/elizaos/eliza:old",
      image_digest: IMAGE_DIGEST,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_phase: "active",
      activation_receipt: activePublication.activation_receipt,
      activation_receipt_hash: activePublication.activation_receipt_sha256,
      activation_container_id: PREVIOUS_CONTAINER_ID,
      activation_node_id: "old-node",
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: PREVIOUS_NODE_INCARNATION,
      activation_authority_published_at: publishedAt,
      activation_funding_revision: 1n,
      activation_dispatched_at: dispatchedAt,
      activation_completed_at: completedAt,
      updated_at: completedAt,
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, 7),
      ),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  if (!active) throw new Error("Expected completed activation fixture");
  return active.lifecycleRevision.toString();
}

async function seedReplacementCleanupLocator(
  attemptId: string,
  expectedLifecycleRevision: number,
): Promise<void> {
  const seeded = await dbWrite
    .update(agentSandboxes)
    .set({
      replacement_cleanup_sandbox_id: CONTAINER_NAME,
      replacement_cleanup_node_id: "robot-node-a",
      replacement_cleanup_node_record_id: NODE_RECORD_ID,
      replacement_cleanup_node_incarnation: NODE_INCARNATION,
      replacement_cleanup_node_history_id: NODE_HISTORY_ID,
      replacement_cleanup_node_hostname: "robot-node-a.internal",
      replacement_cleanup_node_ssh_port: 22,
      replacement_cleanup_node_ssh_user: "root",
      replacement_cleanup_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
      replacement_cleanup_secret_cleanup_version: 1,
      replacement_cleanup_container_name: CONTAINER_NAME,
      replacement_cleanup_attempt_id: attemptId,
      replacement_cleanup_container_id: CONTAINER_ID,
      replacement_cleanup_vpn_node_id: "42",
      replacement_cleanup_vpn_node_name: CONTAINER_NAME,
      replacement_cleanup_preserved_vpn_node_id: "41",
      replacement_cleanup_vpn_registration_started_at: new Date("2026-08-23T12:00:00.000Z"),
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-23T12:03:00.000Z"),
    })
    .where(
      and(
        eq(agentSandboxes.id, AGENT_ID),
        eq(agentSandboxes.organization_id, ORGANIZATION_ID),
        eq(agentSandboxes.lifecycle_revision, expectedLifecycleRevision),
      ),
    )
    .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
  expect(seeded).toEqual([{ lifecycleRevision: expectedLifecycleRevision + 1 }]);
}

type ReplacementTransaction = Parameters<
  typeof commitAgentSandboxReplacementLifecycleAdoptionInTransaction
>[0];

function callerConflict(
  message: string,
  attemptReference: AgentSandboxReplacementAttemptReference,
): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    context: {
      replacementAttemptId: attemptReference.attemptId,
      organizationId: attemptReference.organizationId,
      agentId: attemptReference.agentId,
    },
    severity: "fatal",
  });
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {
    throw new Error("Deferred signal was resolved before initialization");
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

async function recordIntentAndReserveCapacityInTransaction(
  tx: ReplacementTransaction,
  attemptReference: AgentSandboxReplacementAttemptReference,
  replacementLocator: AgentSandboxReplacementLocatorInput,
  capacityIntent: AgentSandboxReplacementCapacityIntent = { kind: "standalone" },
) {
  const recorded = await recordAgentSandboxReplacementIntentInTransaction(
    tx,
    attemptReference,
    replacementLocator,
    capacityIntent,
  );
  return recorded;
}

async function commitLifecyclePlacementInTransaction(
  tx: ReplacementTransaction,
  input: CommitAgentSandboxReplacementLifecycleAdoptionInput,
) {
  return await commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, input);
}

async function settleCleanupResourcesInTransaction(
  tx: ReplacementTransaction,
  attemptReference: AgentSandboxReplacementAttemptReference,
  receiptDigest: string,
  afterAttemptSettled?: () => Promise<void> | void,
  rotateActivation = false,
) {
  const settled = await recordAgentSandboxReplacementCleanupProvenInTransaction(
    tx,
    attemptReference,
    receiptDigest,
  );
  if (settled.replayed) return settled;
  await afterAttemptSettled?.();

  const [sandbox] = await tx
    .select({
      cleanupSandboxId: agentSandboxes.replacement_cleanup_sandbox_id,
      cleanupNodeId: agentSandboxes.replacement_cleanup_node_id,
      cleanupNodeRecordId: agentSandboxes.replacement_cleanup_node_record_id,
      cleanupNodeIncarnation: agentSandboxes.replacement_cleanup_node_incarnation,
      cleanupNodeHistoryId: agentSandboxes.replacement_cleanup_node_history_id,
      cleanupNodeHostname: agentSandboxes.replacement_cleanup_node_hostname,
      cleanupNodeSshPort: agentSandboxes.replacement_cleanup_node_ssh_port,
      cleanupNodeSshUser: agentSandboxes.replacement_cleanup_node_ssh_user,
      cleanupNodeHostKeyFingerprint: agentSandboxes.replacement_cleanup_node_host_key_fingerprint,
      cleanupSecretCleanupVersion: agentSandboxes.replacement_cleanup_secret_cleanup_version,
      cleanupContainerName: agentSandboxes.replacement_cleanup_container_name,
      cleanupAttemptId: agentSandboxes.replacement_cleanup_attempt_id,
      cleanupContainerId: agentSandboxes.replacement_cleanup_container_id,
      cleanupVpnNodeId: agentSandboxes.replacement_cleanup_vpn_node_id,
      cleanupVpnNodeName: agentSandboxes.replacement_cleanup_vpn_node_name,
      cleanupPreviousVpnNodeId: agentSandboxes.replacement_cleanup_preserved_vpn_node_id,
      cleanupVpnStartedAt: agentSandboxes.replacement_cleanup_vpn_registration_started_at,
      cleanupAllocationCounted: agentSandboxes.replacement_cleanup_allocation_counted,
      cleanupCreatedAt: agentSandboxes.replacement_cleanup_created_at,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, attemptReference.agentId),
        eq(agentSandboxes.organization_id, attemptReference.organizationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!sandbox) throw callerConflict("Cleanup sandbox authority is missing", attemptReference);

  const attempt = settled.attempt;
  if (attempt.locator_recorded_at === null) {
    if (sandbox.cleanupSandboxId !== null) {
      throw callerConflict(
        "Locator-free cleanup found unrelated cleanup ownership",
        attemptReference,
      );
    }
    return settled;
  }
  if (
    sandbox.cleanupSandboxId !== attempt.locator_sandbox_id ||
    sandbox.cleanupNodeId !== attempt.locator_node_id ||
    sandbox.cleanupNodeRecordId !== attempt.locator_node_record_id ||
    sandbox.cleanupNodeIncarnation !== attempt.locator_node_incarnation ||
    sandbox.cleanupNodeHistoryId !== attempt.locator_node_history_id ||
    sandbox.cleanupNodeHostname !== attempt.locator_node_hostname ||
    sandbox.cleanupNodeSshPort !== attempt.locator_node_ssh_port ||
    sandbox.cleanupNodeSshUser !== attempt.locator_node_ssh_user ||
    sandbox.cleanupNodeHostKeyFingerprint !== attempt.locator_node_host_key_fingerprint ||
    sandbox.cleanupSecretCleanupVersion !== attempt.locator_secret_cleanup_version ||
    sandbox.cleanupContainerName !== attempt.locator_container_name ||
    sandbox.cleanupAttemptId !== attempt.id ||
    sandbox.cleanupContainerId !== attempt.locator_container_id ||
    sandbox.cleanupVpnNodeId !== attempt.locator_vpn_node_id ||
    sandbox.cleanupVpnNodeName !== attempt.locator_vpn_node_name ||
    sandbox.cleanupPreviousVpnNodeId !== attempt.locator_previous_vpn_node_id ||
    sandbox.cleanupVpnStartedAt?.getTime() !==
      attempt.locator_vpn_registration_started_at?.getTime() ||
    sandbox.cleanupAllocationCounted !== true ||
    sandbox.cleanupCreatedAt === null
  ) {
    throw callerConflict("Cleanup locator authority does not match", attemptReference);
  }

  const cleared = await tx
    .update(agentSandboxes)
    .set({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_node_record_id: null,
      replacement_cleanup_node_incarnation: null,
      replacement_cleanup_node_history_id: null,
      replacement_cleanup_node_hostname: null,
      replacement_cleanup_node_ssh_port: null,
      replacement_cleanup_node_ssh_user: null,
      replacement_cleanup_node_host_key_fingerprint: null,
      replacement_cleanup_secret_cleanup_version: null,
      replacement_cleanup_container_name: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_container_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_vpn_registration_started_at: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
      ...(rotateActivation
        ? {
            activation_previous_generation: ACTIVATION_GENERATION,
            activation_generation: NEXT_ACTIVATION_GENERATION,
            activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
            activation_token_hash: "2".repeat(64),
            activation_token_ciphertext: "test-only-rotated-activation-token",
            lifecycle_job_id: NEXT_LIFECYCLE_JOB_ID,
            lifecycle_execution_generation: NEXT_LIFECYCLE_EXECUTION_GENERATION,
          }
        : {}),
    })
    .where(
      and(
        eq(agentSandboxes.id, attemptReference.agentId),
        eq(agentSandboxes.organization_id, attemptReference.organizationId),
        sql`${agentSandboxes.replacement_cleanup_sandbox_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupSandboxId}`,
        sql`${agentSandboxes.replacement_cleanup_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_node_record_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeRecordId}`,
        sql`${agentSandboxes.replacement_cleanup_node_incarnation}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeIncarnation}`,
        sql`${agentSandboxes.replacement_cleanup_node_history_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeHistoryId}`,
        sql`${agentSandboxes.replacement_cleanup_node_hostname}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeHostname}`,
        sql`${agentSandboxes.replacement_cleanup_node_ssh_port}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeSshPort}`,
        sql`${agentSandboxes.replacement_cleanup_node_ssh_user}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeSshUser}`,
        sql`${agentSandboxes.replacement_cleanup_node_host_key_fingerprint}
          IS NOT DISTINCT FROM ${sandbox.cleanupNodeHostKeyFingerprint}`,
        sql`${agentSandboxes.replacement_cleanup_secret_cleanup_version}
          IS NOT DISTINCT FROM ${sandbox.cleanupSecretCleanupVersion}`,
        sql`${agentSandboxes.replacement_cleanup_container_name}
          IS NOT DISTINCT FROM ${sandbox.cleanupContainerName}`,
        sql`${agentSandboxes.replacement_cleanup_attempt_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupAttemptId}`,
        sql`${agentSandboxes.replacement_cleanup_container_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupContainerId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_name}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnNodeName}`,
        sql`${agentSandboxes.replacement_cleanup_preserved_vpn_node_id}
          IS NOT DISTINCT FROM ${sandbox.cleanupPreviousVpnNodeId}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_registration_started_at}
          IS NOT DISTINCT FROM ${sandbox.cleanupVpnStartedAt}`,
        eq(agentSandboxes.replacement_cleanup_allocation_counted, true),
        sql`${agentSandboxes.replacement_cleanup_created_at}
          IS NOT DISTINCT FROM ${sandbox.cleanupCreatedAt}`,
      ),
    )
    .returning({ id: agentSandboxes.id });
  if (cleared.length !== 1) {
    throw callerConflict("Cleanup locator clear CAS failed", attemptReference);
  }

  return settled;
}

async function settlePreviousPrimaryCleanupInTransaction(
  tx: ReplacementTransaction,
  attemptReference: AgentSandboxReplacementAttemptReference,
  receiptDigest: string,
) {
  const settled = await recordAgentSandboxReplacementPreviousCleanupProvenInTransaction(
    tx,
    attemptReference,
    receiptDigest,
  );
  if (settled.replayed) return settled;
  const attempt = settled.attempt;
  const cleared = await tx
    .update(agentSandboxes)
    .set({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_node_record_id: null,
      replacement_cleanup_node_incarnation: null,
      replacement_cleanup_node_history_id: null,
      replacement_cleanup_node_hostname: null,
      replacement_cleanup_node_ssh_port: null,
      replacement_cleanup_node_ssh_user: null,
      replacement_cleanup_node_host_key_fingerprint: null,
      replacement_cleanup_secret_cleanup_version: null,
      replacement_cleanup_container_name: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_container_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_vpn_registration_started_at: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    })
    .where(
      and(
        eq(agentSandboxes.id, attemptReference.agentId),
        eq(agentSandboxes.organization_id, attemptReference.organizationId),
        sql`${agentSandboxes.replacement_cleanup_sandbox_id}
          IS NOT DISTINCT FROM ${attempt.previous_sandbox_id}`,
        sql`${agentSandboxes.replacement_cleanup_node_id}
          IS NOT DISTINCT FROM ${attempt.previous_node_id}`,
        sql`${agentSandboxes.replacement_cleanup_node_record_id}
          IS NOT DISTINCT FROM ${attempt.previous_node_record_id}`,
        sql`${agentSandboxes.replacement_cleanup_node_incarnation}
          IS NOT DISTINCT FROM ${attempt.previous_node_incarnation}`,
        sql`${agentSandboxes.replacement_cleanup_node_history_id}
          IS NOT DISTINCT FROM ${attempt.previous_node_history_id}`,
        sql`${agentSandboxes.replacement_cleanup_node_hostname}
          IS NOT DISTINCT FROM ${attempt.previous_node_hostname}`,
        sql`${agentSandboxes.replacement_cleanup_node_ssh_port}
          IS NOT DISTINCT FROM ${attempt.previous_node_ssh_port}`,
        sql`${agentSandboxes.replacement_cleanup_node_ssh_user}
          IS NOT DISTINCT FROM ${attempt.previous_node_ssh_user}`,
        sql`${agentSandboxes.replacement_cleanup_node_host_key_fingerprint}
          IS NOT DISTINCT FROM ${attempt.previous_node_host_key_fingerprint}`,
        sql`${agentSandboxes.replacement_cleanup_secret_cleanup_version} IS NULL`,
        sql`${agentSandboxes.replacement_cleanup_container_name}
          IS NOT DISTINCT FROM ${attempt.previous_container_name}`,
        eq(agentSandboxes.replacement_cleanup_attempt_id, attempt.id),
        sql`${agentSandboxes.replacement_cleanup_container_id}
          IS NOT DISTINCT FROM ${attempt.previous_container_id}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_id}
          IS NOT DISTINCT FROM ${attempt.locator_previous_vpn_node_id}`,
        sql`${agentSandboxes.replacement_cleanup_vpn_node_name} IS NULL`,
        sql`${agentSandboxes.replacement_cleanup_preserved_vpn_node_id} IS NULL`,
        sql`${agentSandboxes.replacement_cleanup_vpn_registration_started_at} IS NULL`,
        eq(agentSandboxes.replacement_cleanup_allocation_counted, true),
        sql`${agentSandboxes.replacement_cleanup_created_at}
          IS NOT DISTINCT FROM ${attempt.lifecycle_committed_at}`,
      ),
    )
    .returning({ id: agentSandboxes.id });
  if (cleared.length !== 1) {
    throw callerConflict("Previous-primary cleanup clear CAS failed", attemptReference);
  }
  return settled;
}

function rawSettledAttempt(input: {
  attemptId: string;
  activationGeneration: string;
  state: "provider_succeeded" | "cleanup_proven";
  locatorRecordedAt: Date;
  containerRecordedAt: Date;
  vpnRecordedAt: Date;
  settledAt: Date;
}): typeof agentSandboxReplacementAttempts.$inferInsert {
  return {
    id: input.attemptId,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    operation_kind: "upgrade",
    lifecycle_revision: 7n,
    activation_generation: input.activationGeneration,
    lifecycle_job_id: LIFECYCLE_JOB_ID,
    lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
    state: input.state,
    locator_sandbox_id: CONTAINER_NAME,
    locator_node_id: "robot-node-a",
    locator_container_name: CONTAINER_NAME,
    locator_node_record_id: NODE_RECORD_ID,
    locator_node_incarnation: NODE_INCARNATION,
    locator_node_history_id: NODE_HISTORY_ID,
    locator_node_hostname: "robot-node-a.internal",
    locator_node_ssh_port: 22,
    locator_node_ssh_user: "root",
    locator_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    locator_secret_cleanup_version: 1,
    locator_allocation_counted: true,
    locator_vpn_node_name: CONTAINER_NAME,
    locator_vpn_registration_started_at: new Date("2026-08-23T11:59:00.000Z"),
    locator_previous_vpn_node_id: "41",
    locator_recorded_at: input.locatorRecordedAt,
    locator_container_id: CONTAINER_ID,
    locator_container_recorded_at: input.containerRecordedAt,
    locator_vpn_node_id: "42",
    locator_vpn_recorded_at: input.vpnRecordedAt,
    capacity_state: input.state === "provider_succeeded" ? "reserved" : "released",
    capacity_reserved_at: input.locatorRecordedAt,
    capacity_settled_at: input.state === "cleanup_proven" ? input.settledAt : null,
    capacity_settlement_receipt_digest: input.state === "cleanup_proven" ? CLEANUP_DIGEST : null,
    provider_succeeded_at: input.state === "provider_succeeded" ? input.settledAt : null,
    provider_receipt_digest: input.state === "provider_succeeded" ? PROVIDER_DIGEST : null,
    cleanup_proven_at: input.state === "cleanup_proven" ? input.settledAt : null,
    cleanup_receipt_digest: input.state === "cleanup_proven" ? CLEANUP_DIGEST : null,
    created_at: new Date("2026-08-23T11:58:00.000Z"),
    updated_at: input.settledAt,
  };
}

async function seedRestoreCapacityAuthority(leaseDurationMs = 600_000): Promise<{
  restoreAuthority: AgentSandboxReplacementRestoreAuthority;
  restoreOperationId: string;
  restoreClaimGeneration: string;
}> {
  const leaseCreatedAt = new Date(Date.now() - 60_000);
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: ORGANIZATION_ID, agent_id: AGENT_ID, catalog_revision: 3n });
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 92,
    backup_kind: "full",
    backup_operation_id: BACKUP_OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: BACKUP_DIGEST,
    catalog_revision: 3n,
    catalog_organization_id: ORGANIZATION_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: BACKUP_ACTIVATION_GENERATION,
    lifecycle_revision: 6n,
    source_provider: "operator-onboarded",
    source_node_record_id: NODE_RECORD_ID,
    source_node_id: "backup-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000a00f",
    source_provider_server_id: null,
    source_provider_handle: "backup-source-handle",
    source_container_id: "8".repeat(64),
    retention_reason: "pre-upgrade",
    retention_until: new Date("2027-08-23T00:00:00.000Z"),
    manifest_format: "elizaos.agent-backup",
    manifest_version: 3,
    manifest_digest: restoreManifestFixture.digest,
    manifest_canonical_draft: restoreManifestFixture.canonicalDraft,
    manifest_object_count: 1,
    object_inventory_digest: BACKUP_DIGEST,
    image_digest: `sha256:${BACKUP_DIGEST}`,
    database_schema_version: "1",
    plugin_set_digest: BACKUP_DIGEST,
    watermark_digest: BACKUP_DIGEST,
    raw_size_bytes: 1,
    compressed_size_bytes: 1,
    encrypted_size_bytes: 92,
    kms_key_id: `org:${ORGANIZATION_ID}/dek/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: "00000000-0000-4000-8000-00000000a010",
    operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
    operation_key_bundle_ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
    operation_key_bundle_ciphertext_base64: Buffer.alloc(92, 0x44).toString("base64"),
    operation_key_bundle_sha256: BACKUP_DIGEST,
    operation_key_bundle_size_bytes: 92,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: "elizaos.agent-backup.operation-key-bundle-context.v1",
    operation_key_bundle_local_receipt_derivation:
      "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
    operation_key_bundle_local_receipt_digest: BACKUP_DIGEST,
    vault_key_generation_id: "00000000-0000-4000-8000-00000000a011",
    vault_key_authority_receipt_digest: BACKUP_DIGEST,
  });
  const [lease] = await dbWrite
    .insert(agentBackupRestoreLeases)
    .values({
      id: RESTORE_LEASE_ID,
      organization_id: ORGANIZATION_ID,
      agent_id: AGENT_ID,
      backup_id: BACKUP_ID,
      operation_id: BACKUP_OPERATION_ID,
      activation_generation: BACKUP_ACTIVATION_GENERATION,
      lifecycle_revision: 6n,
      expected_manifest_sha256: restoreManifestFixture.digest,
      copy_role: "primary",
      restore_attempt_id: RESTORE_ATTEMPT_ID,
      owner_id: "restore-worker",
      generation: RESTORE_FENCE,
      catalog_epoch: 3n,
      expires_at: leaseExpiresAt,
      created_at: leaseCreatedAt,
    })
    .returning();
  if (!lease) throw new Error("Expected restore lease fixture");
  const restoreAuthority: AgentSandboxReplacementRestoreAuthority = {
    leaseId: RESTORE_LEASE_ID,
    backupId: BACKUP_ID,
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    ownerId: "restore-worker",
    fencingToken: RESTORE_FENCE,
    catalogEpoch: "3",
    copyRole: "primary",
    operationId: BACKUP_OPERATION_ID,
    sourceActivationGeneration: BACKUP_ACTIVATION_GENERATION,
    sourceLifecycleRevision: "6",
    expectedManifestSha256: restoreManifestFixture.digest,
    expiresAt: leaseExpiresAt,
  };
  const opened = await openAgentBackupRestoreOperation({
    authority: {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      ...restoreAuthority,
      lease,
      databaseNow: new Date(),
    },
    leaseId: RESTORE_LEASE_ID,
  });
  const claimed = await claimAgentBackupRestoreOperation({
    operationId: opened.operation.id,
    ownerId: restoreAuthority.ownerId,
    claimMs: 300_000,
  });
  await reserveAgentBackupRestoreTarget({
    operationId: opened.operation.id,
    ownerId: restoreAuthority.ownerId,
    claimGeneration: claimed.claimGeneration,
    targetNodeRecordId: NODE_RECORD_ID,
    targetNodeIncarnation: NODE_INCARNATION,
    targetNodeHistoryId: NODE_HISTORY_ID,
  });
  return {
    restoreAuthority,
    restoreOperationId: opened.operation.id,
    restoreClaimGeneration: claimed.claimGeneration,
  };
}

/** Install the database-level guards that Drizzle's table DSL cannot express. */
async function installReplacementAttemptGuards(): Promise<void> {
  await dbWrite.execute(
    sql.raw(`
    CREATE FUNCTION guard_agent_sandbox_replacement_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be truncated';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be deleted';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'in_flight_unresolved'
          OR num_nonnulls(
            NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
            NEW.locator_node_record_id, NEW.locator_node_incarnation,
            NEW.locator_node_history_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
            NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
            NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
            NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
            NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
            NEW.locator_container_id, NEW.locator_container_recorded_at,
            NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at,
            NEW.provider_succeeded_at, NEW.provider_receipt_digest,
            NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest,
            NEW.cleanup_proven_at, NEW.cleanup_receipt_digest,
            NEW.previous_cleanup_state, NEW.previous_cleanup_proven_at,
            NEW.previous_cleanup_receipt_digest
          ) <> 0 THEN
          RAISE EXCEPTION 'replacement attempt must start before any provider evidence';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state = 'cleanup_proven' THEN
        RAISE EXCEPTION 'terminal replacement attempt is immutable';
      END IF;
      IF OLD.state = 'lifecycle_committed' AND NOT (
        OLD.previous_cleanup_state = 'pending'
        AND OLD.previous_cleanup_proven_at IS NULL
        AND OLD.previous_cleanup_receipt_digest IS NULL
        AND NEW.state = 'lifecycle_committed'
        AND NEW.previous_cleanup_state = 'released'
        AND NEW.previous_cleanup_proven_at IS NOT NULL
        AND NEW.previous_cleanup_receipt_digest ~ '^[0-9a-f]{64}$'
      ) THEN
        RAISE EXCEPTION 'committed replacement attempt only permits previous cleanup release';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'replacement attempt timestamp cannot rewind';
      END IF;
      IF ROW(
          OLD.id, OLD.organization_id, OLD.agent_id, OLD.operation_kind,
          OLD.lifecycle_revision, OLD.activation_generation, OLD.lifecycle_job_id,
          OLD.lifecycle_execution_generation, OLD.previous_placement_absent,
          OLD.previous_sandbox_id, OLD.previous_node_id, OLD.previous_container_name,
          OLD.previous_container_id, OLD.previous_allocation_counted,
          OLD.previous_node_record_id, OLD.previous_node_incarnation,
          OLD.previous_node_history_id, OLD.previous_node_hostname,
          OLD.previous_node_ssh_port, OLD.previous_node_ssh_user,
          OLD.previous_node_host_key_fingerprint,
          OLD.restore_lease_id, OLD.restore_backup_id,
          OLD.restore_attempt_id, OLD.restore_lease_owner_id, OLD.restore_lease_generation,
          OLD.restore_catalog_epoch, OLD.restore_copy_role, OLD.restore_operation_id,
          OLD.restore_source_activation_generation, OLD.restore_source_lifecycle_revision,
          OLD.restore_manifest_sha256, OLD.restore_lease_expires_at, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.id, NEW.organization_id, NEW.agent_id, NEW.operation_kind,
          NEW.lifecycle_revision, NEW.activation_generation, NEW.lifecycle_job_id,
          NEW.lifecycle_execution_generation, NEW.previous_placement_absent,
          NEW.previous_sandbox_id, NEW.previous_node_id, NEW.previous_container_name,
          NEW.previous_container_id, NEW.previous_allocation_counted,
          NEW.previous_node_record_id, NEW.previous_node_incarnation,
          NEW.previous_node_history_id, NEW.previous_node_hostname,
          NEW.previous_node_ssh_port, NEW.previous_node_ssh_user,
          NEW.previous_node_host_key_fingerprint,
          NEW.restore_lease_id, NEW.restore_backup_id,
          NEW.restore_attempt_id, NEW.restore_lease_owner_id, NEW.restore_lease_generation,
          NEW.restore_catalog_epoch, NEW.restore_copy_role, NEW.restore_operation_id,
          NEW.restore_source_activation_generation, NEW.restore_source_lifecycle_revision,
          NEW.restore_manifest_sha256, NEW.restore_lease_expires_at, NEW.created_at
        ) THEN
        RAISE EXCEPTION 'replacement attempt identity is immutable';
      END IF;

      IF OLD.locator_recorded_at IS NULL THEN
        IF NEW.locator_recorded_at IS NOT NULL
          AND (NEW.locator_container_id IS NOT NULL OR NEW.locator_vpn_node_id IS NOT NULL) THEN
          RAISE EXCEPTION 'replacement locator enrichments cannot skip intent';
        END IF;
      ELSIF ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_incarnation,
          OLD.locator_node_history_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_incarnation,
          NEW.locator_node_history_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at
        ) THEN
        RAISE EXCEPTION 'replacement locator identity is immutable';
      END IF;

      IF OLD.locator_container_id IS NULL THEN
        IF NEW.locator_container_id IS NOT NULL AND OLD.locator_recorded_at IS NULL THEN
          RAISE EXCEPTION 'replacement Docker enrichment requires durable intent';
        END IF;
      ELSIF ROW(OLD.locator_container_id, OLD.locator_container_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_container_id, NEW.locator_container_recorded_at) THEN
        RAISE EXCEPTION 'replacement Docker enrichment is immutable';
      END IF;
      IF OLD.locator_vpn_node_id IS NULL THEN
        IF NEW.locator_vpn_node_id IS NOT NULL AND OLD.locator_container_id IS NULL THEN
          RAISE EXCEPTION 'replacement VPN enrichment requires durable Docker identity';
        END IF;
      ELSIF ROW(OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at) THEN
        RAISE EXCEPTION 'replacement VPN enrichment is immutable';
      END IF;

      IF OLD.provider_succeeded_at IS NOT NULL
        AND ROW(OLD.provider_succeeded_at, OLD.provider_receipt_digest)
          IS DISTINCT FROM ROW(NEW.provider_succeeded_at, NEW.provider_receipt_digest) THEN
        RAISE EXCEPTION 'replacement provider receipt is immutable';
      END IF;
      IF OLD.lifecycle_committed_at IS NOT NULL
        AND ROW(OLD.lifecycle_committed_at, OLD.lifecycle_receipt_digest)
          IS DISTINCT FROM ROW(NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest) THEN
        RAISE EXCEPTION 'replacement lifecycle receipt is immutable';
      END IF;
      IF OLD.cleanup_proven_at IS NOT NULL
        AND ROW(OLD.cleanup_proven_at, OLD.cleanup_receipt_digest)
          IS DISTINCT FROM ROW(NEW.cleanup_proven_at, NEW.cleanup_receipt_digest) THEN
        RAISE EXCEPTION 'replacement cleanup receipt is immutable';
      END IF;

      IF NOT (
        NEW.state = OLD.state
        OR (OLD.state = 'in_flight_unresolved'
          AND NEW.state IN ('provider_succeeded', 'cleanup_proven'))
        OR (OLD.state = 'provider_succeeded'
          AND NEW.state IN ('lifecycle_committed', 'cleanup_proven'))
      ) THEN
        RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
      END IF;
      IF OLD.state = 'in_flight_unresolved' AND NEW.state = 'provider_succeeded'
        AND (OLD.locator_recorded_at IS NULL OR OLD.locator_container_id IS NULL) THEN
        RAISE EXCEPTION 'provider success requires previously durable exact placement';
      END IF;
      IF OLD.state <> 'in_flight_unresolved'
        AND ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_incarnation,
          OLD.locator_node_history_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at,
          OLD.locator_container_id, OLD.locator_container_recorded_at,
          OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_incarnation,
          NEW.locator_node_history_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
          NEW.locator_container_id, NEW.locator_container_recorded_at,
          NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at
        ) THEN
        RAISE EXCEPTION 'settled replacement locator is immutable';
      END IF;
      RETURN NEW;
    END;
    $guard$;
  `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_row
        BEFORE INSERT OR UPDATE OR DELETE ON agent_sandbox_replacement_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_truncate
        BEFORE TRUNCATE ON agent_sandbox_replacement_attempts
        FOR EACH STATEMENT EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
}

let schemaFailure = "";

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    schemaFailure = "isolated PGlite is required; refusing to mutate an ambient Postgres database";
    return;
  }
  try {
    restoreManifestFixture = await buildRestoreManifestFixture();
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupRestoreLeases,
        agentBackupRestoreOperations,
        agentActivationPublications,
        agentSandboxReplacementAttempts,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installReplacementAttemptGuards();
    await dbWrite.execute(
      sql.raw(`
        CREATE FUNCTION test_advance_replacement_sandbox_lifecycle_revision()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
          RETURN NEW;
        END;
        $$
      `),
    );
    await dbWrite.execute(
      sql.raw(`
        CREATE TRIGGER test_replacement_sandbox_lifecycle_revision_trigger
        BEFORE UPDATE ON agent_sandboxes
        FOR EACH ROW
        EXECUTE FUNCTION test_advance_replacement_sandbox_lifecycle_revision()
      `),
    );
  } catch (error) {
    // error-policy:J1 Test setup fails every case loudly instead of skipping DB proofs.
    const cause = (error as { cause?: unknown }).cause;
    schemaFailure = `${error instanceof Error ? error.message : String(error)}; cause: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown")
    }`;
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.delete(agentSandboxReplacementAttempts);
  await dbWrite.delete(agentBackupRestoreOperations);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentActivationPublications);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(organizations);
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Replacement attempt tests",
    slug: "replacement-attempt-tests",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    steward_user_id: "replacement-attempt-test-user",
  });
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    status: "provisioning",
    lifecycle_job_id: LIFECYCLE_JOB_ID,
    lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
    activation_generation: ACTIVATION_GENERATION,
    activation_previous_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 7n,
    activation_purpose: "provision",
    activation_phase: "container_pending",
    activation_token_hash: "1".repeat(64),
    activation_token_ciphertext: "test-only-activation-token",
    execution_tier: "dedicated-always",
    sandbox_id: "old-sandbox",
    node_id: "old-node",
    container_name: "old-container",
    lifecycle_revision: 7,
  });
  await dbWrite.insert(agentNodeIncarnationHistories).values([
    {
      id: NODE_HISTORY_ID,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: "robot-node-a",
      node_incarnation: NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    },
    {
      id: OTHER_NODE_HISTORY_ID,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: "robot-node-a",
      node_incarnation: OTHER_NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    },
    {
      id: ABA_NODE_HISTORY_ID,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: "robot-node-a",
      node_incarnation: NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    },
    {
      id: PREVIOUS_NODE_HISTORY_ID,
      docker_node_record_id: PREVIOUS_NODE_RECORD_ID,
      node_id: "old-node",
      node_incarnation: PREVIOUS_NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:previous-test-only-pinned-host-key",
    },
    {
      id: PREVIOUS_REBOOT_HISTORY_ID,
      docker_node_record_id: PREVIOUS_NODE_RECORD_ID,
      node_id: "old-node",
      node_incarnation: PREVIOUS_REBOOT_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:previous-test-only-pinned-host-key",
    },
  ]);
  await dbWrite.insert(dockerNodes).values([
    {
      id: NODE_RECORD_ID,
      node_id: "robot-node-a",
      hostname: "robot-node-a.internal",
      ssh_port: 22,
      capacity: 8,
      allocated_count: 0,
      status: "healthy",
      ssh_user: "root",
      host_key_fingerprint: "SHA256:test-only-pinned-host-key",
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: NODE_INCARNATION,
      current_node_history_id: NODE_HISTORY_ID,
    },
    {
      id: PREVIOUS_NODE_RECORD_ID,
      node_id: "old-node",
      hostname: "old-node.internal",
      ssh_port: 2222,
      capacity: 8,
      allocated_count: 1,
      status: "healthy",
      ssh_user: "operator",
      host_key_fingerprint: "SHA256:previous-test-only-pinned-host-key",
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: PREVIOUS_NODE_INCARNATION,
      current_node_history_id: PREVIOUS_NODE_HISTORY_ID,
    },
  ]);
  await dbWrite.insert(agentActivationPublications).values(
    activationPublicationFixture({
      id: ACTIVATION_PUBLICATION_ID,
      generation: ACTIVATION_GENERATION,
      lifecycleRevision: 7,
      nodeRecordId: PREVIOUS_NODE_RECORD_ID,
      nodeId: "old-node",
      nodeIncarnation: PREVIOUS_NODE_INCARNATION,
      nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
      containerId: PREVIOUS_CONTAINER_ID,
    }),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent sandbox replacement attempts", () => {
  test("locks restore-linked start in backup -> operation -> lease -> sandbox order", () => {
    const source = readFileSync(
      new URL("../agent-sandbox-replacement-attempts.ts", import.meta.url),
      "utf8",
    );
    const restoreLock = source.slice(
      source.indexOf("async function lockRestoreStartAuthority"),
      source.indexOf("export async function startAgentSandboxReplacementAttemptInTransaction"),
    );
    const start = source.slice(
      source.indexOf("export async function startAgentSandboxReplacementAttemptInTransaction"),
      source.indexOf("async function lockReplacementCapacityNode"),
    );
    const backupLock = restoreLock.indexOf(".from(agentSandboxBackups)");
    const operationLock = restoreLock.indexOf(".from(agentBackupRestoreOperations)");
    const leaseLock = restoreLock.indexOf(".from(agentBackupRestoreLeases)");
    const restoreAuthorityLock = start.indexOf("lockRestoreStartAuthority");
    const sandboxLock = start.indexOf("lockAndValidateAgentSandboxAuthority");
    expect(backupLock).toBeGreaterThan(-1);
    expect(operationLock).toBeGreaterThan(backupLock);
    expect(leaseLock).toBeGreaterThan(operationLock);
    expect(restoreAuthorityLock).toBeGreaterThan(-1);
    expect(sandboxLock).toBeGreaterThan(restoreAuthorityLock);
  });

  test("atomically rotates activation authority and starts the exact replacement attempt", async () => {
    const expectedLifecycleRevision = await completeCurrentActivationForAdmission();
    const input = admissionInput({ expectedLifecycleRevision });

    await expect(
      dbWrite.transaction(async (tx) => {
        const admitted = await admitAndStartAgentSandboxReplacementInTransaction(tx, input);
        expect(admitted).toMatchObject({
          startInput: {
            lifecycleRevision: "9",
            activationGeneration: NEXT_ACTIVATION_GENERATION,
          },
          previousPlacement: {
            sandboxId: "old-sandbox",
            nodeId: "old-node",
            containerName: "old-container",
            containerId: PREVIOUS_CONTAINER_ID,
            nodeRecordId: PREVIOUS_NODE_RECORD_ID,
            nodeIncarnation: PREVIOUS_NODE_INCARNATION,
            nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
          },
          attempt: {
            state: "in_flight_unresolved",
            lifecycle_revision: 9n,
            activation_generation: NEXT_ACTIVATION_GENERATION,
          },
        });
        throw new Error("force atomic admission rollback");
      }),
    ).rejects.toThrow("force atomic admission rollback");
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      activation_generation: ACTIVATION_GENERATION,
      activation_phase: "active",
    });

    await expect(
      dbWrite.transaction((tx) =>
        admitAndStartAgentSandboxReplacementInTransaction(tx, {
          ...input,
          activationTokenSha256: "A".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      dbWrite.transaction((tx) =>
        admitAndStartAgentSandboxReplacementInTransaction(tx, {
          ...input,
          activationTokenCiphertext: "x".repeat(16_385),
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    const admitted = await dbWrite.transaction((tx) =>
      admitAndStartAgentSandboxReplacementInTransaction(tx, input),
    );
    expect(admitted.startInput).toEqual({
      ...reference(),
      operationKind: "upgrade",
      lifecycleRevision: "9",
      activationGeneration: NEXT_ACTIVATION_GENERATION,
      lifecycleJobId: LIFECYCLE_JOB_ID,
      lifecycleExecutionGeneration: LIFECYCLE_EXECUTION_GENERATION,
      restoreAuthority: null,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 9,
      activation_previous_generation: ACTIVATION_GENERATION,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      activation_lifecycle_revision: 9n,
      activation_purpose: "provision",
      activation_phase: "container_pending",
      activation_backup_id: null,
      activation_backup_hash: null,
      activation_receipt: null,
      activation_receipt_hash: null,
      activation_container_id: null,
      activation_node_id: null,
      activation_image_digest: null,
      activation_token_hash: "2".repeat(64),
      activation_token_ciphertext: "test-only-next-activation-token",
      activation_boot_id: null,
      activation_authority_published_at: null,
      activation_funding_revision: null,
      activation_dispatched_at: null,
      activation_completed_at: null,
    });
    await expect(
      dbWrite.transaction((tx) => admitAndStartAgentSandboxReplacementInTransaction(tx, input)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("clears the prior restore endpoint while rotating the next activation", async () => {
    await seedRestoreCapacityAuthority();
    const completedLifecycleRevision = await completeCurrentActivationForAdmission();
    const restoreLifecycleRevision = (BigInt(completedLifecycleRevision) + 1n).toString();
    const restorePublication = activationPublicationFixture({
      id: ACTIVATION_PUBLICATION_ID,
      generation: ACTIVATION_GENERATION,
      lifecycleRevision: Number(restoreLifecycleRevision),
      nodeRecordId: PREVIOUS_NODE_RECORD_ID,
      nodeId: "old-node",
      nodeIncarnation: PREVIOUS_NODE_INCARNATION,
      nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
      containerId: PREVIOUS_CONTAINER_ID,
    });
    const restoreReceipt = {
      ...restorePublication.activation_receipt,
      purpose: "restore" as const,
      backupId: BACKUP_ID,
      backupHash: restoreManifestFixture.digest,
      manifestHash: restoreManifestFixture.digest,
      freshAuthorization: null,
    };
    await dbWrite
      .delete(agentActivationPublications)
      .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));
    await dbWrite.insert(agentActivationPublications).values({
      ...restorePublication,
      purpose: "restore",
      backup_id: BACKUP_ID,
      backup_manifest_sha256: restoreManifestFixture.digest,
      activation_receipt: restoreReceipt,
      endpoint_envelope: ACTIVE_RESTORE_ENDPOINT,
      endpoint_sha256: ACTIVE_RESTORE_ENDPOINT_SHA256,
    });
    const [activeRestore] = await dbWrite
      .update(agentSandboxes)
      .set({
        activation_purpose: "restore",
        activation_backup_id: BACKUP_ID,
        activation_backup_hash: restoreManifestFixture.digest,
        activation_receipt: restoreReceipt,
        activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        activation_endpoint_envelope: ACTIVE_RESTORE_ENDPOINT,
        activation_endpoint_sha256: ACTIVE_RESTORE_ENDPOINT_SHA256,
      })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    expect(activeRestore?.lifecycleRevision.toString()).toBe(restoreLifecycleRevision);
    const expectedLifecycleRevision = activeRestore?.lifecycleRevision.toString();
    if (!expectedLifecycleRevision) throw new Error("Expected active restore fixture");

    await expect(
      dbWrite.transaction((tx) =>
        admitAndStartAgentSandboxReplacementInTransaction(
          tx,
          admissionInput({ expectedLifecycleRevision }),
        ),
      ),
    ).resolves.toMatchObject({
      startInput: { activationGeneration: NEXT_ACTIVATION_GENERATION },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      activation_generation: NEXT_ACTIVATION_GENERATION,
      activation_purpose: "provision",
      activation_phase: "container_pending",
      activation_endpoint_envelope: null,
      activation_endpoint_sha256: null,
    });
  });

  test("adopts provider success after admission against the immutable previous publication", async () => {
    const expectedLifecycleRevision = await completeCurrentActivationForAdmission();
    const admitted = await dbWrite.transaction((tx) =>
      admitAndStartAgentSandboxReplacementInTransaction(
        tx,
        admissionInput({ expectedLifecycleRevision }),
      ),
    );
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);

    const committed = await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
        ...admitted.startInput,
        locator: locator("final"),
        previousPlacement: admitted.previousPlacement,
        canonicalPatch: {
          ...adoptionInput().canonicalPatch,
          previousDockerImage: "ghcr.io/elizaos/eliza:old",
          previousImageDigest: IMAGE_DIGEST,
        },
        providerReceiptDigest: PROVIDER_DIGEST,
        lifecycleReceiptDigest: LIFECYCLE_DIGEST,
      }),
    );

    expect(committed).toMatchObject({
      replayed: false,
      attempt: {
        state: "lifecycle_committed",
        activation_generation: NEXT_ACTIVATION_GENERATION,
        previous_container_id: PREVIOUS_CONTAINER_ID,
        previous_cleanup_state: "pending",
      },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: CONTAINER_NAME,
      node_id: "robot-node-a",
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID,
      activation_previous_generation: ACTIVATION_GENERATION,
      activation_generation: NEXT_ACTIVATION_GENERATION,
    });
  });

  test("derives restore activation authority while revalidating its operation and lease", async () => {
    const { restoreAuthority } = await seedRestoreCapacityAuthority();
    const [sleeping] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "sleeping",
        sandbox_id: null,
        node_id: null,
        container_name: null,
        activation_generation: null,
        activation_previous_generation: null,
        activation_lifecycle_revision: null,
        activation_purpose: null,
        activation_phase: null,
        activation_token_hash: null,
        activation_token_ciphertext: null,
        updated_at: new Date(),
      })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!sleeping) throw new Error("Expected sleeping restore admission fixture");
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));
    const restoreInput = admissionInput({
      operationKind: "provision",
      expectedLifecycleRevision: sleeping.lifecycleRevision.toString(),
      targetActivationGeneration: RESTORE_ATTEMPT_ID,
      restoreAuthority,
    });
    await expect(
      dbWrite.transaction((tx) =>
        admitAndStartAgentSandboxReplacementInTransaction(tx, {
          ...restoreInput,
          targetActivationGeneration: NEXT_ACTIVATION_GENERATION,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    const admitted = await dbWrite.transaction((tx) =>
      admitAndStartAgentSandboxReplacementInTransaction(tx, restoreInput),
    );
    expect(admitted).toMatchObject({
      startInput: {
        lifecycleRevision: "9",
        activationGeneration: RESTORE_ATTEMPT_ID,
        restoreAuthority,
      },
      previousPlacement: null,
      attempt: {
        previous_placement_absent: true,
        restore_lease_id: RESTORE_LEASE_ID,
        restore_backup_id: BACKUP_ID,
        restore_attempt_id: RESTORE_ATTEMPT_ID,
        restore_operation_id: BACKUP_OPERATION_ID,
      },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      status: "provisioning",
      activation_previous_generation: null,
      activation_generation: RESTORE_ATTEMPT_ID,
      activation_lifecycle_revision: 9n,
      activation_purpose: "restore",
      activation_phase: "container_pending",
      activation_backup_id: BACKUP_ID,
      activation_backup_hash: restoreManifestFixture.digest,
    });
  });

  test("admits a fresh no-placement provision without inventing prior authority", async () => {
    const [fresh] = await dbWrite
      .update(agentSandboxes)
      .set({
        sandbox_id: null,
        node_id: null,
        container_name: null,
        activation_generation: null,
        activation_previous_generation: null,
        activation_lifecycle_revision: null,
        activation_purpose: null,
        activation_phase: null,
        activation_token_hash: null,
        activation_token_ciphertext: null,
        updated_at: new Date(),
      })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!fresh) throw new Error("Expected fresh admission fixture");
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));

    const admitted = await dbWrite.transaction((tx) =>
      admitAndStartAgentSandboxReplacementInTransaction(
        tx,
        admissionInput({
          operationKind: "provision",
          expectedLifecycleRevision: fresh.lifecycleRevision.toString(),
        }),
      ),
    );
    expect(admitted).toMatchObject({
      previousPlacement: null,
      attempt: {
        previous_placement_absent: true,
        previous_sandbox_id: null,
        previous_node_id: null,
        previous_container_name: null,
        previous_cleanup_state: null,
        previous_cleanup_proven_at: null,
        previous_cleanup_receipt_digest: null,
      },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({ status: "provisioning" });
  });

  test("atomically moves an unplaced sleeping wake into provisioning before provider work", async () => {
    const [sleeping] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "sleeping",
        sandbox_id: null,
        node_id: null,
        container_name: null,
        activation_generation: null,
        activation_previous_generation: null,
        activation_lifecycle_revision: null,
        activation_purpose: null,
        activation_phase: null,
        activation_token_hash: null,
        activation_token_ciphertext: null,
        updated_at: new Date(),
      })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!sleeping) throw new Error("Expected sleeping wake admission fixture");
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));

    const admitted = await dbWrite.transaction((tx) =>
      admitAndStartAgentSandboxReplacementInTransaction(
        tx,
        admissionInput({
          operationKind: "provision",
          activationPurpose: "wake",
          expectedLifecycleRevision: sleeping.lifecycleRevision.toString(),
        }),
      ),
    );

    expect(admitted).toMatchObject({
      previousPlacement: null,
      startInput: { operationKind: "provision" },
      attempt: { previous_placement_absent: true },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      status: "provisioning",
      activation_purpose: "wake",
      activation_phase: "container_pending",
      activation_generation: NEXT_ACTIVATION_GENERATION,
    });
  });

  test("rejects malformed or partial authority and never reuses a caller attempt ID", async () => {
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ operationKind: "replace" as "upgrade" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleExecutionGeneration: null })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ activationGeneration: null as unknown as string }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          restoreAuthority: {
            leaseId: RESTORE_LEASE_ID,
          } as AgentSandboxReplacementRestoreAuthority,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await expect(
      dbWrite.transaction(async (tx) => {
        await startAgentSandboxReplacementAttemptInTransaction(tx, startInput());
        throw new Error("force start admission rollback");
      }),
    ).rejects.toThrow("force start admission rollback");
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ organizationId: OTHER_ORGANIZATION_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          activationGeneration: "00000000-0000-4000-8000-00000000a024",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleRevision: "8" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          lifecycleExecutionGeneration: "00000000-0000-4000-8000-00000000a026",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await startAgentSandboxReplacementAttempt(startInput());
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(1);
  });

  test("requires a complete non-null activation authority before start", async () => {
    const [withoutActivation] = await dbWrite
      .update(agentSandboxes)
      .set({
        activation_generation: null,
        activation_previous_generation: null,
        activation_lifecycle_revision: null,
        activation_purpose: null,
        activation_phase: null,
        activation_token_hash: null,
        activation_token_ciphertext: null,
      })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!withoutActivation) throw new Error("Expected activation-less sandbox fixture");
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ lifecycleRevision: withoutActivation.lifecycleRevision.toString() }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
  });

  test("requires a published current previous occurrence before start", async () => {
    await dbWrite
      .delete(agentActivationPublications)
      .where(eq(agentActivationPublications.id, ACTIVATION_PUBLICATION_ID));
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);

    await dbWrite.insert(agentActivationPublications).values(
      activationPublicationFixture({
        id: ACTIVATION_PUBLICATION_ID,
        generation: ACTIVATION_GENERATION,
        lifecycleRevision: 7,
        nodeRecordId: PREVIOUS_NODE_RECORD_ID,
        nodeId: "old-node",
        nodeIncarnation: PREVIOUS_NODE_INCARNATION,
        nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
        containerId: PREVIOUS_CONTAINER_ID,
      }),
    );
    await dbWrite
      .update(dockerNodes)
      .set({
        node_incarnation: PREVIOUS_REBOOT_INCARNATION,
        current_node_history_id: PREVIOUS_REBOOT_HISTORY_ID,
      })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
  });

  test("serializes concurrent active ownership and keeps provider success fenced", async () => {
    const contenders = await Promise.allSettled([
      startAgentSandboxReplacementAttempt(startInput()),
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = contenders.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    });

    const [owned] = await dbWrite.select().from(agentSandboxReplacementAttempts);
    if (!owned) throw new Error("Expected one active replacement attempt");
    await persistSuccessfulProviderAttemptAfterExistingStart(owned.id);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: owned.id === ATTEMPT_ID ? OTHER_ATTEMPT_ID : ATTEMPT_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("keeps unresolved and provider effects fenced across rotation until cleanup", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await rotateSandboxLifecycle(7);

    await expect(startAgentSandboxReplacementAttempt(rotatedStartInput("8"))).rejects.toMatchObject(
      { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    );
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(1);

    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await expect(startAgentSandboxReplacementAttempt(rotatedStartInput("8"))).rejects.toMatchObject(
      { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    );
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      activation_generation: ACTIVATION_GENERATION,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      lifecycle_job_id: NEXT_LIFECYCLE_JOB_ID,
      lifecycle_execution_generation: NEXT_LIFECYCLE_EXECUTION_GENERATION,
    });

    await seedReplacementCleanupLocator(ATTEMPT_ID, 8);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(false);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 10,
      activation_generation: NEXT_ACTIVATION_GENERATION,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_allocation_counted: null,
    });

    await restampRotatedActivationAuthority(10);
    const rotated = await startAgentSandboxReplacementAttempt(rotatedStartInput("11"));
    expect(rotated).toMatchObject({
      replayed: false,
      attempt: {
        id: OTHER_ATTEMPT_ID,
        state: "in_flight_unresolved",
        activation_generation: NEXT_ACTIVATION_GENERATION,
      },
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(2);
  });

  test("keeps a committed generation fenced while allowing a rotated generation", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      false,
    );

    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "8" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await getAgentSandboxReplacementAttempt(reference(OTHER_ATTEMPT_ID))).toBeNull();
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "lifecycle_committed",
      activation_generation: ACTIVATION_GENERATION,
    });

    await rotateSandboxLifecycle(8);
    const rotated = await startAgentSandboxReplacementAttempt(rotatedStartInput("9"));
    expect(rotated).toMatchObject({
      replayed: false,
      attempt: {
        id: OTHER_ATTEMPT_ID,
        state: "in_flight_unresolved",
        activation_generation: NEXT_ACTIVATION_GENERATION,
      },
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(2);
  });

  test("rejects partial locators and immutable Docker or VPN enrichment drift", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementCreated(reference(), locator("created")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { allocationCounted: false as true }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { replacementSecretCleanupVersion: 2 as 1 }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostKeyFingerprint: "" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { vpnRegistrationStartedAt: null }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", {
          vpnRegistrationStartedAt: "2026-08-23T13:00:00.000+01:00",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await expect(
      recordAgentSandboxReplacementCreated(
        reference(),
        locator("created", { containerId: "f".repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final", { vpnNodeId: null }),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await expect(
      recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn", { vpnNodeId: "43" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects a replacement target on the previous Docker node before reserving capacity", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", {
          nodeId: "old-node",
          nodeRecordId: PREVIOUS_NODE_RECORD_ID,
          nodeIncarnation: PREVIOUS_NODE_INCARNATION,
          nodeHistoryId: PREVIOUS_NODE_HISTORY_ID,
          nodeHostname: "old-node.internal",
          nodeSshPort: 2222,
          nodeSshUser: "operator",
          nodeHostKeyFingerprint: "SHA256:previous-test-only-pinned-host-key",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();
    expect(await replacementAllocatedCount()).toBe(0);
    expect(
      (
        await dbWrite
          .select({ allocatedCount: dockerNodes.allocated_count })
          .from(dockerNodes)
          .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID))
      )[0]?.allocatedCount,
    ).toBe(1);
  });

  test("commits or rolls back capacity reservation and durable intent together", async () => {
    await startAgentSandboxReplacementAttempt(startInput());

    const reserveAndRecord = async (
      tx: Parameters<typeof recordAgentSandboxReplacementIntentInTransaction>[0],
    ) => await recordIntentAndReserveCapacityInTransaction(tx, reference(), locator("intent"));

    await expect(
      dbWrite.transaction(async (tx) => {
        await reserveAndRecord(tx);
        throw new Error("force intent reservation rollback");
      }),
    ).rejects.toThrow("force intent reservation rollback");
    expect(await replacementAllocatedCount()).toBe(0);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 8 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(reserveAndRecord)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await replacementAllocatedCount()).toBe(8);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await expect(
      dbWrite.transaction((tx) =>
        recordIntentAndReserveCapacityInTransaction(
          tx,
          reference(),
          locator("intent", {
            nodeIncarnation: OTHER_NODE_INCARNATION,
            nodeHistoryId: OTHER_NODE_HISTORY_ID,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        recordIntentAndReserveCapacityInTransaction(
          tx,
          reference(),
          locator("intent", { nodeHistoryId: ABA_NODE_HISTORY_ID }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_recorded_at).toBeNull();

    const committed = await dbWrite.transaction(reserveAndRecord);
    expect(committed.replayed).toBe(false);
    expect(await replacementAllocatedCount()).toBe(1);
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_node_record_id).toBe(
      NODE_RECORD_ID,
    );
    expect((await getAgentSandboxReplacementAttempt(reference()))?.locator_node_history_id).toBe(
      NODE_HISTORY_ID,
    );
    expect((await dbWrite.transaction(reserveAndRecord)).replayed).toBe(true);
    expect(await replacementAllocatedCount()).toBe(1);
  });

  test("makes exact stage and receipt replays idempotent and rejects conflicting bytes", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostname: "drifted.internal" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHistoryId: ABA_NODE_HISTORY_ID }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    expect(
      (await recordAgentSandboxReplacementCreated(reference(), locator("created"))).replayed,
    ).toBe(true);
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    expect(
      (await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"))).replayed,
    ).toBe(true);

    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(reference(), locator("final"), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      false,
    );
    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      true,
    );
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(reference(), locator("intent")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const retained = await getAgentSandboxReplacementAttempt(reference());
    expect(retained).toMatchObject({
      state: "lifecycle_committed",
      provider_receipt_digest: PROVIDER_DIGEST,
      lifecycle_receipt_digest: LIFECYCLE_DIGEST,
    });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleRevision: "8" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "8" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("persists callback evidence with a candidate fence and atomically adopts it", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));

    const persistCreatedAndCandidate = async (tx: ReplacementTransaction) => {
      await recordAgentSandboxReplacementCreatedInTransaction(tx, reference(), locator("created"));
      const candidateCreated = await tx
        .update(agentSandboxes)
        .set({
          replacement_cleanup_sandbox_id: CONTAINER_NAME,
          replacement_cleanup_node_id: "robot-node-a",
          replacement_cleanup_node_record_id: NODE_RECORD_ID,
          replacement_cleanup_node_incarnation: NODE_INCARNATION,
          replacement_cleanup_node_history_id: NODE_HISTORY_ID,
          replacement_cleanup_node_hostname: "robot-node-a.internal",
          replacement_cleanup_node_ssh_port: 22,
          replacement_cleanup_node_ssh_user: "root",
          replacement_cleanup_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
          replacement_cleanup_secret_cleanup_version: 1,
          replacement_cleanup_container_name: CONTAINER_NAME,
          replacement_cleanup_attempt_id: ATTEMPT_ID,
          replacement_cleanup_container_id: CONTAINER_ID,
          replacement_cleanup_vpn_node_id: null,
          replacement_cleanup_vpn_node_name: CONTAINER_NAME,
          replacement_cleanup_preserved_vpn_node_id: "41",
          replacement_cleanup_vpn_registration_started_at: new Date("2026-08-23T12:00:00.000Z"),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date("2026-08-23T12:03:00.000Z"),
        })
        .where(
          and(
            eq(agentSandboxes.id, AGENT_ID),
            eq(agentSandboxes.organization_id, ORGANIZATION_ID),
            eq(agentSandboxes.lifecycle_revision, 7),
            sql`${agentSandboxes.replacement_cleanup_attempt_id} IS NULL`,
          ),
        )
        .returning({ id: agentSandboxes.id });
      expect(candidateCreated).toHaveLength(1);
    };

    await expect(
      dbWrite.transaction(async (tx) => {
        await persistCreatedAndCandidate(tx);
        throw new Error("force created candidate rollback");
      }),
    ).rejects.toThrow("force created candidate rollback");
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      locator_container_id: null,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({ replacement_cleanup_attempt_id: null, lifecycle_revision: 7 });

    await dbWrite.transaction(persistCreatedAndCandidate);
    await dbWrite.transaction(async (tx) => {
      await recordAgentSandboxReplacementVpnRegisteredInTransaction(
        tx,
        reference(),
        locator("vpn"),
      );
      const candidateVpn = await tx
        .update(agentSandboxes)
        .set({ replacement_cleanup_vpn_node_id: "42" })
        .where(
          and(
            eq(agentSandboxes.id, AGENT_ID),
            eq(agentSandboxes.organization_id, ORGANIZATION_ID),
            eq(agentSandboxes.lifecycle_revision, 8),
            eq(agentSandboxes.replacement_cleanup_attempt_id, ATTEMPT_ID),
            eq(agentSandboxes.replacement_cleanup_container_id, CONTAINER_ID),
            sql`${agentSandboxes.replacement_cleanup_vpn_node_id} IS NULL`,
          ),
        )
        .returning({ id: agentSandboxes.id });
      expect(candidateVpn).toHaveLength(1);
    });
    await recordAgentSandboxReplacementProviderSucceeded(
      reference(),
      locator("final"),
      PROVIDER_DIGEST,
    );

    const adopted = await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
    );
    expect(adopted).toMatchObject({
      replayed: false,
      attempt: {
        state: "lifecycle_committed",
        previous_cleanup_state: "pending",
        previous_cleanup_proven_at: null,
        previous_cleanup_receipt_digest: null,
      },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 10,
      sandbox_id: CONTAINER_NAME,
      node_id: "robot-node-a",
      replacement_cleanup_sandbox_id: "old-sandbox",
      replacement_cleanup_node_id: "old-node",
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID,
      replacement_cleanup_vpn_node_id: "41",
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_secret_cleanup_version: null,
    });
  });

  test("rejects a mismatched candidate fence instead of adopting foreign effects", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await seedReplacementCleanupLocator(ATTEMPT_ID, 7);
    await dbWrite
      .update(agentSandboxes)
      .set({ replacement_cleanup_container_id: "f".repeat(64) })
      .where(eq(agentSandboxes.id, AGENT_ID));

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      previous_cleanup_state: null,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: "old-sandbox",
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: "f".repeat(64),
    });
  });

  test("atomically adopts a first provision without inventing cleanup ownership", async () => {
    const lifecycleRevision = await clearCanonicalPlacementForInitialProvision();
    const initialStart = startInput({
      operationKind: "provision",
      lifecycleRevision: lifecycleRevision.toString(),
      restoreAuthority: null,
    });
    const started = await startAgentSandboxReplacementAttempt(initialStart);
    expect(started.attempt.previous_placement_absent).toBe(true);
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);

    const initialAdoption = adoptionInput(ATTEMPT_ID, {
      ...initialStart,
      previousPlacement: null,
    });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
          ...initialAdoption,
          canonicalPatch: {
            ...initialAdoption.canonicalPatch,
            previousDockerImage: "ghcr.io/elizaos/eliza:forged-old",
            previousImageDigest: `sha256:${"8".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
          ...initialAdoption,
          canonicalPatch: {
            ...initialAdoption.canonicalPatch,
            status: "running" as "provisioning",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, initialAdoption),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await expect(
      dbWrite.transaction(async (tx) => {
        const adopted = await commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          initialAdoption,
        );
        expect(adopted).toMatchObject({
          replayed: false,
          attempt: { state: "lifecycle_committed" },
        });
        throw new Error("force first-provision adoption rollback");
      }),
    ).rejects.toThrow("force first-provision adoption rollback");
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      previous_placement_absent: true,
      capacity_state: "reserved",
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: null,
      node_id: null,
      container_name: null,
      lifecycle_revision: lifecycleRevision,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
      status: "provisioning",
    });

    const raced = await Promise.all([
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, initialAdoption),
      ),
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, initialAdoption),
      ),
    ]);
    expect(raced.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(
      (
        await dbWrite.transaction((tx) =>
          commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, initialAdoption),
        )
      ).replayed,
    ).toBe(true);

    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: CONTAINER_NAME,
      node_id: "robot-node-a",
      container_name: CONTAINER_NAME,
      lifecycle_revision: lifecycleRevision + 1,
      status: "provisioning",
      bridge_url: initialAdoption.canonicalPatch.bridgeUrl,
      health_url: initialAdoption.canonicalPatch.healthUrl,
      bridge_port: initialAdoption.canonicalPatch.bridgePort,
      web_ui_port: initialAdoption.canonicalPatch.webUiPort,
      headscale_ip: initialAdoption.canonicalPatch.headscaleIp,
      docker_image: initialAdoption.canonicalPatch.dockerImage,
      image_digest: initialAdoption.canonicalPatch.imageDigest,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    });
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "lifecycle_committed",
      previous_placement_absent: true,
      previous_cleanup_state: null,
      previous_cleanup_proven_at: null,
      previous_cleanup_receipt_digest: null,
    });
    expect(await replacementAllocatedCount()).toBe(1);
    expect(
      (
        await dbWrite
          .select({ allocatedCount: dockerNodes.allocated_count })
          .from(dockerNodes)
          .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID))
      )[0]?.allocatedCount,
    ).toBe(0);

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
          ...initialAdoption,
          canonicalPatch: {
            ...initialAdoption.canonicalPatch,
            bridgeUrl: "http://forged-replay.invalid",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("derives and freezes the previous-placement discriminator", async () => {
    const exactProvision = startInput({ operationKind: "provision" });
    const started = await startAgentSandboxReplacementAttempt(exactProvision);
    expect(started.attempt).toMatchObject({
      previous_placement_absent: false,
      previous_sandbox_id: "old-sandbox",
      previous_node_id: "old-node",
      previous_container_name: "old-container",
      previous_container_id: PREVIOUS_CONTAINER_ID,
      previous_allocation_counted: true,
      previous_node_record_id: PREVIOUS_NODE_RECORD_ID,
      previous_node_incarnation: PREVIOUS_NODE_INCARNATION,
      previous_node_history_id: PREVIOUS_NODE_HISTORY_ID,
      previous_node_hostname: "old-node.internal",
      previous_node_ssh_port: 2222,
      previous_node_ssh_user: "operator",
      previous_node_host_key_fingerprint: "SHA256:previous-test-only-pinned-host-key",
    });
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            ...exactProvision,
            previousPlacement: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
          ...adoptionInput(ATTEMPT_ID, exactProvision),
          canonicalPatch: {
            ...adoptionInput(ATTEMPT_ID, exactProvision).canonicalPatch,
            previousDockerImage: "ghcr.io/elizaos/eliza:forged-old",
            previousImageDigest: `sha256:${"8".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await dbWrite.execute(
      sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
        DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
    );
    try {
      await dbWrite
        .update(agentSandboxReplacementAttempts)
        .set({
          previous_placement_absent: null,
          previous_sandbox_id: null,
          previous_node_id: null,
          previous_container_name: null,
          previous_container_id: null,
          previous_allocation_counted: null,
          previous_node_record_id: null,
          previous_node_incarnation: null,
          previous_node_history_id: null,
          previous_node_hostname: null,
          previous_node_ssh_port: null,
          previous_node_ssh_user: null,
          previous_node_host_key_fingerprint: null,
        })
        .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
    } finally {
      await dbWrite.execute(
        sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
          ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
      );
    }
    await expect(
      (async () =>
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ previous_placement_absent: true })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID)))(),
    ).rejects.toThrow();
  });

  test("rejects partial or cleanup-owned absent canonical placement", async () => {
    const [partial] = await dbWrite
      .update(agentSandboxes)
      .set({ sandbox_id: null })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!partial) throw new Error("Expected partial placement fixture");
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          operationKind: "provision",
          lifecycleRevision: partial.lifecycleRevision.toString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const [restored] = await dbWrite
      .update(agentSandboxes)
      .set({ sandbox_id: "old-sandbox" })
      .where(eq(agentSandboxes.id, AGENT_ID))
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!restored) throw new Error("Expected restored placement fixture");
    await seedReplacementCleanupLocator(OTHER_ATTEMPT_ID, restored.lifecycleRevision);
    const absentRevision = await clearCanonicalPlacementForInitialProvision();
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          operationKind: "provision",
          lifecycleRevision: absentRevision.toString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects adoption when the frozen previous Docker-node occurrence rebooted", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    const exactUpgrade = adoptionInput();
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, {
          ...exactUpgrade,
          canonicalPatch: {
            ...exactUpgrade.canonicalPatch,
            previousDockerImage: "ghcr.io/elizaos/eliza:forged-old",
            previousImageDigest: `sha256:${"8".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await dbWrite
      .update(dockerNodes)
      .set({
        node_incarnation: PREVIOUS_REBOOT_INCARNATION,
        current_node_history_id: PREVIOUS_REBOOT_HISTORY_ID,
      })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      previous_container_id: PREVIOUS_CONTAINER_ID,
      previous_node_incarnation: PREVIOUS_NODE_INCARNATION,
      previous_node_history_id: PREVIOUS_NODE_HISTORY_ID,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: "old-sandbox",
      node_id: "old-node",
      container_name: "old-container",
      lifecycle_revision: 7,
      replacement_cleanup_attempt_id: null,
    });
  });

  test("commits or rolls back lifecycle placement and adoption together", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);

    const placeAndAdopt = async (
      tx: Parameters<typeof commitAgentSandboxReplacementLifecycleAdoptionInTransaction>[0],
    ) => await commitLifecyclePlacementInTransaction(tx, adoptionInput());

    await expect(
      dbWrite.transaction(async (tx) => {
        const consumed = await placeAndAdopt(tx);
        expect(consumed.attempt.state).toBe("lifecycle_committed");
        throw new Error("force outer lifecycle rollback");
      }),
    ).rejects.toThrow("force outer lifecycle rollback");
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: "old-sandbox",
      node_id: "old-node",
      container_name: "old-container",
      lifecycle_revision: 7,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
    });

    await dbWrite.execute(
      sql.raw(`
      CREATE FUNCTION test_reject_replacement_lifecycle_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state = 'provider_succeeded' AND NEW.state = 'lifecycle_committed' THEN
          RAISE EXCEPTION 'test lifecycle commit rejection';
        END IF;
        RETURN NEW;
      END;
      $$;
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER zz_test_reject_replacement_lifecycle_commit
      BEFORE UPDATE ON agent_sandbox_replacement_attempts
      FOR EACH ROW EXECUTE FUNCTION test_reject_replacement_lifecycle_commit();
    `),
    );
    try {
      await expect(dbWrite.transaction(placeAndAdopt)).rejects.toThrow();
    } finally {
      await dbWrite.execute(
        sql.raw(`
        DROP TRIGGER IF EXISTS zz_test_reject_replacement_lifecycle_commit
          ON agent_sandbox_replacement_attempts;
      `),
      );
      await dbWrite.execute(
        sql.raw(`DROP FUNCTION IF EXISTS test_reject_replacement_lifecycle_commit()`),
      );
    }
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: "old-sandbox",
      node_id: "old-node",
      container_name: "old-container",
      lifecycle_revision: 7,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_attempt_id: null,
    });

    await expect(
      dbWrite.transaction((tx) =>
        commitLifecyclePlacementInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            previousPlacement: {
              sandboxId: "invented-old-sandbox",
              nodeId: "old-node",
              containerName: "old-container",
              allocationCounted: true,
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );

    await dbWrite
      .update(dockerNodes)
      .set({
        node_incarnation: OTHER_NODE_INCARNATION,
        current_node_history_id: OTHER_NODE_HISTORY_ID,
      })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(placeAndAdopt)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: NODE_INCARNATION, current_node_history_id: NODE_HISTORY_ID })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(placeAndAdopt)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { operationKind: "downgrade" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    const adoptionRace = await Promise.allSettled([
      dbWrite.transaction(placeAndAdopt),
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ]);
    expect(adoptionRace[0]).toMatchObject({ status: "fulfilled", value: { replayed: false } });
    expect(adoptionRace[1]).toMatchObject({
      status: "rejected",
      reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      sandbox_id: CONTAINER_NAME,
      node_id: "robot-node-a",
      container_name: CONTAINER_NAME,
      lifecycle_revision: 8,
      status: "provisioning",
      bridge_url: adoptionInput().canonicalPatch.bridgeUrl,
      health_url: adoptionInput().canonicalPatch.healthUrl,
      image_digest: IMAGE_DIGEST,
      replacement_cleanup_sandbox_id: "old-sandbox",
      replacement_cleanup_node_id: "old-node",
      replacement_cleanup_node_record_id: PREVIOUS_NODE_RECORD_ID,
      replacement_cleanup_node_incarnation: PREVIOUS_NODE_INCARNATION,
      replacement_cleanup_node_history_id: PREVIOUS_NODE_HISTORY_ID,
      replacement_cleanup_node_hostname: "old-node.internal",
      replacement_cleanup_node_ssh_port: 2222,
      replacement_cleanup_node_ssh_user: "operator",
      replacement_cleanup_node_host_key_fingerprint: "SHA256:previous-test-only-pinned-host-key",
      replacement_cleanup_secret_cleanup_version: null,
      replacement_cleanup_container_name: "old-container",
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID,
      replacement_cleanup_vpn_node_name: null,
      replacement_cleanup_preserved_vpn_node_id: null,
      replacement_cleanup_vpn_registration_started_at: null,
    });
    const committedAttempt = await getAgentSandboxReplacementAttempt(reference());
    expect(committedAttempt).toMatchObject({
      previous_placement_absent: false,
      previous_cleanup_state: "pending",
      previous_cleanup_proven_at: null,
      previous_cleanup_receipt_digest: null,
    });
    const committedSandbox = (
      await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID))
    )[0];
    expect(committedSandbox?.replacement_cleanup_vpn_node_id).toBe("41");
    expect(committedSandbox?.replacement_cleanup_created_at?.getTime()).toBe(
      committedAttempt?.lifecycle_committed_at?.getTime(),
    );

    const replayed = await dbWrite.transaction(placeAndAdopt);
    expect(replayed.replayed).toBe(true);
    await dbWrite
      .update(dockerNodes)
      .set({
        node_incarnation: PREVIOUS_REBOOT_INCARNATION,
        current_node_history_id: PREVIOUS_REBOOT_HISTORY_ID,
      })
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID));
    expect((await dbWrite.transaction(placeAndAdopt)).replayed).toBe(true);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      replacement_cleanup_node_record_id: PREVIOUS_NODE_RECORD_ID,
      replacement_cleanup_node_incarnation: PREVIOUS_NODE_INCARNATION,
      replacement_cleanup_node_history_id: PREVIOUS_NODE_HISTORY_ID,
      replacement_cleanup_secret_cleanup_version: null,
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID,
    });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            previousPlacement: {
              sandboxId: "invented-old-sandbox",
              nodeId: "old-node",
              containerName: "old-container",
              allocationCounted: true,
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { lifecycleReceiptDigest: "e".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { providerReceiptDigest: "f".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("settles the exact old primary once, clears its fence, and rolls back as one unit", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
    );
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "lifecycle_committed",
      previous_cleanup_state: "pending",
    });

    await dbWrite
      .update(agentSandboxes)
      .set({ replacement_cleanup_container_id: "f".repeat(64) })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await expect(
      dbWrite.transaction((tx) =>
        recordAgentSandboxReplacementPreviousCleanupProvenInTransaction(
          tx,
          reference(),
          CLEANUP_DIGEST,
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await dbWrite
      .update(agentSandboxes)
      .set({ replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID })
      .where(eq(agentSandboxes.id, AGENT_ID));

    await expect(
      dbWrite.transaction(async (tx) => {
        const settled = await settlePreviousPrimaryCleanupInTransaction(
          tx,
          reference(),
          CLEANUP_DIGEST,
        );
        expect(settled).toMatchObject({
          replayed: false,
          attempt: {
            previous_cleanup_state: "released",
            previous_cleanup_receipt_digest: CLEANUP_DIGEST,
          },
        });
        throw new Error("force previous-primary cleanup rollback");
      }),
    ).rejects.toThrow("force previous-primary cleanup rollback");
    expect(
      (
        await dbWrite
          .select({ allocatedCount: dockerNodes.allocated_count })
          .from(dockerNodes)
          .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID))
      )[0]?.allocatedCount,
    ).toBe(1);
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      previous_cleanup_state: "pending",
      previous_cleanup_proven_at: null,
      previous_cleanup_receipt_digest: null,
    });
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      replacement_cleanup_attempt_id: ATTEMPT_ID,
      replacement_cleanup_container_id: PREVIOUS_CONTAINER_ID,
      replacement_cleanup_allocation_counted: true,
    });

    const settled = await dbWrite.transaction((tx) =>
      settlePreviousPrimaryCleanupInTransaction(tx, reference(), CLEANUP_DIGEST),
    );
    expect(settled).toMatchObject({
      replayed: false,
      attempt: {
        state: "lifecycle_committed",
        previous_cleanup_state: "released",
        previous_cleanup_receipt_digest: CLEANUP_DIGEST,
      },
    });
    expect(settled.attempt.previous_cleanup_proven_at).toBeInstanceOf(Date);
    expect(
      (
        await dbWrite
          .select({ allocatedCount: dockerNodes.allocated_count })
          .from(dockerNodes)
          .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID))
      )[0]?.allocatedCount,
    ).toBe(0);
    expect(await replacementAllocatedCount()).toBe(1);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_container_id: null,
      replacement_cleanup_vpn_node_id: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    });
    expect(
      (
        await dbWrite.transaction((tx) =>
          recordAgentSandboxReplacementPreviousCleanupProvenInTransaction(
            tx,
            reference(),
            CLEANUP_DIGEST,
          ),
        )
      ).replayed,
    ).toBe(true);
    await expect(
      dbWrite.transaction((tx) =>
        recordAgentSandboxReplacementPreviousCleanupProvenInTransaction(
          tx,
          reference(),
          "e".repeat(64),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (
        await dbWrite.transaction((tx) =>
          commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
        )
      ).replayed,
    ).toBe(true);
  });

  test("never decrements a reused logical node when the old occurrence is retired", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
    );

    const retired = await dbWrite
      .delete(dockerNodes)
      .where(eq(dockerNodes.id, PREVIOUS_NODE_RECORD_ID))
      .returning({ id: dockerNodes.id });
    expect(retired).toEqual([{ id: PREVIOUS_NODE_RECORD_ID }]);
    await dbWrite.insert(agentNodeIncarnationHistories).values({
      id: REUSED_NODE_HISTORY_ID,
      docker_node_record_id: REUSED_NODE_RECORD_ID,
      node_id: "old-node",
      node_incarnation: REUSED_NODE_INCARNATION,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: "SHA256:reused-test-only-pinned-host-key",
    });
    await dbWrite.insert(dockerNodes).values({
      id: REUSED_NODE_RECORD_ID,
      node_id: "old-node",
      hostname: "reused-old-node.internal",
      ssh_port: 2200,
      capacity: 8,
      allocated_count: 3,
      status: "healthy",
      ssh_user: "operator",
      host_key_fingerprint: "SHA256:reused-test-only-pinned-host-key",
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: REUSED_NODE_INCARNATION,
      current_node_history_id: REUSED_NODE_HISTORY_ID,
    });

    const settled = await dbWrite.transaction((tx) =>
      settlePreviousPrimaryCleanupInTransaction(tx, reference(), CLEANUP_DIGEST),
    );
    expect(settled).toMatchObject({
      replayed: false,
      attempt: { previous_cleanup_state: "released" },
    });
    expect(
      (
        await dbWrite
          .select({ allocatedCount: dockerNodes.allocated_count })
          .from(dockerNodes)
          .where(eq(dockerNodes.id, REUSED_NODE_RECORD_ID))
      )[0]?.allocatedCount,
    ).toBe(3);
    expect(await replacementAllocatedCount()).toBe(1);
  });

  test("revalidates a restore lease after waiting for the sandbox lock", async () => {
    const { restoreAuthority } = await seedRestoreCapacityAuthority(1_500);
    const lifecycleRevision = await openRestoreActivationAuthority();
    expect(restoreAuthority.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const sandboxLocked = deferredSignal();
    const allowSandboxUnlock = deferredSignal();
    const sandboxHolder = dbWrite.transaction(async (tx) => {
      const [sandbox] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(eq(agentSandboxes.id, AGENT_ID), eq(agentSandboxes.organization_id, ORGANIZATION_ID)),
        )
        .for("update")
        .limit(1);
      if (!sandbox) throw new Error("Expected sandbox lock fixture");
      sandboxLocked.resolve();
      await allowSandboxUnlock.promise;
    });
    await sandboxLocked.promise;

    const startOutcomePromise = startAgentSandboxReplacementAttempt(
      startInput({
        activationGeneration: RESTORE_ATTEMPT_ID,
        lifecycleRevision,
        restoreAuthority,
      }),
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, restoreAuthority.expiresAt.getTime() - Date.now() + 100)),
    );
    allowSandboxUnlock.resolve();

    await sandboxHolder;
    expect(await startOutcomePromise).toMatchObject({
      status: "rejected",
      reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
  });

  test("scopes handoff lookup before locking a foreign-tenant operation id", async () => {
    const { restoreOperationId, restoreClaimGeneration } = await seedRestoreCapacityAuthority();
    const source = readFileSync(
      new URL("../agent-sandbox-replacement-attempts.ts", import.meta.url),
      "utf8",
    );
    const handoff = source.slice(
      source.indexOf("async function recordCapacityOwnedReplacementIntentInTransaction"),
      source.indexOf("async function recordLocatorStageInTransaction"),
    );
    const sourceLock = handoff.slice(
      handoff.indexOf(".from(agentBackupRestoreOperations)"),
      handoff.indexOf('.for("update")'),
    );
    expect(sourceLock).toContain(
      "eq(agentBackupRestoreOperations.organization_id, reference.organizationId)",
    );
    expect(sourceLock).toContain("eq(agentBackupRestoreOperations.agent_id, reference.agentId)");

    await expect(
      dbWrite.transaction((tx) =>
        recordIntentAndReserveCapacityInTransaction(
          tx,
          { ...reference(), organizationId: OTHER_ORGANIZATION_ID },
          locator("intent"),
          {
            kind: "restore_handoff",
            restoreOperationId,
            restoreClaimGeneration,
            receiptDigest: RESTORE_HANDOFF_DIGEST,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
  });

  test("freezes exact live restore authority and never expires the replacement fence with its lease", async () => {
    const { restoreAuthority, restoreOperationId, restoreClaimGeneration } =
      await seedRestoreCapacityAuthority();
    const lifecycleRevision = await openRestoreActivationAuthority();
    const restoreStart = {
      activationGeneration: RESTORE_ATTEMPT_ID,
      lifecycleRevision,
    } as const;
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          ...restoreStart,
          restoreAuthority: {
            ...restoreAuthority,
            backupId: OTHER_ATTEMPT_ID,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          ...restoreStart,
          restoreAuthority: {
            ...restoreAuthority,
            expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const started = await startAgentSandboxReplacementAttempt(
      startInput({ ...restoreStart, restoreAuthority }),
    );
    expect(started.attempt).toMatchObject({
      restore_lease_id: RESTORE_LEASE_ID,
      restore_backup_id: BACKUP_ID,
      restore_attempt_id: RESTORE_ATTEMPT_ID,
      restore_lease_generation: RESTORE_FENCE,
      restore_catalog_epoch: 3n,
      restore_copy_role: "primary",
      restore_operation_id: BACKUP_OPERATION_ID,
      restore_source_activation_generation: BACKUP_ACTIVATION_GENERATION,
      restore_source_lifecycle_revision: 6n,
      restore_manifest_sha256: restoreManifestFixture.digest,
    });
    expect(started.attempt.restore_lease_expires_at?.getTime()).toBe(
      restoreAuthority.expiresAt.getTime(),
    );

    const originalHandoff: AgentSandboxReplacementCapacityIntent = {
      kind: "restore_handoff",
      restoreOperationId,
      restoreClaimGeneration,
      receiptDigest: RESTORE_HANDOFF_DIGEST,
    };
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"), originalHandoff))
        .replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"), originalHandoff))
        .replayed,
    ).toBe(true);

    await dbWrite
      .update(agentBackupRestoreOperations)
      .set({
        claim_generation: REPLACEMENT_RESTORE_CLAIM,
        claim_expires_at: new Date(Date.now() + 300_000),
      })
      .where(eq(agentBackupRestoreOperations.id, restoreOperationId));
    await expect(
      recordAgentSandboxReplacementIntent(reference(), locator("intent"), originalHandoff),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const resumedHandoff: AgentSandboxReplacementCapacityIntent = {
      ...originalHandoff,
      restoreClaimGeneration: REPLACEMENT_RESTORE_CLAIM,
    };
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"), resumedHandoff))
        .replayed,
    ).toBe(true);
    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await recordAgentSandboxReplacementProviderSucceeded(
      reference(),
      locator("final"),
      PROVIDER_DIGEST,
    );
    await expect(
      recordAgentSandboxReplacementIntent(reference(), locator("intent"), resumedHandoff),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(await replacementAllocatedCount()).toBe(1);
    expect(
      (
        await dbWrite
          .select()
          .from(agentBackupRestoreOperations)
          .where(eq(agentBackupRestoreOperations.id, restoreOperationId))
      )[0],
    ).toMatchObject({
      capacity_state: "handed_off",
      capacity_settlement_receipt_digest: RESTORE_HANDOFF_DIGEST,
    });
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      state: "provider_succeeded",
      capacity_state: "reserved",
    });

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: new Date(Date.now() - 1_000), released_at: new Date() })
      .where(eq(agentBackupRestoreLeases.id, RESTORE_LEASE_ID));
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            ...restoreStart,
            restoreAuthority: {
              ...restoreAuthority,
              expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            ...restoreStart,
            restoreAuthority,
            previousPlacement: null,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (
        await recordAgentSandboxReplacementLifecycleCommitted(
          adoptionInput(ATTEMPT_ID, { ...restoreStart, restoreAuthority }),
        )
      ).attempt.state,
    ).toBe("lifecycle_committed");
    expect(await getAgentSandboxReplacementAttempt(reference())).toMatchObject({
      capacity_state: "handed_off",
      capacity_settlement_receipt_digest: LIFECYCLE_DIGEST,
    });
    expect(await replacementAllocatedCount()).toBe(1);
  });

  test("serializes cleanup with a new start and never reopens either terminal state", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput()),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final"),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID }));
    const otherReference = reference(OTHER_ATTEMPT_ID);
    await recordAgentSandboxReplacementIntent(
      otherReference,
      locator("intent", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementCreated(
      otherReference,
      locator("created", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementVpnRegistered(
      otherReference,
      locator("vpn", { replacementAttemptId: OTHER_ATTEMPT_ID }),
    );
    await recordAgentSandboxReplacementProviderSucceeded(
      otherReference,
      locator("final", { replacementAttemptId: OTHER_ATTEMPT_ID }),
      PROVIDER_DIGEST,
    );
    await dbWrite
      .update(agentSandboxes)
      .set({
        replacement_cleanup_sandbox_id: CONTAINER_NAME,
        replacement_cleanup_node_id: "robot-node-a",
        replacement_cleanup_node_record_id: NODE_RECORD_ID,
        replacement_cleanup_node_incarnation: NODE_INCARNATION,
        replacement_cleanup_node_history_id: NODE_HISTORY_ID,
        replacement_cleanup_node_hostname: "robot-node-a.internal",
        replacement_cleanup_node_ssh_port: 22,
        replacement_cleanup_node_ssh_user: "root",
        replacement_cleanup_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
        replacement_cleanup_secret_cleanup_version: 1,
        replacement_cleanup_container_name: CONTAINER_NAME,
        replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
        replacement_cleanup_container_id: CONTAINER_ID,
        replacement_cleanup_vpn_node_id: "42",
        replacement_cleanup_vpn_node_name: CONTAINER_NAME,
        replacement_cleanup_preserved_vpn_node_id: "41",
        replacement_cleanup_vpn_registration_started_at: new Date("2026-08-23T12:00:00.000Z"),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-08-23T12:03:00.000Z"),
      })
      .where(
        and(
          eq(agentSandboxes.id, AGENT_ID),
          eq(agentSandboxes.organization_id, ORGANIZATION_ID),
          eq(agentSandboxes.lifecycle_revision, 7),
        ),
      );

    const clearReleaseAndSettle = async (tx: ReplacementTransaction) =>
      await settleCleanupResourcesInTransaction(tx, otherReference, CLEANUP_DIGEST);

    await expect(
      dbWrite.transaction(async (tx) => {
        await clearReleaseAndSettle(tx);
        throw new Error("force cleanup convergence rollback");
      }),
    ).rejects.toThrow("force cleanup convergence rollback");
    expect((await getAgentSandboxReplacementAttempt(otherReference))?.state).toBe(
      "provider_succeeded",
    );
    expect(await replacementAllocatedCount()).toBe(1);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });

    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 0 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    await expect(dbWrite.transaction(clearReleaseAndSettle)).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect((await getAgentSandboxReplacementAttempt(otherReference))?.state).toBe(
      "provider_succeeded",
    );
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 8,
      replacement_cleanup_attempt_id: OTHER_ATTEMPT_ID,
      replacement_cleanup_allocation_counted: true,
    });
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 1 })
      .where(eq(dockerNodes.id, NODE_RECORD_ID));

    const cleanupLocked = deferredSignal();
    const allowCleanupCommit = deferredSignal();
    const cleanupPromise = dbWrite.transaction((tx) =>
      settleCleanupResourcesInTransaction(
        tx,
        otherReference,
        CLEANUP_DIGEST,
        async () => {
          cleanupLocked.resolve();
          await allowCleanupCommit.promise;
        },
        true,
      ),
    );
    await cleanupLocked.promise;
    const nextStartPromise = startAgentSandboxReplacementAttempt(
      rotatedStartInput("9", THIRD_ATTEMPT_ID),
    );
    await Promise.resolve();
    allowCleanupCommit.resolve();
    const [cleanupResult, nextStartResult] = await Promise.allSettled([
      cleanupPromise,
      nextStartPromise,
    ]);
    expect(cleanupResult).toMatchObject({
      status: "fulfilled",
      value: { replayed: false, attempt: { state: "cleanup_proven" } },
    });
    expect(nextStartResult).toMatchObject({
      status: "fulfilled",
      value: { replayed: false, attempt: { id: THIRD_ATTEMPT_ID } },
    });
    expect(await replacementAllocatedCount()).toBe(0);
    expect(
      (await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID)))[0],
    ).toMatchObject({
      lifecycle_revision: 9,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_allocation_counted: null,
    });
    expect((await dbWrite.transaction(clearReleaseAndSettle)).replayed).toBe(true);
    expect(await replacementAllocatedCount()).toBe(0);
    await expect(
      recordAgentSandboxReplacementCleanupProven(otherReference, "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput(OTHER_ATTEMPT_ID)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({ attemptId: OTHER_ATTEMPT_ID, lifecycleRevision: "9" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("does not clear an unresolved attempt because its durable row is old", async () => {
    const oldTimestamp = new Date("2025-08-23T00:00:00.000Z");
    await dbWrite.insert(agentSandboxReplacementAttempts).values({
      id: AGED_ATTEMPT_ID,
      organization_id: ORGANIZATION_ID,
      agent_id: AGENT_ID,
      operation_kind: "provision",
      lifecycle_revision: 0n,
      activation_generation: ACTIVATION_GENERATION,
      lifecycle_job_id: null,
      lifecycle_execution_generation: null,
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });

    expect(
      (await getAgentSandboxReplacementAttempt(reference(AGED_ATTEMPT_ID)))?.created_at,
    ).toEqual(oldTimestamp);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: OTHER_ATTEMPT_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects raw settlement timestamps that precede the last durable locator stage", async () => {
    const locatorRecordedAt = new Date("2026-08-23T12:00:00.000Z");
    const containerRecordedAt = new Date("2026-08-23T12:01:00.000Z");
    const vpnRecordedAt = new Date("2026-08-23T12:02:00.000Z");
    await dbWrite.execute(
      sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
        DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
    );
    try {
      const invalidRows: (typeof agentSandboxReplacementAttempts.$inferInsert)[] = [
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a014",
          activationGeneration: "00000000-0000-4000-8000-00000000a017",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt: new Date("2026-08-23T12:00:30.000Z"),
          settledAt: new Date("2026-08-23T12:03:00.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a015",
          activationGeneration: "00000000-0000-4000-8000-00000000a018",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a016",
          activationGeneration: "00000000-0000-4000-8000-00000000a019",
          state: "cleanup_proven",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        {
          ...rawSettledAttempt({
            attemptId: "00000000-0000-4000-8000-00000000a020",
            activationGeneration: "00000000-0000-4000-8000-00000000a021",
            state: "provider_succeeded",
            locatorRecordedAt,
            containerRecordedAt,
            vpnRecordedAt,
            settledAt: new Date("2026-08-23T12:03:00.000Z"),
          }),
          locator_vpn_node_id: null,
          locator_vpn_recorded_at: null,
        },
      ];
      for (const row of invalidRows) {
        await expect(
          (async () => {
            await dbWrite.insert(agentSandboxReplacementAttempts).values(row);
          })(),
        ).rejects.toThrow();
      }
      expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    } finally {
      await dbWrite.execute(
        sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
          ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
      );
    }
  });

  test("rejects raw identity tamper, state rewind, terminal mutation, delete, and reuse", async () => {
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxReplacementAttempts).values({
          id: ATTEMPT_ID,
          organization_id: ORGANIZATION_ID,
          agent_id: AGENT_ID,
          operation_kind: "upgrade",
          lifecycle_revision: 7n,
          activation_generation: ACTIVATION_GENERATION,
          lifecycle_job_id: LIFECYCLE_JOB_ID,
          lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
          state: "cleanup_proven",
          cleanup_proven_at: new Date(),
          cleanup_receipt_digest: CLEANUP_DIGEST,
        });
      })(),
    ).rejects.toThrow();

    await startAgentSandboxReplacementAttempt(startInput());
    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ lifecycle_revision: 8n })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ locator_node_hostname: "drifted.internal" })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await recordAgentSandboxReplacementProviderSucceeded(
      reference(),
      locator("final"),
      PROVIDER_DIGEST,
    );
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({
            state: "in_flight_unresolved",
            provider_succeeded_at: null,
            provider_receipt_digest: null,
          })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput());
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ updated_at: new Date() })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .delete(agentSandboxReplacementAttempts)
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.execute(sql.raw("TRUNCATE TABLE agent_sandbox_replacement_attempts"));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
      })(),
    ).rejects.toThrow();
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
  });
});

async function persistSuccessfulProviderAttemptAfterExistingStart(
  attemptId: string,
  capacityIntent: AgentSandboxReplacementCapacityIntent = { kind: "standalone" },
): Promise<void> {
  const attemptReference = reference(attemptId);
  await recordAgentSandboxReplacementIntent(
    attemptReference,
    locator("intent", { replacementAttemptId: attemptId }),
    capacityIntent,
  );
  await recordAgentSandboxReplacementCreated(
    attemptReference,
    locator("created", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementVpnRegistered(
    attemptReference,
    locator("vpn", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementProviderSucceeded(
    attemptReference,
    locator("final", { replacementAttemptId: attemptId }),
    PROVIDER_DIGEST,
  );
}

/**
 * Executes the isolated canary restore-validation state machine against real
 * PGlite transactions while deterministic provider and HTTP boundaries inject
 * crashes after each externally committed phase.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  agentSandboxBackups,
  agentSandboxes,
  agentSnapshotRestoreValidations,
  type StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { dockerHostPortReservations } from "../../db/schemas/docker-host-port-reservations";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import type {
  AdminCanaryRestoreValidationCheckpoint,
  AdminCanaryRestoreValidationJobData,
  AdminCanaryRestoreValidationJobResult,
} from "./admin-canary-restore-validation";
import type { AgentSnapshotV2CloudDependencies } from "./agent-snapshot-v2-cloud";
import {
  AGENT_SNAPSHOT_V2_CHUNK_BYTES,
  AGENT_SNAPSHOT_V2_CONTENT_TYPE,
  AGENT_SNAPSHOT_V2_FORMAT,
  AGENT_SNAPSHOT_V2_TRANSFER,
  type AgentSnapshotV2Descriptor,
  type AgentSnapshotV2UpgradeBinding,
  agentSnapshotV2Sha256,
  agentSnapshotV2Sha256Json,
  agentSnapshotV2StableJson,
} from "./agent-snapshot-v2-stream";
import { releaseDockerHostPortReservations } from "./docker-port-allocation";
import {
  type DockerSandboxMetadata,
  getRestoreValidationPhysicalIdentity,
} from "./docker-sandbox-provider";
import { ElizaSandboxService, RestoreValidationRetryLaterError } from "./eliza-sandbox";
import type {
  SandboxCreateConfig,
  SandboxHandle,
  SandboxProvider,
  SandboxRestoreValidationCandidateLocator,
  SandboxRestoreValidationPlacementIntent,
  SandboxRestoreValidationRuntimeState,
} from "./sandbox-provider-types";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "11000000-0000-4000-8000-000000000002";
const AGENT_ID = "11000000-0000-4000-8000-000000000003";
const SOURCE_JOB_ID = "11000000-0000-4000-8000-000000000004";
const ROLLOUT_ID = "11000000-0000-4000-8000-000000000005";
const STANDBY_GENERATION = "11000000-0000-4000-8000-000000000006";
const SOURCE_SANDBOX_ID = "11000000-0000-4000-8000-000000000007";
const RESTORE_VALIDATION_ID = "11000000-0000-4000-8000-000000000008";
const VALIDATION_JOB_ID = "11000000-0000-4000-8000-000000000009";
const BACKUP_ID = "11000000-0000-4000-8000-000000000010";
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const CREATED_AT = new Date("2026-07-26T12:00:00.000Z");
const VPN_REGISTRATION_STARTED_AT = "2026-07-26T12:01:00.123Z";
const CANDIDATE_NODE_ID = "node-restore";
const RETRY_CANDIDATE_NODE_ID = "node-restore-retry";
let pgliteReady = true;

type CrashStage = "reservation" | "intent" | "created" | "vpn";

interface SnapshotFixture {
  aggregateSha256: string;
  bytes: Uint8Array;
  descriptor: AgentSnapshotV2Descriptor;
}

interface SnapshotCounters {
  captures: number;
  restores: number;
}

function validationData(): AdminCanaryRestoreValidationJobData {
  return {
    restoreValidationId: RESTORE_VALIDATION_ID,
    backupId: BACKUP_ID,
    captureNonce: "c".repeat(64),
    sourceJobId: SOURCE_JOB_ID,
    rolloutId: ROLLOUT_ID,
    standbyGeneration: STANDBY_GENERATION,
    actorUserId: ACTOR_USER_ID,
    agentId: AGENT_ID,
    organizationId: ORGANIZATION_ID,
    targetOwnerUserId: ACTOR_USER_ID,
    sourceEnvironmentRevision: 6,
    sourceImageDigest: TARGET_DIGEST,
    sourceSandboxId: SOURCE_SANDBOX_ID,
    targetImage: TARGET_IMAGE,
    targetDigest: TARGET_DIGEST,
    primaryNodeId: "node-blue",
    rollbackStandbyNodeId: "node-old",
    plannedAt: CREATED_AT.toISOString(),
  };
}

function candidateHandle(params: {
  attemptId: string;
  bridgePort?: number;
  containerId?: string;
  hostname?: string;
  nodeId?: string;
  vpnNodeId?: string;
  webUiPort?: number;
}): SandboxHandle {
  const privateRoute = params.vpnNodeId !== undefined;
  const identity = getRestoreValidationPhysicalIdentity(params.attemptId);
  const hostname = params.hostname ?? "node-restore.internal";
  const nodeId = params.nodeId ?? CANDIDATE_NODE_ID;
  const bridgePort = params.bridgePort ?? 18_790;
  const webUiPort = params.webUiPort ?? 20_000;
  const metadata: DockerSandboxMetadata = {
    provider: "docker",
    nodeId,
    hostname,
    containerName: identity.containerName,
    containerPort: 31_337,
    bridgePort,
    webUiPort,
    agentId: AGENT_ID,
    volumePath: identity.volumePath,
    dockerImage: TARGET_IMAGE,
    imageDigest: TARGET_DIGEST,
    replacementAttemptId: params.attemptId,
    allocationCounted: true,
    vpnNodeName: identity.vpnAgentName,
    vpnRegistrationStartedAt: VPN_REGISTRATION_STARTED_AT,
    ...(params.containerId ? { containerId: params.containerId } : {}),
    ...(params.vpnNodeId
      ? {
          vpnNodeId: params.vpnNodeId,
          headscaleIp: "100.64.0.30",
        }
      : {}),
  };
  const host = privateRoute ? "100.64.0.30" : hostname;
  const exposedBridgePort = privateRoute ? 31_337 : bridgePort;
  const healthPort = privateRoute ? 31_337 : webUiPort;
  return {
    sandboxId: identity.containerName,
    bridgeUrl: `http://${host}:${exposedBridgePort}/`,
    healthUrl: `http://${host}:${healthPort}/api`,
    metadata,
  };
}

function canonicalSnapshot(binding: AgentSnapshotV2UpgradeBinding): SnapshotFixture {
  const identitySha256 = "ab".repeat(32);
  const databaseSha256 = agentSnapshotV2Sha256Json({
    algorithm: "sha256",
    identitySha256,
    identityVersion: 1,
    kind: "external-postgres-reference",
  });
  const descriptor: AgentSnapshotV2Descriptor = {
    agentId: AGENT_ID,
    binding,
    chunkSize: AGENT_SNAPSHOT_V2_CHUNK_BYTES,
    components: {
      character: {
        configFileIndex: null,
        kind: "character-config",
        sha256: agentSnapshotV2Sha256Json({ configFile: null }),
      },
      database: {
        externalPostgres: {
          algorithm: "sha256",
          identitySha256,
          identityVersion: 1,
          kind: "external-postgres-reference",
          sha256: databaseSha256,
        },
        kind: "external-postgres-reference",
        sha256: databaseSha256,
      },
      media: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
      stateFiles: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
      vault: {
        fileIndices: [],
        kind: "file-set",
        sha256: agentSnapshotV2Sha256Json([]),
      },
    },
    createdAt: CREATED_AT.toISOString(),
    files: [],
    format: AGENT_SNAPSHOT_V2_FORMAT,
    schemaVersion: 2,
    transfer: AGENT_SNAPSHOT_V2_TRANSFER,
    type: "descriptor",
  };
  const aggregateSha256 = agentSnapshotV2Sha256(new Uint8Array());
  const trailer = {
    aggregateSha256,
    chunkCount: 0,
    descriptorSha256: agentSnapshotV2Sha256(agentSnapshotV2StableJson(descriptor)),
    fileCount: 0,
    totalBytes: 0,
    type: "trailer" as const,
  };
  return {
    aggregateSha256,
    bytes: new TextEncoder().encode(
      `${agentSnapshotV2StableJson(descriptor)}\n${agentSnapshotV2StableJson(trailer)}\n`,
    ),
    descriptor,
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* replay(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const split = Math.max(1, Math.floor(bytes.byteLength / 3));
  for (let offset = 0; offset < bytes.byteLength; offset += split) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + split));
  }
}

function committedRestoreResponse(
  binding: AgentSnapshotV2UpgradeBinding,
  snapshot: SnapshotFixture,
): Response {
  return Response.json({
    aggregateSha256: snapshot.aggregateSha256,
    binding,
    fileCount: 0,
    receiptStatus: "committed",
    requiresRestart: true,
    schemaVersion: 2,
    success: true,
    totalBytes: 0,
    transfer: "chunked-v1",
  });
}

function storedBackup(snapshot: SnapshotFixture): StoredAgentSandboxBackup {
  return {
    id: BACKUP_ID,
    sandbox_record_id: AGENT_ID,
    snapshot_type: "pre-upgrade",
    state_data: { config: {}, memories: [], workspaceFiles: {} },
    snapshot_schema_version: 2,
    state_data_storage: "chunked-v2",
    state_data_key: null,
    state_data_descriptor: {
      backupId: BACKUP_ID,
      backupSchemaVersion: 2,
      chunkBytes: AGENT_SNAPSHOT_V2_CHUNK_BYTES,
      chunks: [],
      commitState: "complete",
      createdAt: CREATED_AT.toISOString(),
      descriptorVersion: 1,
      format: "elizaos.agent-backup-chunks",
      objectSetId: "11000000-0000-4000-8000-000000000013",
      organizationId: ORGANIZATION_ID,
      sandboxRecordId: AGENT_ID,
      totalPlaintextBytes: snapshot.bytes.byteLength,
      totalPlaintextSha256: agentSnapshotV2Sha256(snapshot.bytes),
    },
    storage_commit_state: "complete",
    storage_commit_error: null,
    storage_commit_updated_at: CREATED_AT,
    size_bytes: snapshot.bytes.byteLength,
    backup_kind: "full",
    parent_backup_id: null,
    content_hash: snapshot.aggregateSha256,
    verification_status: "verified",
    verified_at: CREATED_AT,
    verification_error: null,
    created_at: CREATED_AT,
  };
}

function snapshotDependencies(
  binding: AgentSnapshotV2UpgradeBinding,
  snapshot: SnapshotFixture,
  counters: SnapshotCounters,
  options?: {
    restoreResponse?: (attempt: number) => Promise<Response>;
  },
): AgentSnapshotV2CloudDependencies {
  return {
    storage: {
      async create(params) {
        counters.captures += 1;
        const bytes = await collect(params.source);
        expect(bytes).toEqual(snapshot.bytes);
        const verification = await params.verify(replay(bytes));
        expect(verification.contentHash).toBe(snapshot.aggregateSha256);
        const backup = storedBackup(snapshot);
        await dbWrite.insert(agentSandboxBackups).values(backup).onConflictDoNothing();
        return backup;
      },
    },
    readStored: () => replay(snapshot.bytes),
    async fetch(_input, init) {
      counters.restores += 1;
      if (!(init?.body instanceof ReadableStream)) {
        throw new Error("restore request body is not a stream");
      }
      expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(snapshot.bytes);
      if (options?.restoreResponse) {
        return await options.restoreResponse(counters.restores);
      }
      return committedRestoreResponse(binding, snapshot);
    },
  };
}

function candidateBinding(attemptId: string): AgentSnapshotV2UpgradeBinding {
  const data = validationData();
  const identity = getRestoreValidationPhysicalIdentity(attemptId);
  return {
    backupId: data.backupId,
    captureNonce: data.captureNonce,
    sourceEnvironmentRevision: data.sourceEnvironmentRevision,
    sourceImageDigest: data.sourceImageDigest,
    sourceSandboxId: data.sourceSandboxId,
    targetImageDigest: data.targetDigest,
    targetReplacementAttemptId: attemptId,
    targetSandboxId: identity.containerName,
  };
}

async function seedAuthority(): Promise<void> {
  const data = validationData();
  await dbWrite
    .insert(organizations)
    .values({ id: ORGANIZATION_ID, name: "Restore validation org", slug: "restore-validation" });
  await dbWrite.insert(users).values({
    id: ACTOR_USER_ID,
    steward_user_id: "restore-validation-actor",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(dockerNodes).values([
    {
      node_id: "node-old",
      hostname: "node-old.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    },
    {
      node_id: "node-blue",
      hostname: "node-blue.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 1,
    },
    {
      node_id: CANDIDATE_NODE_ID,
      hostname: "node-restore.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 0,
    },
    {
      node_id: RETRY_CANDIDATE_NODE_ID,
      hostname: "node-restore-retry.internal",
      status: "healthy",
      enabled: true,
      capacity: 8,
      allocated_count: 0,
    },
  ]);
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORGANIZATION_ID,
    user_id: ACTOR_USER_ID,
    agent_name: "Restore validation canary",
    status: "running",
    sandbox_id: "sandbox-blue",
    bridge_url: "https://blue.example",
    health_url: "https://blue.example/api/health",
    node_id: "node-blue",
    container_name: "agent-blue",
    bridge_port: 22_137,
    web_ui_port: 22_138,
    headscale_ip: "100.64.0.20",
    docker_image: TARGET_IMAGE,
    image_digest: TARGET_DIGEST,
    previous_docker_image: SOURCE_IMAGE,
    previous_image_digest: SOURCE_DIGEST,
    environment_vars: { ELIZA_API_TOKEN: "test-source-token" },
    environment_revision: 6,
    rollback_standby_state: "paused",
    rollback_standby_generation: STANDBY_GENERATION,
    rollback_standby_rollout_id: ROLLOUT_ID,
    rollback_standby_source_job_id: SOURCE_JOB_ID,
    rollback_standby_sandbox_id: "sandbox-old",
    rollback_standby_node_id: "node-old",
    rollback_standby_container_name: "agent-old",
    rollback_standby_container_id: "container-old",
    rollback_standby_bridge_url: "https://old.example",
    rollback_standby_health_url: "https://old.example/api/health",
    rollback_standby_bridge_port: 21_137,
    rollback_standby_web_ui_port: 21_138,
    rollback_standby_headscale_ip: "100.64.0.10",
    rollback_standby_vpn_node_id: "vpn-old",
    rollback_standby_docker_image: SOURCE_IMAGE,
    rollback_standby_image_digest: SOURCE_DIGEST,
    rollback_standby_environment_revision: 6,
    rollback_standby_allocation_counted: true,
    rollback_standby_primary_sandbox_id: "sandbox-blue",
    rollback_standby_primary_node_id: "node-blue",
    rollback_standby_primary_container_name: "agent-blue",
    rollback_standby_primary_container_id: "container-blue",
    rollback_standby_primary_vpn_node_id: "vpn-blue",
    rollback_standby_primary_replacement_attempt_id: SOURCE_SANDBOX_ID,
    rollback_standby_created_at: CREATED_AT,
  });
  await dbWrite.insert(agentSnapshotRestoreValidations).values({
    restore_validation_id: data.restoreValidationId,
    validation_job_id: VALIDATION_JOB_ID,
    source_job_id: data.sourceJobId,
    rollout_id: data.rolloutId,
    standby_generation: data.standbyGeneration,
    organization_id: data.organizationId,
    sandbox_record_id: data.agentId,
    agent_id: data.agentId,
    target_owner_user_id: data.targetOwnerUserId,
    backup_id: data.backupId,
    capture_nonce: data.captureNonce,
    source_environment_revision: data.sourceEnvironmentRevision,
    source_image_digest: data.sourceImageDigest,
    source_sandbox_id: data.sourceSandboxId,
    target_image: data.targetImage,
    target_digest: data.targetDigest,
    candidate_route_mode: "restore_validation_private_control",
    validation_state: "planned",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
}

function retirementProof(locator: SandboxRestoreValidationCandidateLocator) {
  const absentAt = new Date().toISOString();
  return {
    sandboxId: locator.sandboxId,
    nodeId: locator.nodeId,
    containerName: locator.containerName,
    replacementAttemptId: locator.replacementAttemptId,
    containerId: locator.containerId,
    volumePath: locator.volumePath,
    vpnNodeId: locator.vpnNodeId,
    vpnNodeName: locator.vpnNodeName,
    containerAbsentAt: absentAt,
    vpnAbsentAt: absentAt,
    volumeAbsentAt: absentAt,
  };
}

function providerForAttempt(params: {
  attemptId: string;
  crashAfter?: CrashStage;
  createForbidden?: boolean;
  hostname?: string;
  nodeId?: string;
  onRetire?: (locator: SandboxRestoreValidationCandidateLocator) => Promise<void>;
  reservationReplays?: number;
  retireFailures?: number;
  runtimeState?: SandboxRestoreValidationRuntimeState;
  calls: string[];
}): SandboxProvider {
  let retireFailures = params.retireFailures ?? 0;
  return {
    async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
      if (params.createForbidden) {
        throw new Error("candidate creation must not replay");
      }
      params.calls.push(`create:${params.attemptId}`);
      if (
        !config.restoreValidationCandidate ||
        Object.keys(config.environmentVars).length !== 0 ||
        !config.onRestoreValidationPlacementIntent ||
        !config.onReplacementCreateIntent ||
        !config.onReplacementCreated ||
        !config.onReplacementVpnRegistered
      ) {
        throw new Error("restore-validation provider contract is incomplete");
      }
      expect(config.restoreValidationCandidate.replacementAttemptId).toBe(params.attemptId);
      const identity = getRestoreValidationPhysicalIdentity(params.attemptId);
      const nodeId = params.nodeId ?? CANDIDATE_NODE_ID;
      const hostname = params.hostname ?? "node-restore.internal";
      const placementIntent: SandboxRestoreValidationPlacementIntent = {
        agentId: AGENT_ID,
        containerName: identity.containerName,
        containerPort: 31_337,
        healthPath: "/api/health",
        hostname,
        nodeId,
        replacementAttemptId: params.attemptId,
        sandboxId: identity.containerName,
        volumePath: identity.volumePath,
        vpnNodeName: identity.vpnAgentName,
        vpnRegistrationStartedAt: VPN_REGISTRATION_STARTED_AT,
      };
      const reservations = await Promise.all(
        Array.from({ length: params.reservationReplays ?? 1 }, async () => {
          return await config.onRestoreValidationPlacementIntent!(placementIntent);
        }),
      );
      const reservation = reservations[0]!;
      expect(reservations.every((value) => value.bridgePort === reservation.bridgePort)).toBe(true);
      expect(reservations.every((value) => value.webUiPort === reservation.webUiPort)).toBe(true);
      params.calls.push(`reservation:${params.attemptId}:${nodeId}`);
      if (params.crashAfter === "reservation") throw new Error("crash after reservation");
      const intent = candidateHandle({
        attemptId: params.attemptId,
        bridgePort: reservation.bridgePort,
        hostname,
        nodeId,
        webUiPort: reservation.webUiPort,
      });
      await config.onReplacementCreateIntent(intent);
      params.calls.push(`intent:${params.attemptId}`);
      if (params.crashAfter === "intent") throw new Error("crash after intent");
      const created = candidateHandle({
        attemptId: params.attemptId,
        bridgePort: reservation.bridgePort,
        containerId: `container-${params.attemptId}`,
        hostname,
        nodeId,
        webUiPort: reservation.webUiPort,
      });
      await config.onReplacementCreated(created);
      params.calls.push(`created:${params.attemptId}`);
      if (params.crashAfter === "created") throw new Error("crash after created");
      const vpn = candidateHandle({
        attemptId: params.attemptId,
        bridgePort: reservation.bridgePort,
        containerId: `container-${params.attemptId}`,
        hostname,
        nodeId,
        vpnNodeId: `vpn-${params.attemptId}`,
        webUiPort: reservation.webUiPort,
      });
      await config.onReplacementVpnRegistered(vpn);
      params.calls.push(`vpn:${params.attemptId}`);
      if (params.crashAfter === "vpn") throw new Error("crash after vpn");
      return vpn;
    },
    async stop() {},
    async checkHealth() {
      return true;
    },
    async retireRestoreValidationCandidate(locator) {
      params.calls.push(`retire:${locator.replacementAttemptId}`);
      if (retireFailures > 0) {
        retireFailures -= 1;
        throw new Error("crash before remote absence proof");
      }
      await releaseDockerHostPortReservations(
        {
          nodeId: locator.nodeId,
          ownerKind: "restore_validation",
          ownerId: locator.containerName,
        },
        dbWrite,
      );
      await params.onRetire?.(locator);
      return retirementProof(locator);
    },
    async inspectRestoreValidationCandidate(locator) {
      expect(locator.replacementAttemptId).toBe(params.attemptId);
      const state = params.runtimeState ?? "running";
      params.calls.push(`inspect:${locator.replacementAttemptId}:${state}`);
      return state;
    },
  };
}

function executionPolicy(params: {
  committed: AdminCanaryRestoreValidationCheckpoint[];
  converged: AdminCanaryRestoreValidationJobResult[];
  failConvergence?: { remaining: number };
}) {
  return {
    data: validationData(),
    validationJobId: VALIDATION_JOB_ID,
    async onRestoreCommittedInTx(_tx: unknown, checkpoint: AdminCanaryRestoreValidationCheckpoint) {
      params.committed.push(checkpoint);
    },
    async onConvergedInTx(_tx: unknown, result: AdminCanaryRestoreValidationJobResult) {
      if (params.failConvergence && params.failConvergence.remaining > 0) {
        params.failConvergence.remaining -= 1;
        throw new Error("crash after remote absence proof");
      }
      params.converged.push(result);
    },
  };
}

async function readValidationRow() {
  const [row] = await dbWrite
    .select()
    .from(agentSnapshotRestoreValidations)
    .where(eq(agentSnapshotRestoreValidations.restore_validation_id, RESTORE_VALIDATION_ID));
  if (!row) throw new Error("restore-validation row disappeared");
  return row;
}

async function candidateAllocatedCount(nodeId = CANDIDATE_NODE_ID): Promise<number> {
  const [node] = await dbWrite
    .select({ allocatedCount: dockerNodes.allocated_count })
    .from(dockerNodes)
    .where(eq(dockerNodes.node_id, nodeId));
  if (!node) throw new Error("candidate node disappeared");
  return node.allocatedCount;
}

async function restoreReservationRows() {
  return await dbWrite
    .select({
      hostPort: dockerHostPortReservations.host_port,
      nodeId: dockerHostPortReservations.node_id,
      ownerId: dockerHostPortReservations.owner_id,
      portKind: dockerHostPortReservations.port_kind,
    })
    .from(dockerHostPortReservations)
    .where(eq(dockerHostPortReservations.owner_kind, "restore_validation"))
    .orderBy(dockerHostPortReservations.host_port);
}

type TestRestoreHealth = "accepting" | "applying" | "failed" | "standby" | Error;

function restoreHealthResponse(phase: Exclude<TestRestoreHealth, Error>): Response {
  if (phase === "accepting") {
    return Response.json({
      status: "restore-ready",
      restoreReady: true,
      ready: false,
      canRespond: false,
      mode: "restore-validation",
      restorePhase: phase,
    });
  }
  if (phase === "standby") {
    return Response.json(
      {
        status: "restore-standby",
        restoreReady: false,
        ready: false,
        canRespond: false,
        mode: "restore-validation",
        requiresRestart: true,
        restorePhase: phase,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      status: phase === "applying" ? "restore-applying" : "restore-failed",
      restoreReady: false,
      ready: false,
      canRespond: false,
      mode: "restore-validation",
      restorePhase: phase,
    },
    { status: 503 },
  );
}

function installSourceAndHealthFetch(
  snapshot: SnapshotFixture,
  healthSequence: TestRestoreHealth[] = ["accepting"],
) {
  let healthIndex = 0;
  return spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/health") {
      const health =
        healthSequence[Math.min(healthIndex, healthSequence.length - 1)] ??
        new Error("health fixture is empty");
      healthIndex += 1;
      if (health instanceof Error) throw health;
      return restoreHealthResponse(health);
    }
    if (url.pathname === "/api/snapshot") {
      return new Response(snapshot.bytes, {
        headers: { "Content-Type": AGENT_SNAPSHOT_V2_CONTENT_TYPE },
      });
    }
    throw new Error(`unexpected global fetch ${url.toString()}`);
  });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        dockerNodes,
        dockerHostPortReservations,
        agentSandboxes,
        agentSandboxBackups,
        agentSnapshotRestoreValidations,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    throw error;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSnapshotRestoreValidations);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerHostPortReservations);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await seedAuthority();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("admin canary restore validation on primary PGlite", () => {
  test(
    "executes planned through never-routed retirement and replay without duplicate effects",
    async () => {
      const calls: string[] = [];
      const committed: AdminCanaryRestoreValidationCheckpoint[] = [];
      const converged: AdminCanaryRestoreValidationJobResult[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const fetchMock = installSourceAndHealthFetch(snapshot);
      const service = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      const policy = executionPolicy({ committed, converged });
      try {
        const first = await service.executeAdminCanaryRestoreValidation(policy);
        expect(await service.executeAdminCanaryRestoreValidation(policy)).toEqual(first);
      } finally {
        fetchMock.mockRestore();
      }

      expect(calls).toEqual([
        `create:${RESTORE_VALIDATION_ID}`,
        `reservation:${RESTORE_VALIDATION_ID}:${CANDIDATE_NODE_ID}`,
        `intent:${RESTORE_VALIDATION_ID}`,
        `created:${RESTORE_VALIDATION_ID}`,
        `vpn:${RESTORE_VALIDATION_ID}`,
        `retire:${RESTORE_VALIDATION_ID}`,
      ]);
      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(committed).toHaveLength(1);
      expect(converged).toHaveLength(2);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
        receipt_state: "committed",
        route_exposed_at: null,
      });
      expect(await candidateAllocatedCount()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "recovers an atomic pre-remote crash on a later node without leaking ports or capacity",
    async () => {
      const firstCalls: string[] = [];
      const firstService = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls: firstCalls,
          crashAfter: "reservation",
          reservationReplays: 2,
        }),
      );
      await expect(
        firstService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        ),
      ).rejects.toThrow("crash after reservation");

      const identity = getRestoreValidationPhysicalIdentity(RESTORE_VALIDATION_ID);
      expect(firstCalls).toEqual([
        `create:${RESTORE_VALIDATION_ID}`,
        `reservation:${RESTORE_VALIDATION_ID}:${CANDIDATE_NODE_ID}`,
      ]);
      expect(await candidateAllocatedCount(CANDIDATE_NODE_ID)).toBe(1);
      expect(await candidateAllocatedCount(RETRY_CANDIDATE_NODE_ID)).toBe(0);
      expect(await restoreReservationRows()).toEqual([
        {
          hostPort: 18_790,
          nodeId: CANDIDATE_NODE_ID,
          ownerId: identity.containerName,
          portKind: "restore_bridge",
        },
        {
          hostPort: 20_000,
          nodeId: CANDIDATE_NODE_ID,
          ownerId: identity.containerName,
          portKind: "restore_web",
        },
      ]);
      expect(await readValidationRow()).toMatchObject({
        target_provider_node_id: CANDIDATE_NODE_ID,
        target_replacement_attempt_id: RESTORE_VALIDATION_ID,
        target_provider_bridge_port: 18_790,
        target_provider_web_ui_port: 20_000,
        validation_state: "candidate_provisioning",
      });

      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const retryCalls: string[] = [];
      const fetchMock = installSourceAndHealthFetch(snapshot);
      const retryService = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls: retryCalls,
          hostname: "node-restore-retry.internal",
          nodeId: RETRY_CANDIDATE_NODE_ID,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      try {
        await retryService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
      } finally {
        fetchMock.mockRestore();
      }

      expect(retryCalls).toEqual([
        `retire:${RESTORE_VALIDATION_ID}`,
        `create:${RESTORE_VALIDATION_ID}`,
        `reservation:${RESTORE_VALIDATION_ID}:${RETRY_CANDIDATE_NODE_ID}`,
        `intent:${RESTORE_VALIDATION_ID}`,
        `created:${RESTORE_VALIDATION_ID}`,
        `vpn:${RESTORE_VALIDATION_ID}`,
        `retire:${RESTORE_VALIDATION_ID}`,
      ]);
      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(await restoreReservationRows()).toEqual([]);
      expect(await candidateAllocatedCount(CANDIDATE_NODE_ID)).toBe(0);
      expect(await candidateAllocatedCount(RETRY_CANDIDATE_NODE_ID)).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        target_provider_node_id: RETRY_CANDIDATE_NODE_ID,
        target_replacement_attempt_id: RESTORE_VALIDATION_ID,
        target_provider_allocation_counted: false,
        validation_state: "never_routed_retired",
      });
    },
    PGLITE_TIMEOUT,
  );

  for (const crashAfter of ["intent", "created", "vpn"] as const) {
    test(
      `recovers exactly once after a crash following ${crashAfter} persistence`,
      async () => {
        const firstCalls: string[] = [];
        const firstService = new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            crashAfter,
            calls: firstCalls,
          }),
        );
        await expect(
          firstService.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          ),
        ).rejects.toThrow(`crash after ${crashAfter}`);
        expect(await candidateAllocatedCount()).toBe(1);
        expect(await readValidationRow()).toMatchObject({
          validation_state: "candidate_provisioning",
          target_provider_allocation_counted: true,
        });

        const binding = candidateBinding(RESTORE_VALIDATION_ID);
        const snapshot = canonicalSnapshot(binding);
        const counters = { captures: 0, restores: 0 };
        const retryCalls: string[] = [];
        const fetchMock = installSourceAndHealthFetch(snapshot);
        const retryService = new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            createForbidden: crashAfter === "vpn",
            calls: retryCalls,
          }),
          undefined,
          snapshotDependencies(binding, snapshot, counters),
        );
        try {
          await retryService.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          );
        } finally {
          fetchMock.mockRestore();
        }

        if (crashAfter === "vpn") {
          expect(retryCalls).toEqual([`retire:${RESTORE_VALIDATION_ID}`]);
        } else {
          expect(retryCalls).toEqual([
            `retire:${RESTORE_VALIDATION_ID}`,
            `create:${RESTORE_VALIDATION_ID}`,
            `reservation:${RESTORE_VALIDATION_ID}:${CANDIDATE_NODE_ID}`,
            `intent:${RESTORE_VALIDATION_ID}`,
            `created:${RESTORE_VALIDATION_ID}`,
            `vpn:${RESTORE_VALIDATION_ID}`,
            `retire:${RESTORE_VALIDATION_ID}`,
          ]);
        }
        expect(counters).toEqual({ captures: 1, restores: 1 });
        expect(await candidateAllocatedCount()).toBe(0);
        expect(await readValidationRow()).toMatchObject({
          validation_state: "never_routed_retired",
          target_provider_allocation_counted: false,
        });
      },
      PGLITE_TIMEOUT,
    );
  }

  test(
    "replays only retirement after the committed receipt survives a worker crash",
    async () => {
      const calls: string[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const fetchMock = installSourceAndHealthFetch(snapshot);
      const failedService = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
          retireFailures: 1,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      try {
        await expect(
          failedService.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          ),
        ).rejects.toThrow("crash before remote absence proof");
        expect(await readValidationRow()).toMatchObject({
          validation_state: "restore_committed",
          target_provider_allocation_counted: true,
          receipt_state: "committed",
        });
        expect(await candidateAllocatedCount()).toBe(1);

        const retryService = new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            createForbidden: true,
            calls,
          }),
          undefined,
          snapshotDependencies(binding, snapshot, counters),
        );
        await retryService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
        await retryService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
      } finally {
        fetchMock.mockRestore();
      }

      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(calls.filter((call) => call === `create:${RESTORE_VALIDATION_ID}`)).toHaveLength(1);
      expect(calls.filter((call) => call === `retire:${RESTORE_VALIDATION_ID}`)).toHaveLength(2);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "retries idempotent remote absence proof when convergence crashes before database commit",
    async () => {
      const calls: string[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const fetchMock = installSourceAndHealthFetch(snapshot);
      const provider = providerForAttempt({
        attemptId: RESTORE_VALIDATION_ID,
        calls,
      });
      const service = new ElizaSandboxService(
        provider,
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      const failure = { remaining: 1 };
      try {
        await expect(
          service.executeAdminCanaryRestoreValidation(
            executionPolicy({
              committed: [],
              converged: [],
              failConvergence: failure,
            }),
          ),
        ).rejects.toThrow("crash after remote absence proof");
        expect(await readValidationRow()).toMatchObject({
          validation_state: "restore_committed",
          target_provider_allocation_counted: true,
        });
        expect(await candidateAllocatedCount()).toBe(1);

        await service.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
      } finally {
        fetchMock.mockRestore();
      }

      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(calls.filter((call) => call === `retire:${RESTORE_VALIDATION_ID}`)).toHaveLength(2);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "replays the same committed restore after its first response is lost without a second candidate",
    async () => {
      const calls: string[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const fetchMock = installSourceAndHealthFetch(snapshot, ["accepting", "standby"]);
      const service = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters, {
          async restoreResponse(attempt) {
            if (attempt === 1) {
              throw new Error("restore response was lost after remote commit");
            }
            return committedRestoreResponse(binding, snapshot);
          },
        }),
      );
      const policy = executionPolicy({ committed: [], converged: [] });
      try {
        await expect(service.executeAdminCanaryRestoreValidation(policy)).rejects.toThrow(
          "restore response was lost after remote commit",
        );
        expect(await readValidationRow()).toMatchObject({
          validation_state: "candidate_provisioning",
          target_provider_allocation_counted: true,
          receipt_state: null,
        });
        expect(await candidateAllocatedCount()).toBe(1);

        await service.executeAdminCanaryRestoreValidation(policy);
      } finally {
        fetchMock.mockRestore();
      }

      expect(counters).toEqual({ captures: 1, restores: 2 });
      expect(calls.filter((call) => call === `create:${RESTORE_VALIDATION_ID}`)).toHaveLength(1);
      expect(calls.filter((call) => call === `retire:${RESTORE_VALIDATION_ID}`)).toHaveLength(1);
      expect(await restoreReservationRows()).toEqual([]);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
        receipt_state: "committed",
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "retires an interrupted restore and recreates once without leaking remote authority",
    async () => {
      const calls: string[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const fetchMock = installSourceAndHealthFetch(snapshot, ["accepting", "failed", "accepting"]);
      const service = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters, {
          async restoreResponse(attempt) {
            if (attempt === 1) throw new Error("restore upload was truncated");
            return committedRestoreResponse(binding, snapshot);
          },
        }),
      );
      const policy = executionPolicy({ committed: [], converged: [] });
      try {
        await expect(service.executeAdminCanaryRestoreValidation(policy)).rejects.toThrow(
          "restore upload was truncated",
        );
        expect(await candidateAllocatedCount()).toBe(1);
        expect(await restoreReservationRows()).toHaveLength(2);

        await service.executeAdminCanaryRestoreValidation(policy);
      } finally {
        fetchMock.mockRestore();
      }

      expect(counters).toEqual({ captures: 1, restores: 2 });
      expect(calls.filter((call) => call === `create:${RESTORE_VALIDATION_ID}`)).toHaveLength(2);
      expect(calls.filter((call) => call === `retire:${RESTORE_VALIDATION_ID}`)).toHaveLength(2);
      expect(await restoreReservationRows()).toEqual([]);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "uses exact provider exit proof after process death before retiring and recreating",
    async () => {
      const firstCalls: string[] = [];
      await expect(
        new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            calls: firstCalls,
            crashAfter: "vpn",
          }),
        ).executeAdminCanaryRestoreValidation(executionPolicy({ committed: [], converged: [] })),
      ).rejects.toThrow("crash after vpn");
      expect(await candidateAllocatedCount()).toBe(1);

      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const retryCalls: string[] = [];
      const fetchMock = installSourceAndHealthFetch(snapshot, [
        new Error("restore-only process exited"),
        "accepting",
      ]);
      const retryService = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls: retryCalls,
          runtimeState: "exited",
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      try {
        await retryService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
      } finally {
        fetchMock.mockRestore();
      }

      expect(retryCalls).toEqual([
        `inspect:${RESTORE_VALIDATION_ID}:exited`,
        `retire:${RESTORE_VALIDATION_ID}`,
        `create:${RESTORE_VALIDATION_ID}`,
        `reservation:${RESTORE_VALIDATION_ID}:${CANDIDATE_NODE_ID}`,
        `intent:${RESTORE_VALIDATION_ID}`,
        `created:${RESTORE_VALIDATION_ID}`,
        `vpn:${RESTORE_VALIDATION_ID}`,
        `retire:${RESTORE_VALIDATION_ID}`,
      ]);
      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(await restoreReservationRows()).toEqual([]);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "keeps an applying candidate fenced and resumes it without teardown",
    async () => {
      await expect(
        new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            calls: [],
            crashAfter: "vpn",
          }),
        ).executeAdminCanaryRestoreValidation(executionPolicy({ committed: [], converged: [] })),
      ).rejects.toThrow("crash after vpn");

      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const retryCalls: string[] = [];
      const fetchMock = installSourceAndHealthFetch(snapshot, ["applying", "standby"]);
      const retryService = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls: retryCalls,
          createForbidden: true,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters),
      );
      try {
        await expect(
          retryService.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          ),
        ).rejects.toBeInstanceOf(RestoreValidationRetryLaterError);
        expect(retryCalls).toEqual([]);
        expect(await candidateAllocatedCount()).toBe(1);
        expect(await restoreReservationRows()).toHaveLength(2);

        await retryService.executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        );
      } finally {
        fetchMock.mockRestore();
      }

      expect(retryCalls).toEqual([`retire:${RESTORE_VALIDATION_ID}`]);
      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(await restoreReservationRows()).toEqual([]);
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "never_routed_retired",
        target_provider_allocation_counted: false,
      });
    },
    PGLITE_TIMEOUT,
  );

  for (const runtimeState of ["running", "unresolved"] as const) {
    test(
      `keeps an unreachable ${runtimeState} candidate fenced without releasing authority`,
      async () => {
        await expect(
          new ElizaSandboxService(
            providerForAttempt({
              attemptId: RESTORE_VALIDATION_ID,
              calls: [],
              crashAfter: "vpn",
            }),
          ).executeAdminCanaryRestoreValidation(executionPolicy({ committed: [], converged: [] })),
        ).rejects.toThrow("crash after vpn");

        const binding = candidateBinding(RESTORE_VALIDATION_ID);
        const snapshot = canonicalSnapshot(binding);
        const calls: string[] = [];
        const fetchMock = installSourceAndHealthFetch(snapshot, [
          new Error("candidate health is unreachable"),
        ]);
        const service = new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            calls,
            runtimeState,
          }),
        );
        try {
          await expect(
            service.executeAdminCanaryRestoreValidation(
              executionPolicy({ committed: [], converged: [] }),
            ),
          ).rejects.toThrow(
            `Restore-validation candidate health is unreachable while provider state is ${runtimeState}`,
          );
        } finally {
          fetchMock.mockRestore();
        }

        expect(calls).toEqual([`inspect:${RESTORE_VALIDATION_ID}:${runtimeState}`]);
        expect(await candidateAllocatedCount()).toBe(1);
        expect(await restoreReservationRows()).toHaveLength(2);
        expect(await readValidationRow()).toMatchObject({
          validation_state: "candidate_provisioning",
          target_provider_allocation_counted: true,
          receipt_state: null,
        });
      },
      PGLITE_TIMEOUT,
    );
  }

  test(
    "does not reset capacity when the validation job changes after remote retirement",
    async () => {
      await expect(
        new ElizaSandboxService(
          providerForAttempt({
            attemptId: RESTORE_VALIDATION_ID,
            calls: [],
            crashAfter: "vpn",
          }),
        ).executeAdminCanaryRestoreValidation(executionPolicy({ committed: [], converged: [] })),
      ).rejects.toThrow("crash after vpn");

      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const calls: string[] = [];
      const fetchMock = installSourceAndHealthFetch(snapshot, ["failed"]);
      const changedValidationJobId = "11000000-0000-4000-8000-000000000099";
      const service = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
          async onRetire() {
            await dbWrite
              .update(agentSnapshotRestoreValidations)
              .set({ validation_job_id: changedValidationJobId })
              .where(
                eq(agentSnapshotRestoreValidations.restore_validation_id, RESTORE_VALIDATION_ID),
              );
          },
        }),
      );
      try {
        await expect(
          service.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          ),
        ).rejects.toThrow("Restore-validation authority disappeared before reset");
      } finally {
        fetchMock.mockRestore();
      }

      expect(calls).toEqual([`retire:${RESTORE_VALIDATION_ID}`]);
      expect(await candidateAllocatedCount()).toBe(1);
      expect(await readValidationRow()).toMatchObject({
        validation_job_id: changedValidationJobId,
        validation_state: "candidate_provisioning",
        target_provider_allocation_counted: true,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects a foreign committed receipt without releasing or recreating its candidate",
    async () => {
      const calls: string[] = [];
      const binding = candidateBinding(RESTORE_VALIDATION_ID);
      const snapshot = canonicalSnapshot(binding);
      const counters = { captures: 0, restores: 0 };
      const foreignBinding = {
        ...binding,
        targetSandboxId: "restore-validation-foreign",
      };
      const fetchMock = installSourceAndHealthFetch(snapshot);
      const service = new ElizaSandboxService(
        providerForAttempt({
          attemptId: RESTORE_VALIDATION_ID,
          calls,
        }),
        undefined,
        snapshotDependencies(binding, snapshot, counters, {
          async restoreResponse() {
            return committedRestoreResponse(foreignBinding, snapshot);
          },
        }),
      );
      try {
        await expect(
          service.executeAdminCanaryRestoreValidation(
            executionPolicy({ committed: [], converged: [] }),
          ),
        ).rejects.toThrow();
      } finally {
        fetchMock.mockRestore();
      }

      expect(counters).toEqual({ captures: 1, restores: 1 });
      expect(calls.filter((call) => call === `create:${RESTORE_VALIDATION_ID}`)).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith("retire:"))).toHaveLength(0);
      expect(await candidateAllocatedCount()).toBe(1);
      expect(await restoreReservationRows()).toHaveLength(2);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "candidate_provisioning",
        target_provider_allocation_counted: true,
        receipt_state: null,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects out-of-order remote enrichment without reserving capacity",
    async () => {
      const provider: SandboxProvider = {
        async create(config) {
          if (!config.onReplacementCreated) {
            throw new Error("created callback is missing");
          }
          await config.onReplacementCreated(
            candidateHandle({
              attemptId: RESTORE_VALIDATION_ID,
              containerId: "container-out-of-order",
            }),
          );
          throw new Error("provider should not continue");
        },
        async stop() {},
        async checkHealth() {
          return true;
        },
        async retireRestoreValidationCandidate(locator) {
          return retirementProof(locator);
        },
      };
      await expect(
        new ElizaSandboxService(provider).executeAdminCanaryRestoreValidation(
          executionPolicy({ committed: [], converged: [] }),
        ),
      ).rejects.toThrow("enrichment arrived out of order");
      expect(await candidateAllocatedCount()).toBe(0);
      expect(await readValidationRow()).toMatchObject({
        validation_state: "planned",
        target_provider_allocation_counted: null,
      });
      expect(
        await agentSandboxesRepository.findByIdAndOrg(AGENT_ID, ORGANIZATION_ID),
      ).toMatchObject({
        rollback_standby_state: "paused",
        rollback_standby_generation: STANDBY_GENERATION,
      });
    },
    PGLITE_TIMEOUT,
  );
});

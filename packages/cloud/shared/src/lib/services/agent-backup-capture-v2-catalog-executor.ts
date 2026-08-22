/**
 * Production boundary between one owned catalogue capture lease and capture-v2.
 *
 * This module deliberately does not guess sandbox runtime metadata, routing, or
 * cryptographic authority. A deployment must inject an independently
 * revalidatable attestation plus one real KMS operation-key-bundle provider. Once those
 * authorities are present, the remaining path is concrete: authenticated HTTP
 * capture, bounded encrypted spool, lease heartbeats, and idempotent catalogue
 * recordCaptured persistence. Upload and replication are not entered here.
 */

import { isDeepStrictEqual } from "node:util";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2Request,
  type AgentBackupManifestV3,
} from "@elizaos/shared";
import {
  type AgentBackupOperationClaim,
  heartbeatAgentBackupOperation,
  loadAgentBackupManifestChainAuthority,
} from "../../db/repositories/agent-backup-catalog";
import { openAgentBackupCaptureV2 } from "./agent-backup-capture-v2-client";
import {
  AgentBackupCaptureV2CatalogExecutorError,
  createAgentBackupCaptureV2ExecutorError,
  normalizeAgentBackupCaptureV2TerminalFailure,
} from "./agent-backup-capture-v2-failure-disposition";
import {
  type AgentBackupCaptureV2PipelineResult,
  type AgentBackupCaptureV3CatalogManifest,
  type AgentBackupCaptureV3KeyBundleProvider,
  type AgentBackupCaptureV3ManifestAuthority,
  deriveAgentBackupCaptureV3RuntimePrincipalSha256,
  deriveAgentBackupCaptureV3SpoolAuthorityDigests,
  runAgentBackupCaptureV2Pipeline,
} from "./agent-backup-capture-v2-pipeline";
import type { AgentBackupCaptureV3SpoolConfig } from "./agent-backup-capture-v2-spool";
import type { AgentBackupCaptureV3TerminalSpoolCleanupAuthority } from "./agent-backup-capture-v3-spool-cleanup";
import type { AgentBackupCatalogRuntimeCaptureExecutor } from "./agent-backup-catalog-runtime";

const DEFAULT_CAPTURE_DEADLINE_MS = 14 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOCKER_ID_PATTERN = /^[0-9a-f]{64}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_SERVER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const LEGACY_WRITER_DRAIN_FORMAT =
  "elizaos.agent-backup.capture-v3-legacy-writer-drain.v1" as const;

export interface AgentBackupCaptureV2RuntimeAttestation {
  organizationId: string;
  /** Durable `agent_sandboxes.id`; this is the only identity used below HTTP. */
  catalogAgentId: string;
  /** Runtime `character_id`; this is used only on the `/api/snapshot/v2` wire. */
  runtimeAgentId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  source: AgentBackupManifestV3["source"];
  runtime: AgentBackupManifestV3["runtime"];
  watermarks: AgentBackupManifestV3["watermarks"];
}

export interface AgentBackupCaptureV2CatalogExecutionContext {
  /** Exact, independently sourced sandbox/runtime evidence for this generation. */
  attestation: AgentBackupCaptureV2RuntimeAttestation;
  /** Must re-read authority; replaying `attestation` without checking is invalid. */
  revalidateAttestation(signal?: AbortSignal): Promise<AgentBackupCaptureV2RuntimeAttestation>;
  /** Already-authorized and SSRF-checked route to the exact reserved container. */
  transport: {
    agentApiBaseUrl: string;
    apiToken: string;
    fetch?: typeof fetch;
  };
  spool: AgentBackupCaptureV3SpoolConfig;
  keyBundle: AgentBackupCaptureV3KeyBundleProvider;
  kms: AgentBackupCaptureV3ManifestAuthority["kms"];
  /** Primary-database vault generation selected before any capture bytes flow. */
  vaultKeyAuthority: AgentBackupManifestV3["vaultKeyAuthority"];
}

export interface ResolveAgentBackupCaptureV2CatalogExecutionContextInput {
  claim: Readonly<AgentBackupOperationClaim>;
  request: Readonly<AgentBackupCaptureV2Request>;
  expectedSource: Readonly<AgentBackupManifestV3["source"]>;
  /** Context resolution may heartbeat while contacting external authorities. */
  heartbeat(): Promise<true>;
  signal?: AbortSignal;
}

export type ResolveAgentBackupCaptureV2CatalogExecutionContext = (
  input: ResolveAgentBackupCaptureV2CatalogExecutionContextInput,
) => Promise<AgentBackupCaptureV2CatalogExecutionContext>;

export interface ExecuteAgentBackupCaptureV2CatalogClaimDependencies {
  resolveContext: ResolveAgentBackupCaptureV2CatalogExecutionContext;
  heartbeatOperation?: typeof heartbeatAgentBackupOperation;
  loadManifestChainAuthority?: typeof loadAgentBackupManifestChainAuthority;
  /** Must be the manifest-v3 repository boundary; v2 repositories are incompatible. */
  recordCaptured(params: {
    organizationId: string;
    backupId: string;
    operationId: string;
    expectedActivationGeneration: string;
    expectedLifecycleRevision: string;
    execution: { ownerId: string; generation: string };
    manifest: AgentBackupCaptureV3CatalogManifest;
  }): Promise<unknown>;
  now?: () => number;
  captureDeadlineMs?: number;
}

/** Deployment evidence that every pre-v3 spool writer has exited before activation. */
export interface AgentBackupCaptureV3LegacyWriterDrainReceipt {
  format: typeof LEGACY_WRITER_DRAIN_FORMAT;
  deploymentId: string;
  drainedAt: string;
}

function assertLegacyWriterDrainReceipt(
  receipt: Readonly<AgentBackupCaptureV3LegacyWriterDrainReceipt>,
): void {
  if (
    receipt.format !== LEGACY_WRITER_DRAIN_FORMAT ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.deploymentId) ||
    !Number.isFinite(Date.parse(receipt.drainedAt)) ||
    new Date(receipt.drainedAt).toISOString() !== receipt.drainedAt
  ) {
    executorError(
      "AGENT_BACKUP_V3_LEGACY_WRITERS_NOT_DRAINED",
      "Capture-v3 activation requires a canonical legacy-writer drain receipt",
    );
  }
}

export interface ExecuteAgentBackupCaptureV2CatalogClaimInput {
  claim: Readonly<AgentBackupOperationClaim>;
  leaseMs: number;
  dependencies: ExecuteAgentBackupCaptureV2CatalogClaimDependencies;
  signal?: AbortSignal;
}

export type AgentBackupCaptureV2CatalogClaimResult = Extract<
  AgentBackupCaptureV2PipelineResult,
  { state: "captured-upload-pending" }
>;

function executorError(code: string, message: string, cause?: unknown): never {
  throw createAgentBackupCaptureV2ExecutorError(code, message, cause);
}

function requireString(value: string | null, field: string): string {
  if (!value) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INCOMPLETE",
      `Catalogue claim is missing ${field}`,
    );
  }
  return value;
}

function expectedSourceFromClaim(
  claim: Readonly<AgentBackupOperationClaim>,
): AgentBackupManifestV3["source"] {
  const backup = claim.backup;
  const nodeRecordId = requireString(backup.source_node_record_id, "source_node_record_id");
  const nodeId = requireString(backup.source_node_id, "source_node_id");
  const nodeIncarnation = requireString(backup.source_node_incarnation, "source_node_incarnation");
  const containerId = requireString(backup.source_container_id, "source_container_id");
  const providerHandle = requireString(backup.source_provider_handle, "source_provider_handle");
  if (
    !UUID_PATTERN.test(nodeRecordId) ||
    !UUID_PATTERN.test(nodeIncarnation) ||
    !NODE_ID_PATTERN.test(nodeId)
  ) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
      "Catalogue claim has a non-canonical node authority",
    );
  }
  if (!DOCKER_ID_PATTERN.test(containerId)) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
      "Catalogue claim has a non-canonical immutable container ID",
    );
  }
  if (providerHandle === containerId) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
      "Mutable provider handle cannot replace the immutable container ID",
    );
  }
  const base = {
    provider: "hetzner" as const,
    nodeRecordId,
    nodeId,
    nodeIncarnation,
    containerId,
  };
  if (backup.source_provider === "operator-onboarded") {
    if (backup.source_provider_server_id !== null) {
      executorError(
        "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
        "Robot claim unexpectedly contains a Cloud server authority",
      );
    }
    return { kind: "robot", ...base };
  }
  if (backup.source_provider === "hetzner-cloud") {
    const providerServerId = requireString(
      backup.source_provider_server_id,
      "source_provider_server_id",
    );
    if (
      !PROVIDER_SERVER_ID_PATTERN.test(providerServerId) ||
      BigInt(providerServerId) > UINT64_MAX
    ) {
      executorError(
        "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
        "Cloud claim has a non-canonical provider server authority",
      );
    }
    return {
      kind: "cloud",
      ...base,
      providerServerId,
    };
  }
  executorError(
    "AGENT_BACKUP_V2_CLAIM_AUTHORITY_INVALID",
    "Catalogue claim has an unsupported source provider",
  );
}

function claimRequest(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  deadlineEpochMs: number;
}): AgentBackupCaptureV2Request {
  const backup = params.claim.backup;
  if (
    backup.catalog_state !== "capturing" ||
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null
  ) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_NOT_CAPTURING",
      "Capture executor requires one complete owned capturing claim",
    );
  }
  return {
    format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    operationId: backup.backup_operation_id,
    agentId: backup.catalog_agent_id,
    activationGeneration: backup.lifecycle_generation,
    lifecycleRevision: backup.lifecycle_revision.toString(),
    deadlineEpochMs: params.deadlineEpochMs,
  };
}

function canonicalCreatedAt(claim: Readonly<AgentBackupOperationClaim>): string {
  const createdAt = claim.backup.created_at;
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    executorError(
      "AGENT_BACKUP_V2_CLAIM_CREATED_AT_INVALID",
      "Catalogue claim has no canonical durable reservation timestamp",
    );
  }
  return createdAt.toISOString();
}

function assertAttestation(params: {
  attestation: Readonly<AgentBackupCaptureV2RuntimeAttestation>;
  request: Readonly<AgentBackupCaptureV2Request>;
  organizationId: string;
  expectedSource: Readonly<AgentBackupManifestV3["source"]>;
  expected?: Readonly<AgentBackupCaptureV2RuntimeAttestation>;
}): void {
  const observed = params.attestation;
  if (
    observed.organizationId !== params.organizationId ||
    observed.catalogAgentId !== params.request.agentId ||
    !UUID_PATTERN.test(observed.runtimeAgentId) ||
    observed.activationGeneration !== params.request.activationGeneration ||
    observed.lifecycleRevision !== params.request.lifecycleRevision ||
    !isDeepStrictEqual(observed.source, params.expectedSource)
  ) {
    executorError(
      "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_MISMATCH",
      "Runtime attestation does not match the exact catalogue source generation",
    );
  }
  if (params.expected && !isDeepStrictEqual(observed, params.expected)) {
    executorError(
      "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_CHANGED",
      "Runtime attestation changed while capture held the catalogue lease",
    );
  }
}

function readCaptureDeadlineMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CAPTURE_DEADLINE_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs
  ) {
    executorError(
      "AGENT_BACKUP_V2_CAPTURE_DEADLINE_INVALID",
      `Capture deadline must be between 1 and ${AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs}`,
    );
  }
  return resolved;
}

interface CaptureExecutionControl {
  readonly signal: AbortSignal;
  await<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T>;
  close(): void;
}

function captureControlError(signal: AbortSignal): AgentBackupCaptureV2CatalogExecutorError {
  const reason = signal.reason;
  if (reason instanceof AgentBackupCaptureV2CatalogExecutorError) return reason;
  return createAgentBackupCaptureV2ExecutorError(
    "AGENT_BACKUP_V2_CAPTURE_ABORTED",
    "Catalogue capture execution was cancelled",
    reason,
  );
}

function createCaptureExecutionControl(params: {
  deadlineEpochMs: number;
  now: () => number;
  callerSignal?: AbortSignal;
}): CaptureExecutionControl {
  const controller = new AbortController();
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        createAgentBackupCaptureV2ExecutorError(
          "AGENT_BACKUP_V2_CAPTURE_ABORTED",
          "Catalogue capture execution was cancelled",
          params.callerSignal?.reason,
        ),
      );
    }
  };
  if (params.callerSignal?.aborted) abortFromCaller();
  else params.callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const remainingMs = params.deadlineEpochMs - params.now();
  const timer = setTimeout(
    () => {
      if (!controller.signal.aborted) {
        controller.abort(
          createAgentBackupCaptureV2ExecutorError(
            "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
            "Catalogue capture execution exceeded its absolute deadline",
          ),
        );
      }
    },
    Math.max(0, Math.min(remainingMs, 2_147_483_647)),
  );

  return {
    signal: controller.signal,
    async await<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
      if (controller.signal.aborted) throw captureControlError(controller.signal);
      const pending = Promise.resolve().then(operation);
      let abortListener: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(captureControlError(controller.signal));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      try {
        return await Promise.race([pending, interrupted]);
      } catch (cause) {
        if (controller.signal.aborted) {
          // Non-cancellable authorities may settle after the caller has left.
          // Keep their rejection observed without allowing late success to
          // advance HTTP, spool, or catalogue state.
          void pending.catch((_lateFailure: unknown) => undefined);
          throw captureControlError(controller.signal);
        }
        throw cause;
      } finally {
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
    },
    close() {
      clearTimeout(timer);
      params.callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/** Execute one already-normalized `capturing` claim, stopping before upload. */
export async function executeAgentBackupCaptureV2CatalogClaim(
  input: Readonly<ExecuteAgentBackupCaptureV2CatalogClaimInput>,
): Promise<AgentBackupCaptureV2CatalogClaimResult> {
  const now = input.dependencies.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    executorError("AGENT_BACKUP_V2_CLOCK_INVALID", "Capture runtime clock is invalid");
  }
  const request = claimRequest({
    claim: input.claim,
    deadlineEpochMs: nowMs + readCaptureDeadlineMs(input.dependencies.captureDeadlineMs),
  });
  if (!Number.isSafeInteger(request.deadlineEpochMs)) {
    executorError("AGENT_BACKUP_V2_CLOCK_INVALID", "Capture deadline exceeds safe integer range");
  }
  const organizationId = input.claim.backup.catalog_organization_id as string;
  const expectedSource = expectedSourceFromClaim(input.claim);
  const execution = {
    ownerId: input.claim.ownerId,
    generation: input.claim.generation,
  };
  const control = createCaptureExecutionControl({
    deadlineEpochMs: request.deadlineEpochMs,
    now,
    callerSignal: input.signal,
  });
  const heartbeatOperation = input.dependencies.heartbeatOperation ?? heartbeatAgentBackupOperation;
  const heartbeatCatalog = async (): Promise<true> => {
    await control.await("Catalogue lease heartbeat", () =>
      heartbeatOperation({
        organizationId,
        backupId: input.claim.backup.id,
        execution,
        leaseMs: input.leaseMs,
      }),
    );
    return true;
  };

  try {
    await heartbeatCatalog();
    const context = await control.await("Capture context resolution", () =>
      input.dependencies.resolveContext({
        claim: input.claim,
        request,
        expectedSource,
        heartbeat: heartbeatCatalog,
        signal: control.signal,
      }),
    );
    if (context.kms.provider !== "steward") {
      executorError(
        "AGENT_BACKUP_V3_KMS_AUTHORITY_INVALID",
        "Durable Hetzner capture requires a Steward-wrapped operation key bundle",
      );
    }
    assertAttestation({
      attestation: context.attestation,
      request,
      organizationId,
      expectedSource,
    });
    const initialAttestation = structuredClone(context.attestation);
    // The catalogue request remains the sole durable manifest/KMS/spool
    // authority. The agent runtime has a distinct character UUID and sees a
    // wire-only copy, which cannot flow back into pipeline state.
    const runtimeRequest: AgentBackupCaptureV2Request = {
      ...request,
      agentId: initialAttestation.runtimeAgentId,
    };
    const runtimePrincipalSha256 = deriveAgentBackupCaptureV3RuntimePrincipalSha256(
      initialAttestation.runtimeAgentId,
    );
    const heartbeat = async (): Promise<true> => {
      await heartbeatCatalog();
      const current = await control.await("Runtime attestation revalidation", () =>
        context.revalidateAttestation(control.signal),
      );
      assertAttestation({
        attestation: current,
        request,
        organizationId,
        expectedSource,
        expected: initialAttestation,
      });
      return true;
    };
    await heartbeat();

    const chain = await control.await("Manifest chain authority load", () =>
      (input.dependencies.loadManifestChainAuthority ?? loadAgentBackupManifestChainAuthority)({
        organizationId,
        backupId: input.claim.backup.id,
        operationId: request.operationId,
        execution,
      }),
    );
    await heartbeat();

    const authority: AgentBackupCaptureV3ManifestAuthority = {
      createdAt: canonicalCreatedAt(input.claim),
      organizationId,
      source: expectedSource,
      runtime: initialAttestation.runtime,
      chain,
      watermarks: initialAttestation.watermarks,
      kms: context.kms,
      vaultKeyAuthority: context.vaultKeyAuthority,
    };
    const terminalSpoolCleanup: AgentBackupCaptureV3TerminalSpoolCleanupAuthority = {
      organizationId,
      agentId: request.agentId,
      backupId: input.claim.backup.id,
      operationId: request.operationId,
      activationGeneration: request.activationGeneration,
      lifecycleRevision: request.lifecycleRevision,
      ...deriveAgentBackupCaptureV3SpoolAuthorityDigests({ request, authority }),
      runtimePrincipalSha256,
    };
    const recordCaptured = input.dependencies.recordCaptured;
    let result: AgentBackupCaptureV2PipelineResult;
    try {
      result = await control.await("Capture-v2 pipeline", () =>
        runAgentBackupCaptureV2Pipeline({
          request,
          runtimePrincipalSha256,
          executionToken: input.claim.generation,
          authority,
          openCapture: (signal) =>
            openAgentBackupCaptureV2({
              ...context.transport,
              request: runtimeRequest,
              signal,
              now,
            }),
          spool: context.spool,
          keyBundle: context.keyBundle,
          publication: {
            mode: "capture-only",
            async recordCaptured(artifacts) {
              await recordCaptured({
                organizationId,
                backupId: input.claim.backup.id,
                operationId: request.operationId,
                expectedActivationGeneration: request.activationGeneration,
                expectedLifecycleRevision: request.lifecycleRevision,
                execution,
                manifest: artifacts.catalogManifest,
              });
              return true;
            },
          },
          heartbeat,
          signal: control.signal,
          now,
        }),
      );
    } catch (cause) {
      const terminal = normalizeAgentBackupCaptureV2TerminalFailure(cause, terminalSpoolCleanup);
      if (terminal) throw terminal;
      throw cause;
    }
    if (result.state !== "captured-upload-pending") {
      executorError(
        "AGENT_BACKUP_V2_CAPTURE_ONLY_BOUNDARY_BROKEN",
        "Capture executor unexpectedly crossed into publication",
      );
    }
    return result;
  } finally {
    control.close();
  }
}

export { AgentBackupCaptureV2CatalogExecutorError } from "./agent-backup-capture-v2-failure-disposition";

/** Bind deployment authorities once, then inject this executor into the catalogue runtime. */
export function createAgentBackupCaptureV2CatalogExecutor(
  dependencies: ExecuteAgentBackupCaptureV2CatalogClaimDependencies,
  legacyWriterDrain: Readonly<AgentBackupCaptureV3LegacyWriterDrainReceipt>,
): AgentBackupCatalogRuntimeCaptureExecutor {
  // A filesystem lock can fence other v3 claimants, but code deployed before
  // that lock existed cannot observe it. Requiring a deployment-produced drain
  // receipt makes rolling activation fail closed until those processes exit.
  assertLegacyWriterDrainReceipt(legacyWriterDrain);
  return {
    execute: ({ claim, leaseMs, signal }) =>
      executeAgentBackupCaptureV2CatalogClaim({
        claim,
        leaseMs,
        dependencies,
        signal,
      }),
  };
}

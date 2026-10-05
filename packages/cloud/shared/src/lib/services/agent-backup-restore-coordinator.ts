/**
 * Manifest-v3 restore coordinator (#20732).
 *
 * One turn advances one restore operation by at most one phase:
 *
 *   reserved/vault_seeded  exact quarantined create (+ reconciliation)
 *   container_created      start quarantine, prepare private roots, stream and
 *                          seal the candidate inside it          -> restoring
 *   restoring              prepare + commit the generation       -> committed
 *   committed              retain the previous runtime stopped, attach the
 *                          agent network, hand over the boot grant, launch the
 *                          committed generation and verify its signed boot
 *                          attestation                           -> restart_attested
 *   restart_attested       repeated signed probes                -> probed
 *   probed                 activation publication + route CAS    -> published
 *   published              retire the previous runtime, final receipt,
 *                          release the lease                     -> finalized
 *
 * Failure policy is fail-closed. Before any runtime effect a failure is
 * retryable with exponential backoff. Once the previous runtime has been
 * stopped (committed, restart_attested, probed) a failure rolls back: the
 * restored container is stopped, the previous runtime is restarted in place,
 * the restore activation is blocked and the operation ends terminally. The
 * canonical route never moves before `published`; after it, rollback no longer
 * applies and finalization is retried until it settles.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AgentBackupRestoreV3CandidateReceiptSchema } from "@elizaos/contracts";
import {
  type AgentBackupRestoreV3Attestation,
  type AgentBackupRestoreV3AttestationBody,
  type AgentBackupRestoreV3BootGrant,
  agentBackupRestoreV3ContainerRoots,
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
  verifyAgentBackupRestoreV3Attestation,
} from "@elizaos/contracts/node";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreSourceV3Input } from "../../db/repositories/agent-backup-restore";
import {
  commitAgentBackupRestore,
  recordAgentActivationPublication,
} from "../../db/repositories/agent-backup-restore-history";
import {
  releaseAgentBackupRestoreLease,
  renewAgentBackupRestoreLease,
} from "../../db/repositories/agent-backup-restore-lease";
import {
  advanceAgentBackupRestoreOperation,
  claimAgentBackupRestoreOperation,
  failAgentBackupRestoreOperation,
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
} from "../../db/repositories/agent-backup-restore-operations";
import {
  type AgentBackupRestoreContainerAuthority,
  type AgentBackupRestorePreviousRoute,
  type AgentBackupRestoreServingClaim,
  type AgentBackupRestoreServingState,
  type AgentBackupRestoreTerminalCleanup,
  abandonAgentBackupRestoreWithExpiredLease,
  advanceAgentBackupRestoreServingPhase,
  beginAgentBackupRestoreTerminalCleanup,
  failAgentBackupRestoreBeforeRoute,
  finishAgentBackupRestoreTerminalCleanup,
  listAgentBackupRestoreTerminalCleanups,
  listDueAgentBackupRestoreOperations,
  loadAgentBackupRestoreContainerAuthority,
  loadClaimedAgentBackupRestoreServingAuthority,
  publishAgentBackupRestoreRoute,
  readAgentBackupRestoreServingState,
  recordAgentBackupRestorePreviousRuntimeRetired,
  recordAgentBackupRestoreRestartAttested,
  recordAgentBackupRestoreServingEvidence,
  resolveAgentBackupRestoreReservedNodeId,
  selectAgentBackupRestoreTargetNode,
  snapshotAgentBackupRestorePreviousRoute,
} from "../../db/repositories/agent-backup-restore-serving";
import type {
  AgentBackupRestoreOperation,
  AgentBackupRestorePhase,
} from "../../db/schemas/agent-backup-catalog";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import { logger } from "../utils/logger";
import { AGENT_BACKUP_RESTORE_COORDINATOR_LEASE_MS } from "./agent-backup-restore-admission";
import type { AgentBackupRestoreEnabledCoordinatorConfig } from "./agent-backup-restore-coordinator-runtime";
import {
  type AgentBackupRestoreQuarantinePreparationResult,
  prepareAgentBackupRestoreQuarantine,
} from "./agent-backup-restore-quarantine-preparation";
import {
  buildAgentBackupRestoreExactCleanupReceiptDigestV1,
  reconcileAgentBackupRestoreQuarantinedCreate,
} from "./agent-backup-restore-quarantined-create-runtime";
import {
  type AgentBackupRestoreContainerTransport,
  createDockerAgentBackupRestoreContainerTransport,
} from "./agent-backup-restore-serving-transport";
import type { StreamAgentBackupRestoreV3Result } from "./agent-backup-restore-v3-stream";
import type { SandboxRuntimeIdentity } from "./sandbox-runtime-observation";

/** Long enough for a full candidate stream; renewed by the next turn. */
const EFFECT_CLAIM_MS = 3_600_000;
const BOOT_ATTESTATION_DEADLINE_MS = 10 * 60_000;
/** Covers the boot attestation deadline plus settlement margin. */
const SERVING_CLAIM_MS = 15 * 60_000;
const BOOT_ATTESTATION_POLL_MS = 5_000;
const PROBE_COUNT = 3;
const PROBE_SPACING_MS = 2_000;
const MAX_RETRY_DELAY_MS = 3_600_000;

export type AgentBackupRestoreCoordinatorTurnStatus =
  | "advanced"
  | "retry_scheduled"
  | "rolled_back"
  | "reconciliation_required"
  | "finalized"
  | "terminal"
  | "skipped";

export interface AgentBackupRestoreCoordinatorTurnResult {
  readonly operationId: string;
  readonly fromPhase: AgentBackupRestorePhase;
  readonly status: AgentBackupRestoreCoordinatorTurnStatus;
  readonly errorCode?: string;
}

/** Streaming inputs the worker composition owns (KMS key bundle + storage). */
export interface AgentBackupRestoreCoordinatorStreamer {
  stream(input: {
    source: AgentBackupRestoreSourceV3Input;
    quarantine: {
      authority: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput;
      roots: {
        trustedRoot: string;
        attemptRoot: string;
        trustedRootIdentity: { device: string; inode: string };
        attemptRootIdentity: { device: string; inode: string };
      };
    };
    signal: AbortSignal;
    deadlineEpochMs: number;
  }): Promise<StreamAgentBackupRestoreV3Result>;
}

/** Provider operations on the previous (currently routed) runtime. */
export interface AgentBackupRestorePreviousRuntimeProvider {
  observe(sandbox: Readonly<AgentSandbox>): Promise<SandboxRuntimeIdentity | null>;
  retainStopped(identity: SandboxRuntimeIdentity): Promise<void>;
  startRetained(identity: SandboxRuntimeIdentity): Promise<void>;
  /** Exact removal of the retained previous container (identity-bound, not route-bound). */
  remove(identity: SandboxRuntimeIdentity): Promise<void>;
}

export interface AgentBackupRestoreCoordinatorDependencies {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  randomUuid(): string;
  randomToken(): string;
  loadOperation(operationId: string): Promise<Readonly<AgentBackupRestoreOperation> | null>;
  abandonExpired: typeof abandonAgentBackupRestoreWithExpiredLease;
  renewLease: typeof renewAgentBackupRestoreLease;
  releaseLease: typeof releaseAgentBackupRestoreLease;
  claim: typeof claimAgentBackupRestoreOperation;
  advance: typeof advanceAgentBackupRestoreOperation;
  fail: typeof failAgentBackupRestoreOperation;
  selectTarget: typeof selectAgentBackupRestoreTargetNode;
  resolveReservedNodeId: typeof resolveAgentBackupRestoreReservedNodeId;
  encryptToken(operation: Readonly<AgentBackupRestoreOperation>, token: string): Promise<string>;
  decryptToken(
    operation: Readonly<AgentBackupRestoreOperation>,
    ciphertext: string,
  ): Promise<string>;
  prepareQuarantine(
    input: Parameters<typeof prepareAgentBackupRestoreQuarantine>[0],
  ): Promise<AgentBackupRestoreQuarantinePreparationResult>;
  reconcileCreate: typeof reconcileAgentBackupRestoreQuarantinedCreate;
  loadContainer: typeof loadAgentBackupRestoreContainerAuthority;
  loadClaimed: typeof loadClaimedAgentBackupRestoreServingAuthority;
  recordEvidence: typeof recordAgentBackupRestoreServingEvidence;
  advanceServing: typeof advanceAgentBackupRestoreServingPhase;
  recordRestartAttested: typeof recordAgentBackupRestoreRestartAttested;
  recordPublication: typeof recordAgentActivationPublication;
  publishRoute: typeof publishAgentBackupRestoreRoute;
  recordPreviousRuntimeRetired: typeof recordAgentBackupRestorePreviousRuntimeRetired;
  commitRestore: typeof commitAgentBackupRestore;
  failBeforeRoute: typeof failAgentBackupRestoreBeforeRoute;
  beginTerminalCleanup: typeof beginAgentBackupRestoreTerminalCleanup;
  finishTerminalCleanup: typeof finishAgentBackupRestoreTerminalCleanup;
  listTerminalCleanups: typeof listAgentBackupRestoreTerminalCleanups;
  /** Exact removal of a failed restore container, its staging volume and secrets. */
  removeRestoreContainer(cleanup: Readonly<AgentBackupRestoreTerminalCleanup>): Promise<void>;
  transport(
    authority: Readonly<AgentBackupRestoreContainerAuthority>,
  ): AgentBackupRestoreContainerTransport;
  previousRuntime: AgentBackupRestorePreviousRuntimeProvider;
  streamer: AgentBackupRestoreCoordinatorStreamer;
}

type Config = AgentBackupRestoreEnabledCoordinatorConfig;

function coordinatorError(code: string, message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, { code, cause, severity: "ephemeral" });
}

function errorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(code)
    ? code
    : "AGENT_BACKUP_RESTORE_COORDINATOR_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeAgentBackupRestoreV3ServingValue(value), "utf8")
    .digest("hex");
}

function sourceInput(
  operation: Readonly<AgentBackupRestoreOperation>,
): AgentBackupRestoreSourceV3Input {
  return {
    organizationId: operation.organization_id,
    agentId: operation.agent_id,
    backupId: operation.backup_id,
    operationId: operation.expected_operation_id,
    sourceActivationGeneration: operation.expected_activation_generation,
    sourceLifecycleRevision: operation.expected_lifecycle_revision.toString(),
    expectedManifestSha256: operation.expected_manifest_sha256,
    restoreAttemptId: operation.restore_attempt_id,
    leaseId: operation.lease_id,
    ownerId: operation.lease_owner_id,
    fencingToken: operation.lease_generation,
    catalogEpoch: operation.catalog_epoch.toString(),
    copyRole: operation.copy_role,
  };
}

function retryDelayMs(config: Config, attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(config.retryBaseMs * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

/** Verify a signed attestation against the exact durable restore authority. */
export function verifyAgentBackupRestoreAttestationForOperation(params: {
  token: string;
  attestation: unknown;
  nonce: string;
  operation: Readonly<AgentBackupRestoreOperation>;
  tokenSha256: string;
  committedReceiptSha256: string;
  containerPort: number;
}): AgentBackupRestoreV3AttestationBody {
  const body = verifyAgentBackupRestoreV3Attestation(params.token, params.attestation);
  const { operation } = params;
  if (
    !body ||
    body.nonce !== params.nonce ||
    body.agentId !== operation.agent_id ||
    body.organizationId !== operation.organization_id ||
    body.restoreAttemptId !== operation.restore_attempt_id ||
    body.containerId !== operation.expected_container_id ||
    body.nodeIncarnation !== operation.expected_node_incarnation ||
    body.committedReceiptSha256 !== params.committedReceiptSha256 ||
    body.tokenSha256 !== params.tokenSha256 ||
    body.listenPort !== params.containerPort
  ) {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_ATTESTATION_INVALID",
      "Restored runtime attestation is unsigned or differs from its restore authority",
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

interface TurnContext {
  readonly config: Config;
  readonly deps: AgentBackupRestoreCoordinatorDependencies;
  readonly signal: AbortSignal;
}

async function claimFor(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreServingClaim & { attempts: number }> {
  const claimed = await context.deps.claim({
    operationId: operation.id,
    ownerId: context.config.workerId,
    // Streaming a whole backup may take the full window. Once the previous
    // runtime can be stopped, a crashed worker must hand over quickly: the
    // agent is unavailable until the next claimant rolls forward or back.
    claimMs:
      operation.phase === "container_created" || operation.phase === "restoring"
        ? EFFECT_CLAIM_MS
        : SERVING_CLAIM_MS,
  });
  return {
    operationId: operation.id,
    ownerId: context.config.workerId,
    claimGeneration: claimed.claimGeneration,
    attempts: claimed.operation.attempts,
  };
}

async function scheduleRetry(
  context: TurnContext,
  claim: AgentBackupRestoreServingClaim & { attempts: number },
  phase: AgentBackupRestorePhase,
  error: unknown,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const code = errorCode(error);
  await context.deps.fail({
    operationId: claim.operationId,
    ownerId: claim.ownerId,
    claimGeneration: claim.claimGeneration,
    retryable: true,
    resumePhase: phase,
    errorCode: code,
    error: errorMessage(error),
    failureDigest: sha256Canonical({
      format: "eliza.agent-backup-restore.coordinator-retry.v1",
      operationId: claim.operationId,
      claimGeneration: claim.claimGeneration,
      phase,
      code,
    }),
    retryDelayMs: retryDelayMs(context.config, claim.attempts),
  });
  logger.warn("[AgentBackupRestoreCoordinator] Restore phase failed; retry scheduled", {
    operationId: claim.operationId,
    phase,
    errorCode: code,
    attempts: claim.attempts,
    error: errorMessage(error),
  });
  return "retry_scheduled";
}

/**
 * A terminally failed restore frees its backup for a new restore attempt.
 * The terminal record is already durable; if the release is lost the lease
 * still lapses at its expiry, so the failure is reported, not rethrown.
 */
/**
 * Remove a terminally failed, never-routed restore container. The replacement
 * attempt is fenced (cleanup_in_progress) before the remote removal and
 * settled (cleanup_proven, node slot released) only after exact absence, so
 * the agent's replacement fence is freed without ever racing a late adopter.
 */
export async function cleanupTerminalAgentBackupRestore(
  deps: Pick<
    AgentBackupRestoreCoordinatorDependencies,
    "beginTerminalCleanup" | "finishTerminalCleanup" | "removeRestoreContainer" | "loadOperation"
  >,
  operationId: string,
): Promise<"settled" | "cleaned"> {
  const fenced = await deps.beginTerminalCleanup(operationId);
  if (fenced.settled) return "settled";
  const operation = await deps.loadOperation(operationId);
  if (!operation) {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_OPERATION_MISSING",
      "Restore operation is missing",
    );
  }
  await deps.removeRestoreContainer(fenced);
  await deps.finishTerminalCleanup({
    operationId,
    receiptDigest: buildAgentBackupRestoreExactCleanupReceiptDigestV1({
      operation,
      replacementAttemptId: fenced.replacementAttemptId,
      locator: fenced.locator,
    }),
  });
  return "cleaned";
}

async function cleanupAfterTerminal(context: TurnContext, operationId: string): Promise<void> {
  try {
    await cleanupTerminalAgentBackupRestore(context.deps, operationId);
  } catch (error) {
    // error-policy:J6 the terminal record is durable; the cycle's cleanup
    // sweep retries the exact removal until the replacement fence settles.
    logger.warn("[AgentBackupRestoreCoordinator] Terminal restore cleanup deferred", {
      operationId,
      errorCode: errorCode(error),
      error: errorMessage(error),
    });
  }
}

async function releaseLeaseAfterTerminal(context: TurnContext, operationId: string): Promise<void> {
  try {
    const operation = await context.deps.loadOperation(operationId);
    if (operation) await context.deps.releaseLease(sourceInput(operation));
  } catch (error) {
    // error-policy:J6 best-effort release after a durable terminal record.
    logger.warn("[AgentBackupRestoreCoordinator] Terminal restore lease release failed", {
      operationId,
      errorCode: errorCode(error),
      error: errorMessage(error),
    });
  }
}

/**
 * Pre-boot failures retry until the attempt budget is spent, then close the
 * restore without touching the previous route.
 */
async function failPreBoot(
  context: TurnContext,
  claim: AgentBackupRestoreServingClaim & { attempts: number },
  phase: AgentBackupRestorePhase,
  error: unknown,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  if (claim.attempts < context.config.maxAttempts) {
    return scheduleRetry(context, claim, phase, error);
  }
  await context.deps.failBeforeRoute({
    ...claim,
    phase,
    errorCode: errorCode(error),
    error: `Restore exhausted ${claim.attempts} attempts: ${errorMessage(error)}`,
  });
  await cleanupAfterTerminal(context, claim.operationId);
  await releaseLeaseAfterTerminal(context, claim.operationId);
  logger.error("[AgentBackupRestoreCoordinator] Restore exhausted its attempts", {
    operationId: claim.operationId,
    phase,
    errorCode: errorCode(error),
  });
  return "terminal";
}

/**
 * Fail-closed rollback for a failure after the previous runtime was stopped:
 * stop the restored container, restart the retained previous runtime and
 * close the operation. Every rollback step runs; any failure is retained and
 * rethrown after the durable terminal record so an operator is alerted.
 */
async function rollbackBeforeRoute(
  context: TurnContext,
  claim: AgentBackupRestoreServingClaim,
  phase: AgentBackupRestorePhase,
  container: Readonly<AgentBackupRestoreContainerAuthority>,
  previousRoute: Readonly<AgentBackupRestorePreviousRoute> | undefined,
  cause: unknown,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const rollbackFailures: unknown[] = [];
  try {
    await context.deps.transport(container).stop();
  } catch (error) {
    // error-policy:J2 keep rolling back; the failure is reported below.
    rollbackFailures.push(error);
  }
  if (previousRoute?.runtime) {
    try {
      await context.deps.previousRuntime.startRetained(previousRoute.runtime);
    } catch (error) {
      // error-policy:J2 keep rolling back; the failure is reported below.
      rollbackFailures.push(error);
    }
  }
  const code =
    rollbackFailures.length > 0 ? "AGENT_BACKUP_RESTORE_ROLLBACK_INCOMPLETE" : errorCode(cause);
  await context.deps.failBeforeRoute({
    ...claim,
    phase,
    errorCode: code,
    error:
      rollbackFailures.length > 0
        ? `Restore ${phase} failed (${errorMessage(cause)}) and rollback was incomplete: ${rollbackFailures
            .map(errorMessage)
            .join("; ")}`
        : `Restore ${phase} failed and was rolled back: ${errorMessage(cause)}`,
  });
  // A container that could not be stopped keeps its fence for the sweep.
  if (rollbackFailures.length === 0) await cleanupAfterTerminal(context, claim.operationId);
  await releaseLeaseAfterTerminal(context, claim.operationId);
  if (rollbackFailures.length > 0) {
    logger.error("[AgentBackupRestoreCoordinator] Restore rollback incomplete", {
      operationId: claim.operationId,
      phase,
      errorCode: errorCode(cause),
    });
    throw new AggregateError(
      [cause, ...rollbackFailures],
      "Restore failed and its rollback could not fully restore the previous runtime",
    );
  }
  logger.warn("[AgentBackupRestoreCoordinator] Restore rolled back before route publication", {
    operationId: claim.operationId,
    phase,
    errorCode: errorCode(cause),
  });
  return "rolled_back";
}

async function runCreate(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps, config } = context;
  let target: {
    nodeRecordId: string;
    nodeId: string;
    nodeIncarnation: string;
    nodeHistoryId: string;
  } | null = null;
  if (
    operation.expected_node_record_id &&
    operation.expected_node_incarnation &&
    operation.expected_node_history_id
  ) {
    // A reserved target is replayed exactly; it is never reselected.
    const nodeId = operation.expected_container_id
      ? (await deps.loadContainer(operation.id)).node.nodeId
      : await deps.resolveReservedNodeId(operation.expected_node_record_id);
    if (!nodeId) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_TARGET_UNRESOLVED",
        "Reserved restore target is no longer resolvable to a logical node",
      );
    }
    target = {
      nodeRecordId: operation.expected_node_record_id,
      nodeId,
      nodeIncarnation: operation.expected_node_incarnation,
      nodeHistoryId: operation.expected_node_history_id,
    };
  } else {
    target = await deps.selectTarget(operation);
  }
  if (!target) {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_NO_ELIGIBLE_TARGET",
      "No eligible node has capacity for the restore",
    );
  }
  const token = deps.randomToken();
  const prepared = await deps.prepareQuarantine({
    enabled: true,
    create: {
      operationId: operation.id,
      ownerId: config.workerId,
      target,
      replacementAttemptId: deps.randomUuid(),
      activationTokenSha256: agentBackupRestoreV3TokenSha256(token),
      activationTokenCiphertext: await deps.encryptToken(operation, token),
      signal: context.signal,
    },
    control: {
      signal: context.signal,
      deadlineEpochMs: deps.now() + EFFECT_CLAIM_MS,
    },
  });
  if (prepared.status === "reconciliation_required") {
    const reconciled = await deps.reconcileCreate({
      operationId: operation.id,
      ownerId: config.workerId,
      replacementAttemptId: prepared.replacementAttemptId,
    });
    logger.warn("[AgentBackupRestoreCoordinator] Ambiguous restore create reconciled", {
      operationId: operation.id,
      outcome: reconciled.status,
    });
    return "reconciliation_required";
  }
  if (prepared.status !== "quarantine_running") {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_QUARANTINE_DISABLED",
      "Restore quarantine preparation did not run",
    );
  }
  return "advanced";
}

async function runMaterialize(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  // The quarantine host must be running before any private worker executes.
  const started = await runCreate(context, operation);
  if (started !== "advanced") return started;
  const claim = await claimFor(context, operation);
  try {
    const {
      operation: claimed,
      sandbox,
      state,
    } = await deps.loadClaimed(claim, "container_created");
    const container = await deps.loadContainer(operation.id);
    const transport = deps.transport(container);
    const roots = agentBackupRestoreV3ContainerRoots(claimed.restore_attempt_id);
    let rootIdentities = state.roots;
    if (!rootIdentities) {
      const response = await transport.controller(
        {
          version: 1,
          method: "prepareRoots",
          agentId: claimed.agent_id,
          restoreAttemptId: claimed.restore_attempt_id,
          deadlineEpochMs: deps.now() + 5 * 60_000,
        },
        "quarantine",
      );
      if (response.method !== "prepareRoots") throw new Error("unreachable");
      rootIdentities = response.roots;
      await deps.recordEvidence({
        ...claim,
        phase: "container_created",
        patch: { roots: rootIdentities },
      });
    }
    if (!state.candidate) {
      if (!sandbox.activation_token_hash || !sandbox.activation_token_ciphertext) {
        throw coordinatorError(
          "AGENT_BACKUP_RESTORE_TOKEN_AUTHORITY_MISSING",
          "Restore sandbox lacks its activation token authority",
        );
      }
      const streamed = await deps.streamer.stream({
        source: sourceInput(claimed),
        quarantine: {
          authority: {
            operationId: claimed.id,
            ownerId: claim.ownerId,
            claimGeneration: claim.claimGeneration,
            targetNodeRecordId: container.node.nodeRecordId,
            targetNodeId: container.node.nodeId,
            targetNodeIncarnation: container.node.nodeIncarnation,
            targetNodeHistoryId: container.node.nodeHistoryId,
            replacementAttemptId: container.replacementAttemptId,
            activationTokenSha256: sandbox.activation_token_hash,
            activationTokenCiphertext: sandbox.activation_token_ciphertext,
          },
          roots: {
            trustedRoot: roots.trustedRoot,
            attemptRoot: roots.attemptRoot,
            trustedRootIdentity: rootIdentities.trustedRootIdentity,
            attemptRootIdentity: rootIdentities.attemptRootIdentity,
          },
        },
        signal: context.signal,
        deadlineEpochMs: deps.now() + EFFECT_CLAIM_MS - 60_000,
      });
      await deps.recordEvidence({
        ...claim,
        phase: "container_created",
        patch: {
          candidate: {
            session: { ...streamed.session },
            receipt: AgentBackupRestoreV3CandidateReceiptSchema.parse(streamed.receipt),
            receiptSha256: sha256Canonical(streamed.receipt),
          },
        },
      });
    }
    await deps.advanceServing({ ...claim, from: "container_created" });
    return "advanced";
  } catch (error) {
    // error-policy:J2 every pre-boot failure is recorded durably before return.
    return failPreBoot(context, claim, "container_created", error);
  }
}

async function runCommitGeneration(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  const claim = await claimFor(context, operation);
  try {
    const { operation: claimed, state } = await deps.loadClaimed(claim, "restoring");
    if (!state.roots || !state.candidate) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_EVIDENCE_MISSING",
        "Restoring phase lacks its roots or sealed candidate",
      );
    }
    if (!state.generation) {
      const container = await deps.loadContainer(operation.id);
      const response = await deps.transport(container).controller(
        {
          version: 1,
          method: "commitGeneration",
          agentId: claimed.agent_id,
          restoreAttemptId: claimed.restore_attempt_id,
          deadlineEpochMs: deps.now() + 30 * 60_000,
          roots: state.roots,
          session: state.candidate.session as never,
          receipt: state.candidate.receipt,
        },
        "quarantine",
      );
      if (response.method !== "commitGeneration") throw new Error("unreachable");
      await deps.recordEvidence({
        ...claim,
        phase: "restoring",
        patch: { generation: response.generation },
      });
    }
    await deps.advanceServing({ ...claim, from: "restoring" });
    return "advanced";
  } catch (error) {
    // error-policy:J2 every pre-boot failure is recorded durably before return.
    return failPreBoot(context, claim, "restoring", error);
  }
}

async function probeUntilAttested(
  context: TurnContext,
  params: {
    transport: AgentBackupRestoreContainerTransport;
    operation: Readonly<AgentBackupRestoreOperation>;
    token: string;
    tokenSha256: string;
    committedReceiptSha256: string;
    containerPort: number;
    deadlineEpochMs: number;
  },
): Promise<AgentBackupRestoreV3Attestation> {
  const { deps } = context;
  let lastError: unknown = null;
  while (deps.now() < params.deadlineEpochMs) {
    context.signal.throwIfAborted();
    const nonce = randomBytes(32).toString("hex");
    try {
      const attestation = await params.transport.probe({
        version: 1,
        restoreAttemptId: params.operation.restore_attempt_id,
        nonce,
      });
      verifyAgentBackupRestoreAttestationForOperation({ ...params, attestation, nonce });
      return attestation;
    } catch (error) {
      // error-policy:J3 the runtime may still be booting; retain the latest cause.
      lastError = error;
      if (errorCode(error) === "AGENT_BACKUP_RESTORE_ATTESTATION_INVALID") throw error;
    }
    await deps.sleep(BOOT_ATTESTATION_POLL_MS, context.signal);
  }
  throw coordinatorError(
    "AGENT_BACKUP_RESTORE_BOOT_ATTESTATION_TIMEOUT",
    "Restored runtime did not produce a signed boot attestation before its deadline",
    lastError,
  );
}

async function runBoot(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  const claim = await claimFor(context, operation);
  let previousRoute: AgentBackupRestorePreviousRoute | undefined;
  let container: AgentBackupRestoreContainerAuthority | undefined;
  let runtimeEffectsStarted = false;
  try {
    const { operation: claimed, sandbox, state } = await deps.loadClaimed(claim, "committed");
    if (!state.generation) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_EVIDENCE_MISSING",
        "Committed phase lacks its committed generation",
      );
    }
    container = await deps.loadContainer(operation.id);
    previousRoute = state.previousRoute;
    if (!previousRoute) {
      const runtime = await deps.previousRuntime.observe(sandbox);
      previousRoute = snapshotAgentBackupRestorePreviousRoute(sandbox, runtime);
      await deps.recordEvidence({ ...claim, phase: "committed", patch: { previousRoute } });
    }
    // From here the previous runtime may be stopped: failures roll back.
    runtimeEffectsStarted = true;
    if (previousRoute.runtime) await deps.previousRuntime.retainStopped(previousRoute.runtime);
    const transport = deps.transport(container);
    let serving = state.serving;
    if (!serving) {
      serving = await transport.attach();
      await deps.recordEvidence({ ...claim, phase: "committed", patch: { serving } });
    }
    if (!sandbox.activation_token_ciphertext || !sandbox.activation_token_hash) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_TOKEN_AUTHORITY_MISSING",
        "Restore sandbox lacks its activation token authority",
      );
    }
    const token = await deps.decryptToken(claimed, sandbox.activation_token_ciphertext);
    const tokenSha256 = agentBackupRestoreV3TokenSha256(token);
    if (tokenSha256 !== sandbox.activation_token_hash) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_TOKEN_AUTHORITY_MISMATCH",
        "Decrypted activation token differs from its durable hash",
      );
    }
    if (!state.bootGrantSha256) {
      const grant: AgentBackupRestoreV3BootGrant = {
        version: 1,
        format: "elizaos.agent-backup.restore-v3-boot-grant.v1",
        agentId: claimed.agent_id,
        organizationId: claimed.organization_id,
        restoreAttemptId: claimed.restore_attempt_id,
        containerId: container.containerId,
        nodeIncarnation: container.node.nodeIncarnation,
        generation: state.generation,
        token,
        tokenSha256,
      };
      const response = await transport.controller(
        {
          version: 1,
          method: "writeBootGrant",
          agentId: claimed.agent_id,
          restoreAttemptId: claimed.restore_attempt_id,
          deadlineEpochMs: deps.now() + 5 * 60_000,
          grant,
        },
        "serving",
      );
      if (response.method !== "writeBootGrant") throw new Error("unreachable");
      await deps.recordEvidence({
        ...claim,
        phase: "committed",
        patch: { bootGrantSha256: response.grantSha256 },
      });
    }
    await transport.launch();
    const attestation = await probeUntilAttested(context, {
      transport,
      operation: claimed,
      token,
      tokenSha256,
      committedReceiptSha256: state.generation.committedReceiptSha256,
      containerPort: serving.containerPort,
      deadlineEpochMs: deps.now() + BOOT_ATTESTATION_DEADLINE_MS,
    });
    await deps.recordRestartAttested({
      ...claim,
      attestation: {
        digest: sha256Canonical(attestation.body),
        mac: attestation.mac,
        body: attestation.body,
      },
    });
    return "advanced";
  } catch (error) {
    // error-policy:J2 the failure is recorded durably by retry or rollback.
    if (!runtimeEffectsStarted || !container) {
      return failPreBoot(context, claim, "committed", error);
    }
    return rollbackBeforeRoute(context, claim, "committed", container, previousRoute, error);
  }
}

async function runProbes(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  const claim = await claimFor(context, operation);
  let state: AgentBackupRestoreServingState = readAgentBackupRestoreServingState(operation);
  let container: AgentBackupRestoreContainerAuthority | undefined;
  try {
    const loaded = await deps.loadClaimed(claim, "restart_attested");
    state = loaded.state;
    container = await deps.loadContainer(operation.id);
    if (!state.generation || !state.serving || !state.attestation) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_EVIDENCE_MISSING",
        "Restart-attested phase lacks its boot evidence",
      );
    }
    if (!state.probe) {
      const token = await deps.decryptToken(
        loaded.operation,
        loaded.sandbox.activation_token_ciphertext ?? "",
      );
      const transport = deps.transport(container);
      const digests: string[] = [];
      for (let index = 0; index < PROBE_COUNT; index += 1) {
        if (index > 0) await deps.sleep(PROBE_SPACING_MS, context.signal);
        const nonce = randomBytes(32).toString("hex");
        const attestation = await transport.probe({
          version: 1,
          restoreAttemptId: loaded.operation.restore_attempt_id,
          nonce,
        });
        verifyAgentBackupRestoreAttestationForOperation({
          token,
          attestation,
          nonce,
          operation: loaded.operation,
          tokenSha256: loaded.sandbox.activation_token_hash ?? "",
          committedReceiptSha256: state.generation.committedReceiptSha256,
          containerPort: state.serving.containerPort,
        });
        digests.push(sha256Canonical(attestation));
      }
      await deps.recordEvidence({
        ...claim,
        phase: "restart_attested",
        patch: { probe: { digest: sha256Canonical(digests), count: PROBE_COUNT } },
      });
    }
    await deps.advanceServing({ ...claim, from: "restart_attested" });
    return "advanced";
  } catch (error) {
    // error-policy:J2 the failure is recorded durably by rollback.
    if (!container) return failPreBoot(context, claim, "restart_attested", error);
    return rollbackBeforeRoute(
      context,
      claim,
      "restart_attested",
      container,
      state.previousRoute,
      error,
    );
  }
}

async function runPublish(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  const claim = await claimFor(context, operation);
  let state: AgentBackupRestoreServingState = readAgentBackupRestoreServingState(operation);
  let container: AgentBackupRestoreContainerAuthority | undefined;
  try {
    const loaded = await deps.loadClaimed(claim, "probed");
    state = loaded.state;
    container = await deps.loadContainer(operation.id);
    if (!loaded.sandbox.activation_receipt_hash || !loaded.sandbox.activation_token_hash) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_ACTIVATION_INCOMPLETE",
        "Restore activation lacks its receipt or token authority",
      );
    }
    if (!state.publicationId) {
      // Pre-chosen so the route CAS and the later publication share one id.
      await deps.recordEvidence({
        ...claim,
        phase: "probed",
        patch: { publicationId: deps.randomUuid() },
      });
    }
    await deps.publishRoute({
      ...claim,
      replacementAttemptId: container.replacementAttemptId,
      nodeHostname: container.node.hostname,
    });
    return "advanced";
  } catch (error) {
    // error-policy:J2 a failure before the route CAS commits is rolled back.
    const current = await deps.loadOperation(operation.id);
    if (current?.route_published_at) {
      // The CAS committed but its response was lost; finalization proceeds.
      return "advanced";
    }
    if (!container) return failPreBoot(context, claim, "probed", error);
    return rollbackBeforeRoute(context, claim, "probed", container, state.previousRoute, error);
  }
}

async function runFinalize(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const { deps } = context;
  const claim = await claimFor(context, operation);
  try {
    const { operation: claimed, sandbox, state } = await deps.loadClaimed(claim, "published");
    const container = await deps.loadContainer(operation.id);
    if (
      !state.previousRoute ||
      !state.publicationId ||
      !state.attestation ||
      !state.probe ||
      !state.routePublication ||
      !state.candidate ||
      !state.generation
    ) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_EVIDENCE_MISSING",
        "Published phase lacks its route evidence",
      );
    }
    if (!sandbox.activation_receipt_hash || !sandbox.activation_token_hash) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_ACTIVATION_INCOMPLETE",
        "Restore activation lacks its receipt or token authority",
      );
    }
    // Append the immutable activation publication from the now-active
    // generation so it binds the final lifecycle revision. Exact replay
    // returns the original row.
    await deps.recordPublication({
      publicationId: state.publicationId,
      organizationId: claimed.organization_id,
      agentId: claimed.agent_id,
      activationGeneration: claimed.restore_attempt_id,
      expectedActivationReceiptSha256: sandbox.activation_receipt_hash,
      expectedContainerId: container.containerId,
      expectedNodeRecordId: container.node.nodeRecordId,
      expectedNodeIncarnation: container.node.nodeIncarnation,
      expectedNodeHistoryId: container.node.nodeHistoryId,
      expectedTokenSha256: sandbox.activation_token_hash,
    });
    if (!state.previousRuntimeRetired) {
      const previous = state.previousRoute;
      if (previous.runtime) await deps.previousRuntime.remove(previous.runtime);
      await deps.recordPreviousRuntimeRetired(claim);
    }
    if (!container.seedReceipt) {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_SEED_RECEIPT_MISSING",
        "Restore finalization lacks its attempt-scoped vault seed receipt",
      );
    }
    let finalReceiptId = state.finalReceiptId;
    if (!finalReceiptId) {
      finalReceiptId = deps.randomUuid();
      await deps.recordEvidence({ ...claim, phase: "published", patch: { finalReceiptId } });
    }
    const receiptDigest = sha256Canonical({
      format: "eliza.agent-backup-restore.final-receipt.v1",
      operationId: claimed.id,
      restoreAttemptId: claimed.restore_attempt_id,
      candidateReceiptSha256: state.candidate.receiptSha256,
      committedReceiptSha256: state.generation.committedReceiptSha256,
      attestationDigest: state.attestation.digest,
      probeDigest: state.probe.digest,
      lifecycleReceiptDigest: state.routePublication.lifecycleReceiptDigest,
    });
    await deps.commitRestore({
      receiptId: finalReceiptId,
      receiptDigest,
      organizationId: claimed.organization_id,
      agentId: claimed.agent_id,
      backupId: claimed.backup_id,
      restoreAttemptId: claimed.restore_attempt_id,
      replacementAttemptId: container.replacementAttemptId,
      seedReceiptId: container.seedReceipt.id,
      seedReceiptDigest: container.seedReceipt.digest,
      activationPublicationId: state.publicationId,
      targetActivationGeneration: claimed.restore_attempt_id,
      expectedActivationReceiptSha256: sandbox.activation_receipt_hash,
    });
    await deps.advance({
      operationId: claimed.id,
      ownerId: claim.ownerId,
      claimGeneration: claim.claimGeneration,
      fromPhase: "published",
      toPhase: "finalized",
      receiptDigest,
    });
    await deps.releaseLease(sourceInput(claimed));
    logger.info("[AgentBackupRestoreCoordinator] Restore finalized", {
      operationId: claimed.id,
      agentId: claimed.agent_id,
    });
    return "finalized";
  } catch (error) {
    // error-policy:J2 the route is published; finalization retries until it settles.
    return scheduleRetry(context, claim, "published", error);
  }
}

/**
 * The exact create and quarantine start own their claims internally, so a
 * failure there escapes without a durable retry record. Record it here with
 * backoff; the restore never touched the previous runtime or route, so it is
 * always safe to retry, and alerts accumulate through the recorded error.
 */
async function withCreateRetry(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
  run: () => Promise<AgentBackupRestoreCoordinatorTurnStatus>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  try {
    return await run();
  } catch (error) {
    // error-policy:J2 record the create failure durably when the operation
    // is still claimable; otherwise surface the original failure.
    // `vault_seeded` cannot be resumed through a generic advance (its receipt
    // writer owns that phase), so it stays due and is retried as-is.
    if (operation.phase === "vault_seeded") throw error;
    let claim: AgentBackupRestoreServingClaim & { attempts: number };
    try {
      const current = (await context.deps.loadOperation(operation.id)) ?? operation;
      if (current.phase !== operation.phase) throw error;
      claim = await claimFor(context, current);
    } catch {
      // error-policy:J3 an unclaimable operation keeps its durable state.
      throw error;
    }
    return scheduleRetry(context, claim, operation.phase, error);
  }
}

async function runResume(
  context: TurnContext,
  operation: Readonly<AgentBackupRestoreOperation>,
): Promise<AgentBackupRestoreCoordinatorTurnStatus> {
  const resumePhase = operation.resume_phase;
  if (!resumePhase) {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_RESUME_PHASE_MISSING",
      "A retryable restore has no phase to resume",
    );
  }
  const claim = await claimFor(context, operation);
  await context.deps.advance({
    operationId: operation.id,
    ownerId: claim.ownerId,
    claimGeneration: claim.claimGeneration,
    fromPhase: "failed_retryable",
    toPhase: resumePhase,
  });
  return "advanced";
}

/** Advance one restore operation by at most one phase. */
export async function runAgentBackupRestoreCoordinatorTurn(input: {
  operationId: string;
  config: Config;
  dependencies?: AgentBackupRestoreCoordinatorDependencies;
  signal?: AbortSignal;
}): Promise<AgentBackupRestoreCoordinatorTurnResult> {
  const deps = input.dependencies ?? createProductionCoordinatorDependencies();
  const signal = input.signal ?? new AbortController().signal;
  const context: TurnContext = { config: input.config, deps, signal };
  const operation = await deps.loadOperation(input.operationId);
  if (!operation) {
    throw coordinatorError(
      "AGENT_BACKUP_RESTORE_OPERATION_MISSING",
      "Restore operation is missing",
    );
  }
  const fromPhase = operation.phase;
  const result = (status: AgentBackupRestoreCoordinatorTurnStatus, code?: string) =>
    Object.freeze({
      operationId: operation.id,
      fromPhase,
      status,
      ...(code ? { errorCode: code } : {}),
    });
  if (fromPhase === "finalized") return result("finalized");
  if (fromPhase === "failed_terminal")
    return result("terminal", operation.last_error_code ?? undefined);
  if (operation.lease_owner_id !== input.config.workerId) return result("skipped");

  try {
    await deps.renewLease({
      ...sourceInput(operation),
      leaseMs: AGENT_BACKUP_RESTORE_COORDINATOR_LEASE_MS,
    });
  } catch (error) {
    // error-policy:J3 an unrenewable lease either lapsed (closed explicitly
    // below) or belongs to a concurrent owner (left untouched).
    const abandoned = await deps.abandonExpired(operation.id);
    if (abandoned) {
      logger.error("[AgentBackupRestoreCoordinator] Restore lease lapsed", {
        operationId: operation.id,
        phase: fromPhase,
      });
      return result("terminal", "AGENT_BACKUP_RESTORE_LEASE_EXPIRED");
    }
    throw error;
  }

  switch (fromPhase) {
    case "reserved":
    case "vault_seeded":
      return result(await withCreateRetry(context, operation, () => runCreate(context, operation)));
    case "container_created":
      return result(
        await withCreateRetry(context, operation, () => runMaterialize(context, operation)),
      );
    case "restoring":
      return result(await runCommitGeneration(context, operation));
    case "committed":
      return result(await runBoot(context, operation));
    case "restart_attested":
      return result(await runProbes(context, operation));
    case "probed":
      return result(await runPublish(context, operation));
    case "published":
      return result(await runFinalize(context, operation));
    case "failed_retryable":
      return result(await runResume(context, operation));
  }
}

export interface AgentBackupRestoreCoordinatorCycleSummary {
  readonly examined: number;
  readonly results: readonly AgentBackupRestoreCoordinatorTurnResult[];
  readonly failures: number;
  /** Failed restore containers removed and their fences settled this cycle. */
  readonly terminalCleanups: number;
}

/** One bounded, serial coordinator cycle over due operations owned by this worker. */
export async function runAgentBackupRestoreCoordinatorCycle(input: {
  config: Config;
  dependencies?: AgentBackupRestoreCoordinatorDependencies;
  signal?: AbortSignal;
  limit?: number;
  listDue?: typeof listDueAgentBackupRestoreOperations;
}): Promise<AgentBackupRestoreCoordinatorCycleSummary> {
  const listDue = input.listDue ?? listDueAgentBackupRestoreOperations;
  const due = await listDue({ ownerId: input.config.workerId, limit: input.limit ?? 10 });
  const results: AgentBackupRestoreCoordinatorTurnResult[] = [];
  let failures = 0;
  for (const operation of due) {
    input.signal?.throwIfAborted();
    try {
      results.push(
        await runAgentBackupRestoreCoordinatorTurn({
          operationId: operation.id,
          config: input.config,
          dependencies: input.dependencies,
          signal: input.signal,
        }),
      );
    } catch (error) {
      // error-policy:J1 one operation's failure must not starve the others;
      // it stays durable (claim/lease/phase) and is surfaced in the summary.
      failures += 1;
      logger.error("[AgentBackupRestoreCoordinator] Restore turn failed", {
        operationId: operation.id,
        phase: operation.phase,
        errorCode: errorCode(error),
        error: errorMessage(error),
      });
    }
  }
  // Sweep terminally failed restores whose container still holds the agent's
  // replacement fence (an earlier cleanup was interrupted or deferred).
  const deps = input.dependencies ?? createProductionCoordinatorDependencies();
  let cleaned = 0;
  for (const operationId of await deps.listTerminalCleanups({
    ownerId: input.config.workerId,
    limit: input.limit ?? 10,
  })) {
    input.signal?.throwIfAborted();
    try {
      if ((await cleanupTerminalAgentBackupRestore(deps, operationId)) === "cleaned") cleaned += 1;
    } catch (error) {
      // error-policy:J1 cleanup stays fenced and is retried next cycle.
      failures += 1;
      logger.error("[AgentBackupRestoreCoordinator] Terminal restore cleanup failed", {
        operationId,
        errorCode: errorCode(error),
        error: errorMessage(error),
      });
    }
  }
  return Object.freeze({
    examined: due.length,
    results: Object.freeze(results),
    failures,
    terminalCleanups: cleaned,
  });
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

function tokenCoords(operation: Readonly<AgentBackupRestoreOperation>) {
  return {
    table: "agent_sandboxes",
    rowId: `${operation.agent_id}:${operation.restore_attempt_id}`,
    column: "activation_token_ciphertext",
  };
}

/**
 * Real repositories, Docker provider and field encryption. The streamer is
 * supplied by the worker composition because it owns the KMS key bundle and
 * the object-storage registry.
 */
export function createProductionCoordinatorDependencies(
  streamer?: AgentBackupRestoreCoordinatorStreamer,
): AgentBackupRestoreCoordinatorDependencies {
  const missingStreamer: AgentBackupRestoreCoordinatorStreamer = {
    async stream() {
      throw coordinatorError(
        "AGENT_BACKUP_RESTORE_STREAMER_UNCONFIGURED",
        "Restore coordinator has no catalogue streamer; run it from the backup catalogue worker",
      );
    },
  };
  return {
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    randomUuid: () => randomUUID(),
    randomToken: () => randomBytes(32).toString("base64url"),
    async loadOperation(operationId) {
      const { dbWrite } = await import("../../db/helpers");
      const { agentBackupRestoreOperations } = await import(
        "../../db/schemas/agent-backup-catalog"
      );
      const { eq } = await import("drizzle-orm");
      const [row] = await dbWrite
        .select()
        .from(agentBackupRestoreOperations)
        .where(eq(agentBackupRestoreOperations.id, operationId))
        .limit(1);
      return row ? Object.freeze(row) : null;
    },
    abandonExpired: abandonAgentBackupRestoreWithExpiredLease,
    renewLease: renewAgentBackupRestoreLease,
    releaseLease: releaseAgentBackupRestoreLease,
    claim: claimAgentBackupRestoreOperation,
    advance: advanceAgentBackupRestoreOperation,
    fail: failAgentBackupRestoreOperation,
    selectTarget: selectAgentBackupRestoreTargetNode,
    resolveReservedNodeId: resolveAgentBackupRestoreReservedNodeId,
    async encryptToken(operation, token) {
      const { fieldEncryption } = await import("./field-encryption");
      return fieldEncryption.encrypt(operation.organization_id, token, tokenCoords(operation));
    },
    async decryptToken(operation, ciphertext) {
      const { fieldEncryption } = await import("./field-encryption");
      return fieldEncryption.decrypt(ciphertext, tokenCoords(operation));
    },
    prepareQuarantine: prepareAgentBackupRestoreQuarantine,
    reconcileCreate: reconcileAgentBackupRestoreQuarantinedCreate,
    loadContainer: loadAgentBackupRestoreContainerAuthority,
    loadClaimed: loadClaimedAgentBackupRestoreServingAuthority,
    recordEvidence: recordAgentBackupRestoreServingEvidence,
    advanceServing: advanceAgentBackupRestoreServingPhase,
    recordRestartAttested: recordAgentBackupRestoreRestartAttested,
    recordPublication: recordAgentActivationPublication,
    publishRoute: publishAgentBackupRestoreRoute,
    recordPreviousRuntimeRetired: recordAgentBackupRestorePreviousRuntimeRetired,
    commitRestore: commitAgentBackupRestore,
    failBeforeRoute: failAgentBackupRestoreBeforeRoute,
    beginTerminalCleanup: beginAgentBackupRestoreTerminalCleanup,
    finishTerminalCleanup: finishAgentBackupRestoreTerminalCleanup,
    listTerminalCleanups: listAgentBackupRestoreTerminalCleanups,
    async removeRestoreContainer(cleanup) {
      const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
      const { locator } = cleanup;
      await new DockerSandboxProvider().stopOnSpecificNodeForReplacement(
        locator.nodeId,
        locator.containerName,
        null,
        {
          nodeRecordId: locator.nodeRecordId,
          nodeIncarnation: locator.nodeIncarnation,
          nodeHistoryId: locator.nodeHistoryId,
          nodeHostname: locator.nodeHostname,
          nodeSshPort: locator.nodeSshPort,
          nodeSshUser: locator.nodeSshUser,
          nodeHostKeyFingerprint: locator.nodeHostKeyFingerprint,
          replacementSecretCleanupVersion: locator.replacementSecretCleanupVersion,
          replacementAttemptId: locator.replacementAttemptId,
          restoreAttemptId: cleanup.restoreAttemptId,
          containerId: locator.containerId,
          vpnNodeName: null,
          previousVpnNodeId: null,
          vpnRegistrationStartedAt: null,
          allocationCounted: locator.allocationCounted,
        },
      );
    },
    transport: createDockerAgentBackupRestoreContainerTransport,
    previousRuntime: createDockerPreviousRuntimeProvider(),
    streamer: streamer ?? missingStreamer,
  };
}

function createDockerPreviousRuntimeProvider(): AgentBackupRestorePreviousRuntimeProvider {
  const docker = () => import("./docker-runtime-observation");
  return {
    async observe(sandbox) {
      if (
        sandbox.status !== "running" ||
        !sandbox.node_id ||
        !sandbox.container_name ||
        !sandbox.sandbox_id
      ) {
        return null;
      }
      const observed = await (await docker()).observeDockerRuntime({
        organizationId: sandbox.organization_id,
        agentId: sandbox.id,
        nodeId: sandbox.node_id,
        containerName: sandbox.container_name,
      });
      if (observed.kind === "unavailable") {
        throw coordinatorError(
          "AGENT_BACKUP_RESTORE_PREVIOUS_RUNTIME_UNOBSERVABLE",
          `Previous runtime could not be observed: ${observed.reason}`,
        );
      }
      return observed.kind === "present" ? observed.identity : null;
    },
    async retainStopped(identity) {
      await (await docker()).retainDockerRuntimeStopped(identity);
    },
    async startRetained(identity) {
      await (await docker()).startRetainedDockerRuntime(identity);
    },
    async remove(identity) {
      await (await docker()).stopDockerRuntime(identity);
    },
  };
}

/**
 * Agent Sandbox Service — orchestrates cloud agent lifecycle:
 * Agent database assignment (shared Railway Postgres), Docker sandbox creation, bridge proxy, backups, heartbeat.
 */

import crypto from "node:crypto";
import { isIP } from "node:net";
import { ElizaError, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { ChannelType } from "@elizaos/core/edge";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  resolveRetainableAgentBackupBytes,
  SnapshotPayloadTooLargeError,
} from "@elizaos/shared/agent-backup-limits";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { ensureAgentSandboxSchema } from "../../db/ensure-agent-sandbox-schema";
import { type Database, dbWrite } from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import {
  type AgentBackupSnapshotType,
  type AgentSandbox,
  type AgentSandboxBackup,
  type AgentSandboxBackupMetadata,
  type AgentSandboxStatus,
  agentSandboxesRepository,
  hydrateAgentSandboxBackup,
  PRE_DELETE_BACKUP_RETENTION_MS,
  type ProvisioningAdmissionCapture,
  prepareAgentBackupInsertData,
  reconstructStoredAgentSandboxBackupChain,
} from "../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../db/repositories/characters";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentBackupStateData,
  type AgentExecutionTier,
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  type NewAgentSandbox,
  type NewAgentSandboxBackup,
  type StoredAgentSandboxBackup,
  WARM_POOL_ORG_ID,
} from "../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { jobs } from "../../db/schemas/jobs";
import { personalDedicatedAdoptionSelections } from "../../db/schemas/personal-dedicated-adoption-selections";
import { personalDedicatedUpgradeAuthorities } from "../../db/schemas/personal-dedicated-upgrade-authorities";
import { imageRepo, repinImageDigest } from "../../db/utils/docker-image-ref";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { ApiError } from "../api/cloud-worker-errors";
import { InsufficientCreditsError as InsufficientCreditsApiError } from "../api/errors";
import { containersEnv } from "../config/containers-env";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { getElizaAgentPublicWebUiUrl } from "../eliza-agent-web-ui";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import { logger } from "../utils/logger";
import { settleOffResponsePath } from "../utils/settle-off-response-path";
import { withTimeout } from "../utils/with-timeout";
import {
  assertAdminCanaryCanonicalOrDemoPair,
  assertDemoSourceImage,
  assertSha256Digest,
  parseAdminCanaryDemoImage,
} from "./admin-canary-image";
import {
  computeStateHash,
  estimateDeltaBytes,
  incrementalChainDepth,
  planIncrementalBackup,
  resolveBackupChainBytes,
} from "./agent-backup-diff";
import { decryptAgentEnvVars, encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
  reserveCredits,
} from "./ai-billing";
import { aiBillingRecordsService } from "./ai-billing-records";
import { apiKeysService } from "./api-keys";
import { chatSseFrame, normalizeChatSseDonePayload } from "./chat-sse-frames";
import { imageRequiresDigestPin, isCodingContainerImageAllowed } from "./coding-containers";
import type { CreditReconciliationResult, CreditReservation } from "./credits";
import { withDefaultAgentCharacter } from "./default-agent-character";
import { holdsCountedNodeSlot, isDeletionContinuation } from "./docker-node-workload-queries";
import type { DockerSandboxMetadata } from "./docker-sandbox-provider";
import { shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import {
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
  readPersonalElizaCutover,
  reusesExistingElizaCharacter,
  stripPersonalDedicatedAuthorityConfigKeys,
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "./eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
  elizaCodingContainerImageAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import {
  applyManagedAgentInferenceEnvDefaults,
  type ManagedElizaEnvironmentResult,
  prepareManagedElizaSharedEnvironment,
} from "./managed-eliza-config";
import { prepareManagedElizaEnvironment } from "./managed-eliza-env";
import {
  type PersonalDedicatedReviewedBackupChainEntry,
  personalDedicatedActivationAuthority,
  personalDedicatedActivationAuthorityFromReceipt,
  personalDedicatedActivationAuthorityKey,
  personalDedicatedBackupProvenanceFromStored,
} from "./personal-dedicated-adoption-provenance";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES, JOB_TYPES } from "./provisioning-job-types";
import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";
import { mergeRuntimeAgentSecretsFromEnv } from "./runtime-agent-secrets";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";
import {
  createSandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "./sandbox-provider";
import {
  isContainerBackedExecutionTier,
  type SandboxDeletionStopOutcome,
  SandboxReplacementCleanupUnresolvedError,
} from "./sandbox-provider-types";
import { purgeSharedConversationRooms } from "./shared-runtime/conversation-coordinator";
import {
  type RunSharedAgentTurnResult,
  resolveSharedAgentTurnModel,
  runSharedAgentTurn,
  runSharedAgentTurnStream,
  type SharedAgentCharacter,
  type SharedAgentTurnUsage,
  type SharedTurnMessage,
} from "./shared-runtime/run-shared-agent-turn";
import { applyPooledCredentialsToBootstrapEnv } from "./team-credential-pool/bootstrap-env";
import {
  formatWakeRestoreIntegrityError,
  runWakeRestoreIntegrityGate,
  type WakeRestoreIntegrityFailure,
} from "./wake-restore-integrity";
import {
  buildWarmClaimCharacterPayload,
  WARM_CLAIM_CHARACTER_PUSH_TIMEOUT_MS,
} from "./warm-claim-character-push";
import {
  buildWarmClaimKeyPushBody,
  hasReadyWarmClaimCredential,
  safeKeyPrefix,
  WARM_CLAIM_KEY_PUSH_TIMEOUT_MS,
  WARM_CLAIM_RECOVERY_FAILURE_PREFIX,
  warmClaimKeyFingerprint,
} from "./warm-claim-key-push";

export interface CreateAgentParams {
  organizationId: string;
  userId: string;
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  characterId?: string;
  dockerImage?: string;
  /**
   * Explicit placement authority for the new row. Callers must decide whether
   * the agent is container-free Shared or owns dedicated/custom compute; the
   * persistence seam must never make that product decision by default.
   */
  executionTier: AgentExecutionTier;
  /**
   * Opt-in idempotency for single-agent-per-org flows (e.g. the onboarding
   * `POST /api/v1/eliza/agents` path and the eliza-app provisioner). When set,
   * createAgent takes an org-scoped advisory lock and reuses the org's existing
   * non-terminal agent instead of minting a duplicate — so a retry, an SDK
   * double-call, or a provision flap can't strand the org with N agents (each =
   * a container + per-tenant DB + ingress).
   *
   * Left unset by multi-agent-per-org service paths (waifu token launches, the
   * compat create endpoint) that legitimately create several distinct agents
   * for one org and must NOT collapse them.
   */
  reuseExistingNonTerminal?: boolean;
  /**
   * Ceiling on an org's resource-holding ({@link QUOTA_COUNTED_STATUSES},
   * non-pool) agent sandboxes, enforced ATOMICALLY under the org advisory lock
   * before ANY fresh insert — both the plain-insert branch and the reuse
   * branch's no-live-agent-to-reuse insert. Prevents a user-facing caller from
   * minting unbounded dedicated containers on the shared fleet (#11023: a
   * `forceCreate`+`alwaysOn` loop on a ~$0.11 balance otherwise exhausts the
   * fleet — the credit gate is threshold-only, never a per-agent debit). The
   * user-facing `POST /api/v1/eliza/agents` route sets this from the org's
   * balance tier; trusted internal multi-agent callers leave it unset (uncapped).
   * A create that would exceed the cap throws {@link AgentQuotaExceededError}.
   */
  maxNonTerminalAgents?: number;
}

/**
 * Statuses that COUNT toward `maxNonTerminalAgents`: the live states plus
 * `stopped` (suspend) and `sleeping` (cold storage). Both drop the container
 * and free the node slot, but each RETAINS the org's per-tenant managed
 * Postgres — the durable, costly resource — so a create→suspend→create loop
 * must not mint fresh agents (and fresh managed DBs) past the ceiling
 * (#11023 residual). Terminal/deletion states (`error`, `disconnected`,
 * `deletion_pending`, `deletion_failed`) hold no reusable resources and stay
 * excluded. `deletion_failed` in particular must not count (#15603): the
 * delete exhausted its retries — usually a node fault, not the user's — and
 * counting it would lock the org out of a replacement until ops intervene. A
 * container that survived the failed teardown is reclaimed independently of
 * this count (`reEnqueueFailedDeletions` re-arms the delete; the orphan
 * reconciler treats `deletion_failed` as reapable), and a user cannot drive a
 * row into that state on demand, so the freed slot stays bounded. Intentionally
 * BROADER than the reuse-guard SELECTs, which must keep returning only a LIVE
 * agent — handing back a stopped/sleeping row would silently turn an
 * idempotent create into an implicit resume.
 */
export const QUOTA_COUNTED_STATUSES: AgentSandboxStatus[] = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
];

/** Thrown by createAgent when a fresh create would exceed `maxNonTerminalAgents`. */
export class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super(
      `Agent quota exceeded: your organization already has ${count} active agents (limit ${max}). Delete or stop an agent, or add credits to raise the limit.`,
    );
    this.name = "AgentQuotaExceededError";
    this.count = count;
    this.max = max;
  }
}

function assertAgentExecutionTier(
  executionTier: unknown,
): asserts executionTier is AgentExecutionTier {
  if (
    executionTier !== "shared" &&
    executionTier !== "dedicated-lazy" &&
    executionTier !== "dedicated-always" &&
    executionTier !== "custom"
  ) {
    throw new ElizaError(
      "createAgent requires an explicit valid executionTier; refusing to default placement",
      {
        code: "INVALID_AGENT_EXECUTION_TIER",
        context: {
          executionTier: typeof executionTier === "string" ? executionTier : null,
          receivedType: typeof executionTier,
        },
      },
    );
  }
}

/**
 * Canonical value builder for a fresh `agent_sandboxes` insert. Every create
 * path — the sandbox service's own create/coding-container methods and the
 * tier-upgrade target mint (#15943) — MUST assemble its insert through this
 * function so config sanitization, character ownership, tier→status derivation,
 * and column defaults cannot drift between paths. `environmentVars` is expected
 * storage-ready (already passed through `encryptAgentEnvVarsForStorage`).
 *
 * A create that brings neither a linked `characterId` nor a persona in its
 * config is seeded with the shipped default character
 * ({@link withDefaultAgentCharacter}); seeding here rather than in any single
 * reader is what keeps the shared turn, the dedicated container, the warm-pool
 * claim push, and the first-boot bootstrap agreeing on one persona.
 */
export function buildAgentSandboxInsertValues(params: CreateAgentParams): NewAgentSandbox {
  const executionTier = params.executionTier;
  assertAgentExecutionTier(executionTier);
  const sanitizedConfig = stripReservedElizaConfigKeys(params.agentConfig);
  const agentConfig = params.characterId
    ? withReusedElizaCharacterOwnership(sanitizedConfig)
    : executionTier === "custom"
      ? sanitizedConfig
      : withDefaultAgentCharacter(sanitizedConfig);

  const status = executionTier === "shared" ? "running" : "pending";

  return {
    organization_id: params.organizationId,
    user_id: params.userId,
    agent_name: params.agentName,
    agent_config: agentConfig,
    environment_vars: params.environmentVars ?? {},
    status,
    execution_tier: executionTier,
    database_status: "none",
    ...(params.characterId && { character_id: params.characterId }),
    ...(params.dockerImage && { docker_image: params.dockerImage }),
  };
}

/** Omits an empty custom-image overlay so a self-contained image keeps its bundled character. */
export function agentConfigForProvision(
  agent: Pick<AgentSandbox, "agent_config" | "execution_tier">,
): Record<string, unknown> | undefined {
  const config = agent.agent_config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const record = config as Record<string, unknown>;
  return agent.execution_tier === "custom" && Object.keys(record).length === 0 ? undefined : record;
}

/**
 * Enforce `maxNonTerminalAgents` for an org: count its quota-holding
 * ({@link QUOTA_COUNTED_STATUSES}), non-pool sandboxes and throw
 * {@link AgentQuotaExceededError} at/past the cap. MUST run inside a
 * transaction that already holds an org-serializing advisory lock (the
 * agent-create lock, or the tier-upgrade lock for a fixed source agent) so
 * the count→insert is atomic — two concurrent creates can't both read
 * `count = max-1` and both insert.
 */
export async function assertOrgAgentQuota(
  tx: DbTransaction,
  organizationId: string,
  cap: number,
): Promise<void> {
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, organizationId),
        sql`${agentSandboxes.pool_status} IS NULL`,
        inArray(agentSandboxes.status, QUOTA_COUNTED_STATUSES),
      ),
    );
  if (count >= cap) {
    throw new AgentQuotaExceededError(count, cap);
  }
}

/**
 * Thrown by createAgent when a caller-supplied `dockerImage` is not permitted by
 * the managed-agent image allowlist, or (when the digest-pin gate is armed) is
 * not pinned to a full sha256 digest (H1, #12230). Throwing here — before ANY
 * DB write or `docker pull` — is what makes the gate fail-closed across every
 * route that reaches createAgent, not just `POST /api/v1/eliza/agents`.
 */
export class AgentImageNotAllowedError extends Error {
  readonly image: string;
  readonly reason: "not_allowlisted" | "not_digest_pinned";
  constructor(image: string, reason: "not_allowlisted" | "not_digest_pinned") {
    super(
      reason === "not_digest_pinned"
        ? `Docker image '${image}' must be pinned to a full sha256 digest (e.g. ghcr.io/org/repo@sha256:<64 hex>).`
        : `Docker image '${image}' is not in the managed-agent image allowlist.`,
    );
    this.name = "AgentImageNotAllowedError";
    this.image = image;
    this.reason = reason;
  }
}

/**
 * Fail-closed gate for a caller-supplied managed-agent `dockerImage` (H1,
 * #12230). No image → the default first-party runtime image is used downstream,
 * nothing to gate. A supplied image must be on {@link
 * containersEnv.agentImageAllowlist} and, when the digest-pin gate is armed,
 * content-addressed. Throws {@link AgentImageNotAllowedError} otherwise.
 */
export function assertAgentImageAllowed(dockerImage: string | undefined): void {
  if (!dockerImage) return;
  const allowlist = containersEnv.agentImageAllowlist();
  if (!isCodingContainerImageAllowed(dockerImage, allowlist)) {
    logger.warn("[agent-sandbox] docker image rejected by allowlist", {
      image: dockerImage,
    });
    throw new AgentImageNotAllowedError(dockerImage, "not_allowlisted");
  }
  if (imageRequiresDigestPin(dockerImage, containersEnv.requireDigestPinnedImages())) {
    logger.warn("[agent-sandbox] docker image rejected: digest pin required", {
      image: dockerImage,
    });
    throw new AgentImageNotAllowedError(dockerImage, "not_digest_pinned");
  }
}

function resolveManagedProvisionDockerImage(
  storedImage: string | null | undefined,
): string | undefined {
  const configuredImage = containersEnv.defaultAgentImageOverride();
  if (!configuredImage) return storedImage ?? undefined;
  // Same-repo managed pins are fleet image selections, not custom images; on
  // reprovision they must follow the operator's current image so recovery does
  // not replay an old broken sha tag forever.
  if (!storedImage) return configuredImage;
  return imageRepo(storedImage) === imageRepo(configuredImage) ? configuredImage : storedImage;
}

/**
 * Thrown when post-create readiness cannot establish the required managed
 * reachability: either every SSH probe failed, or SSH proved the workload
 * healthy while its tailnet ingress remained unavailable. The provision path
 * keeps the container in place and returns a RETRYABLE failure instead of
 * tearing down a healthy or unproven workload (#15310 failure mode #6).
 */
export class SandboxReachabilityUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxReachabilityUnresolvedError";
  }
}

export type ProvisionResult =
  | {
      success: true;
      sandboxRecord: AgentSandbox;
      bridgeUrl: string;
      healthUrl: string;
    }
  | {
      success: false;
      sandboxRecord?: AgentSandbox;
      error: string;
      /**
       * True when the failure is a transient, retryable condition (e.g. the
       * readiness probe could not reach the container). The provision JOB
       * should retry rather than treat this as a permanent failure that flips
       * the sandbox row to `error`. Absent/false = terminal.
       */
      retryable?: boolean;
    };

function rejectNonContainerBackedProvision(
  rec: AgentSandbox,
): Extract<ProvisionResult, { success: false }> | undefined {
  if (isContainerBackedExecutionTier(rec.execution_tier)) {
    return undefined;
  }
  return {
    success: false,
    sandboxRecord: rec,
    error: "Sandbox provisioning requires an explicit container-backed execution tier",
  };
}

type ContainerBackedServiceAction =
  | "shutdown"
  | "suspend"
  | "sleep"
  | "wake"
  | "resume"
  | "restart"
  | "upgrade"
  | "downgrade"
  | "logs"
  | "replacement"
  | "credential"
  | "character push";

/** Canonical fail-closed error for direct container-service re-entry. */
function containerBackedServiceRejection(
  rec: Pick<AgentSandbox, "execution_tier">,
  action: ContainerBackedServiceAction,
): string | undefined {
  return isContainerBackedExecutionTier(rec.execution_tier)
    ? undefined
    : `Agent ${action} requires a container-backed execution tier`;
}

/**
 * Restore-source override for `provision()`. `from-backup` restores a specific
 * backup instead of the latest and disables unrecoverable-snapshot degradation;
 * manual restore additionally sets `requireRestoreEndpoint` so the custom-image
 * 404 compatibility skip cannot fabricate success. `fresh-boot` skips restore
 * entirely. Callers that omit an override keep latest-backup auto-restore.
 */
export type ProvisionRestoreOverride =
  | {
      kind: "from-backup";
      backupId: string;
      requireRestoreEndpoint?: false;
      expectedAdmission?: never;
    }
  | {
      kind: "from-backup";
      backupId: string;
      requireRestoreEndpoint: true;
      expectedAdmission: ProvisioningAdmissionCapture;
    }
  | {
      kind: "from-reviewed-backup";
      selectionId: string;
      backupId: string;
      expectedContentHash: string;
      expectedBackupChain: PersonalDedicatedReviewedBackupChainEntry[];
    }
  | { kind: "reviewed-fresh-boot"; selectionId: string }
  | { kind: "fresh-boot" };

type ReviewedProvisionRestoreOverride = Extract<
  ProvisionRestoreOverride,
  { kind: "from-reviewed-backup" }
>;

type ReviewedProvisionAuthorityOverride = Extract<
  ProvisionRestoreOverride,
  { kind: "from-reviewed-backup" | "reviewed-fresh-boot" }
>;

interface ElizaSandboxServiceTestHooks {
  afterReviewedRestorePreflight?: () => Promise<void>;
  afterReviewedRestoreFence?: () => Promise<void>;
}

function isExplicitBackupRestore(
  override: ProvisionRestoreOverride | undefined,
): override is Extract<ProvisionRestoreOverride, { kind: "from-backup" | "from-reviewed-backup" }> {
  return override?.kind === "from-backup" || override?.kind === "from-reviewed-backup";
}

export type DeleteAgentResult =
  | { success: true; rowDeleted: true; deletedSandbox: AgentSandbox }
  | {
      success: true;
      rowDeleted: false;
      reconciliationPending: true;
      deletedSandbox: AgentSandbox;
    }
  | { success: false; error: string; retryable?: true };

export type DeleteAuthorization = "user_request" | "billing_request" | "account_deletion";

export interface AgentSuspendExecutionResult {
  success: boolean;
  containerStopped: boolean;
  backupId?: string;
  error?: string;
  skipped?: true;
  reason?: "lifecycle_changed" | "stop_intent_superseded" | "billing_recovered";
}

/**
 * Outcome of the bounded container teardown attempted during `deleteAgent`:
 * `null` = stop succeeded; `{ error }` = stop failed within the cap (classified
 * downstream as ignorable vs real); `{ error, timedOut }` = the teardown hit the
 * hard cap and was abandoned (see `runBoundedSandboxStop`).
 */
export type BoundedSandboxStopResult =
  | null
  | { error: unknown }
  | { error: unknown; timedOut: true };

type BoundedDeletionSandboxStopResult =
  | SandboxDeletionStopOutcome
  | { kind: "stop-failed"; error: unknown }
  | { kind: "stop-timed-out"; error: unknown };

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Structural subset of the Cloudflare Workers `ExecutionContext` the shared-tier
 * bridge needs to defer its post-reply billing tail off the response path.
 * Routes pass `c.executionCtx`; non-Worker callers (tests, Node) omit it and
 * the tail runs inline, preserving fully-synchronous settlement.
 */
export type BridgeExecutionContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * JSON-RPC error code for a shared-runtime turn rejected by the credit
 * reserve. REST callers (shared-rest-adapter, the messages/stream route)
 * match on this code to translate the failure into the canonical 402
 * insufficient-credits response instead of a generic retryable failure —
 * an empty balance is permanent until the org tops up, not a transient
 * outage.
 */
export const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

export interface BridgeResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

type AgentRuntimeStartupPayload = {
  phase?: unknown;
  attempt?: unknown;
  lastError?: unknown;
};

type AgentRuntimeStatusPayload = {
  state?: unknown;
  canRespond?: unknown;
  startup?: AgentRuntimeStartupPayload | null;
};

type AgentRuntimeHealthPayload = {
  ready?: unknown;
  canRespond?: unknown;
  runtime?: unknown;
  database?: unknown;
  databaseLiveness?: {
    status?: unknown;
    ok?: unknown;
    terminal?: unknown;
    message?: unknown;
  } | null;
  plugins?: { loaded?: unknown; failed?: unknown } | null;
  agentState?: unknown;
  startup?: AgentRuntimeStartupPayload | null;
};

type BridgeHealthProbeResult =
  | { ok: true; kind: "healthy" }
  | { ok: false; kind: "transient"; reason: string }
  | { ok: false; kind: "terminal-db"; reason: string }
  | { ok: false; kind: "unreachable"; reason: string };

export interface SnapshotResult {
  success: boolean;
  backup?: AgentSandboxBackup;
  error?: string;
  retryable?: boolean;
}

type SnapshotAuthorityCapture = Pick<
  AgentSandbox,
  | "id"
  | "organization_id"
  | "status"
  | "execution_tier"
  | "pool_status"
  | "deleted_at"
  | "deletion_attempt_id"
  | "sandbox_id"
  | "node_id"
  | "container_name"
  | "bridge_url"
  | "health_url"
  | "bridge_port"
  | "web_ui_port"
  | "headscale_ip"
  | "environment_revision"
  | "lifecycle_revision"
>;

const SNAPSHOT_AUTHORITY_CHANGED = "Sandbox changed while snapshot was being captured";

function snapshotAuthorityRejection(rec: SnapshotAuthorityCapture): string | undefined {
  if (!isContainerBackedExecutionTier(rec.execution_tier)) {
    return "Agent snapshot requires a container-backed execution tier";
  }
  if (rec.pool_status !== null) {
    return "Agent snapshot cannot target pool-owned capacity";
  }
  if (rec.deleted_at !== null) {
    return "Agent snapshot cannot target a deleted agent";
  }
  if (rec.deletion_attempt_id !== null) {
    return "Agent snapshot cannot start while agent deletion is in progress";
  }
  return undefined;
}

function snapshotCaptureStillCanonical(
  current: SnapshotAuthorityCapture,
  captured: SnapshotAuthorityCapture,
): boolean {
  return (
    current.id === captured.id &&
    current.organization_id === captured.organization_id &&
    current.status === captured.status &&
    current.execution_tier === captured.execution_tier &&
    current.pool_status === captured.pool_status &&
    (current.deleted_at?.getTime() ?? null) === (captured.deleted_at?.getTime() ?? null) &&
    current.deletion_attempt_id === captured.deletion_attempt_id &&
    current.sandbox_id === captured.sandbox_id &&
    current.node_id === captured.node_id &&
    current.container_name === captured.container_name &&
    current.bridge_url === captured.bridge_url &&
    current.health_url === captured.health_url &&
    current.bridge_port === captured.bridge_port &&
    current.web_ui_port === captured.web_ui_port &&
    current.headscale_ip === captured.headscale_ip &&
    current.environment_revision === captured.environment_revision &&
    current.lifecycle_revision === captured.lifecycle_revision
  );
}

type RestoreAuthorityCapture = SnapshotAuthorityCapture;

const RESTORE_AUTHORITY_CHANGED = "Sandbox changed while restore was being prepared";
const RESTORE_BACKUP_CHANGED = "Backup changed while restore was being prepared";

function restoreAuthorityRejection(rec: RestoreAuthorityCapture): string | undefined {
  if (!isContainerBackedExecutionTier(rec.execution_tier)) {
    return "Agent restore requires a container-backed execution tier";
  }
  if (rec.pool_status !== null) {
    return "Agent restore cannot target pool-owned capacity";
  }
  if (rec.deleted_at !== null) {
    return "Agent restore cannot target a deleted agent";
  }
  if (rec.deletion_attempt_id !== null) {
    return "Agent restore cannot start while agent deletion is in progress";
  }
  return undefined;
}

function restoreCaptureStillCanonical(
  current: RestoreAuthorityCapture,
  captured: RestoreAuthorityCapture,
): boolean {
  return snapshotCaptureStillCanonical(current, captured);
}

/**
 * Bind a reconstructed payload to the exact legacy-visible backup row that
 * selected it. Verification/catalogue bookkeeping may change independently,
 * but the payload locator, chain identity, and restore semantics may not.
 */
function storedRestorePointStillCanonical(
  current: StoredAgentSandboxBackup,
  captured: StoredAgentSandboxBackup,
): boolean {
  return (
    current.id === captured.id &&
    current.sandbox_record_id === captured.sandbox_record_id &&
    current.snapshot_type === captured.snapshot_type &&
    current.state_data_storage === captured.state_data_storage &&
    current.state_data_key === captured.state_data_key &&
    current.size_bytes === captured.size_bytes &&
    current.backup_kind === captured.backup_kind &&
    current.parent_backup_id === captured.parent_backup_id &&
    current.base_backup_id === captured.base_backup_id &&
    current.content_hash === captured.content_hash &&
    current.catalog_state === captured.catalog_state &&
    current.created_at.getTime() === captured.created_at.getTime() &&
    JSON.stringify(current.state_data) === JSON.stringify(captured.state_data)
  );
}

const MAX_RESTORE_AUTHORITY_CHAIN_DEPTH = 100;

/** Capture every legacy-visible row needed to reconstruct one restore point. */
async function captureStoredRestoreChain(
  backupId: string,
  sandboxRecordId: string,
): Promise<StoredAgentSandboxBackup[] | undefined> {
  const chain: StoredAgentSandboxBackup[] = [];
  const seen = new Set<string>();
  let cursorId: string | null = backupId;

  while (cursorId) {
    if (seen.has(cursorId)) throw new Error(`Backup chain cycle at ${cursorId}`);
    seen.add(cursorId);
    const cursor = await agentSandboxesRepository.getStoredBackupById(cursorId);
    if (!cursor || cursor.sandbox_record_id !== sandboxRecordId) return undefined;
    chain.push(cursor);
    if (cursor.backup_kind === "full") return chain;
    if (!cursor.parent_backup_id) {
      throw new Error(`Incremental backup ${cursor.id} has no parent`);
    }
    if (chain.length > MAX_RESTORE_AUTHORITY_CHAIN_DEPTH) {
      throw new Error(
        `Backup chain for ${backupId} exceeds ${MAX_RESTORE_AUTHORITY_CHAIN_DEPTH} rows`,
      );
    }
    cursorId = cursor.parent_backup_id;
  }

  return undefined;
}

function storedRestoreChainStillCanonical(
  current: StoredAgentSandboxBackup[],
  captured: StoredAgentSandboxBackup[],
): boolean {
  if (current.length !== captured.length) return false;
  const currentById = new Map(current.map((row) => [row.id, row]));
  return captured.every((row) => {
    const candidate = currentById.get(row.id);
    return candidate !== undefined && storedRestorePointStillCanonical(candidate, row);
  });
}

function storedRestoreChainMatchesReviewedAuthority(
  storedChain: readonly StoredAgentSandboxBackup[],
  sandboxRecordId: string,
  directive: ReviewedProvisionRestoreOverride,
): boolean {
  if (
    storedChain.length !== directive.expectedBackupChain.length ||
    directive.expectedBackupChain[0]?.backupId !== directive.backupId ||
    directive.expectedBackupChain[0]?.contentHash !== directive.expectedContentHash
  ) {
    return false;
  }
  const expectedById = new Map(
    directive.expectedBackupChain.map((entry) => [entry.backupId, entry]),
  );
  return storedChain.every((stored) => {
    const expected = expectedById.get(stored.id);
    return (
      expected !== undefined &&
      stored.id === expected.backupId &&
      stored.sandbox_record_id === sandboxRecordId &&
      stored.backup_kind === expected.backupKind &&
      stored.parent_backup_id === expected.parentBackupId &&
      stored.content_hash === expected.contentHash &&
      stored.verification_status === "verified" &&
      stored.verified_at !== null &&
      stored.catalog_version === expected.catalogVersion &&
      stored.catalog_state === expected.catalogState &&
      stored.catalog_deleted_at === null
    );
  });
}

function reviewedProvisionAuthorityHash(directive: ReviewedProvisionAuthorityOverride): string {
  return crypto.createHash("sha256").update(JSON.stringify(directive)).digest("hex");
}

async function assertReviewedSelectionReceipt(
  sandboxRecordId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<typeof personalDedicatedAdoptionSelections.$inferSelect> {
  const [selection] = await dbWrite
    .select()
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.id, directive.selectionId),
        eq(personalDedicatedAdoptionSelections.dedicated_agent_id, sandboxRecordId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(1);
  if (!selection) throw new Error(RESTORE_BACKUP_CHANGED);
  const receiptAuthority = personalDedicatedActivationAuthorityFromReceipt(
    selection.activation_kind,
    selection.activation_backup_id,
    selection.activation_backup_hash,
    selection.activation_backup_chain,
  );
  if (directive.kind === "reviewed-fresh-boot") {
    if (receiptAuthority?.kind !== "fresh-boot") throw new Error(RESTORE_BACKUP_CHANGED);
    return selection;
  }
  if (
    receiptAuthority?.kind !== "from-legacy-backup" ||
    personalDedicatedActivationAuthorityKey(receiptAuthority) !==
      personalDedicatedActivationAuthorityKey({
        kind: "from-legacy-backup",
        backupId: directive.backupId,
        backupHash: directive.expectedContentHash,
        backupChain: directive.expectedBackupChain,
      })
  ) {
    throw new Error(RESTORE_BACKUP_CHANGED);
  }
  return selection;
}

export async function assertReviewedFreshBootAuthority(
  sandboxRecordId: string,
  directive: Extract<ProvisionRestoreOverride, { kind: "reviewed-fresh-boot" }>,
): Promise<void> {
  try {
    await assertReviewedSelectionActivationAuthority(sandboxRecordId, directive);
  } catch {
    throw new ApiError(
      409,
      "session_not_ready",
      "Reviewed fresh-boot authority changed before Dedicated provisioning",
    );
  }
}

async function assertReviewedSelectionActivationAuthority(
  sandboxRecordId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<void> {
  const selection = await assertReviewedSelectionReceipt(sandboxRecordId, directive);
  const backups = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
    .orderBy(asc(agentSandboxBackups.id));
  const currentAuthority = personalDedicatedActivationAuthority(
    selection.organization_id,
    sandboxRecordId,
    backups.map(personalDedicatedBackupProvenanceFromStored),
  );
  const reviewedAuthority =
    directive.kind === "reviewed-fresh-boot"
      ? ({ kind: "fresh-boot" } as const)
      : ({
          kind: "from-legacy-backup",
          backupId: directive.backupId,
          backupHash: directive.expectedContentHash,
          backupChain: directive.expectedBackupChain,
        } as const);
  if (
    personalDedicatedActivationAuthorityKey(currentAuthority) !==
    personalDedicatedActivationAuthorityKey(reviewedAuthority)
  ) {
    throw new Error(RESTORE_BACKUP_CHANGED);
  }
}

interface ReviewedProvisionAdmissionFence {
  selectionId: string;
  hash: string;
  reviewedRestore?: PreparedReviewedProvisionRestore;
}

async function releaseReviewedProvisionAdmissionFence(
  fence: ReviewedProvisionAdmissionFence,
): Promise<void> {
  await dbWrite
    .update(personalDedicatedAdoptionSelections)
    .set({ restore_fence_hash: null, restore_fence_started_at: null, updated_at: new Date() })
    .where(
      and(
        eq(personalDedicatedAdoptionSelections.id, fence.selectionId),
        eq(personalDedicatedAdoptionSelections.restore_fence_hash, fence.hash),
      ),
    );
}

async function acquireReviewedProvisionAdmissionFence(
  sandboxRecordId: string,
  organizationId: string,
  directive: ReviewedProvisionAuthorityOverride,
): Promise<ReviewedProvisionAdmissionFence> {
  const hash = reviewedProvisionAuthorityHash(directive);
  await dbWrite.transaction(async (tx) => {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(organizationId, sandboxRecordId));
    const [agent] = await tx
      .select({ id: agentSandboxes.id })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, sandboxRecordId),
          eq(agentSandboxes.organization_id, organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!agent) throw new Error(RESTORE_AUTHORITY_CHANGED);
    const [selection] = await tx
      .select()
      .from(personalDedicatedAdoptionSelections)
      .where(
        and(
          eq(personalDedicatedAdoptionSelections.id, directive.selectionId),
          eq(personalDedicatedAdoptionSelections.organization_id, organizationId),
          eq(personalDedicatedAdoptionSelections.dedicated_agent_id, sandboxRecordId),
          eq(personalDedicatedAdoptionSelections.schema_version, 1),
        ),
      )
      .for("update")
      .limit(1);
    if (!selection || (selection.restore_fence_hash && selection.restore_fence_hash !== hash)) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    const receiptAuthority = personalDedicatedActivationAuthorityFromReceipt(
      selection.activation_kind,
      selection.activation_backup_id,
      selection.activation_backup_hash,
      selection.activation_backup_chain,
    );
    const expectedAuthority =
      directive.kind === "reviewed-fresh-boot"
        ? ({ kind: "fresh-boot" } as const)
        : ({
            kind: "from-legacy-backup",
            backupId: directive.backupId,
            backupHash: directive.expectedContentHash,
            backupChain: directive.expectedBackupChain,
          } as const);
    if (
      personalDedicatedActivationAuthorityKey(receiptAuthority) !==
      personalDedicatedActivationAuthorityKey(expectedAuthority)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    await tx
      .update(personalDedicatedAdoptionSelections)
      .set({
        restore_fence_hash: hash,
        restore_fence_started_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(personalDedicatedAdoptionSelections.id, selection.id));
  });

  const fence: ReviewedProvisionAdmissionFence = { selectionId: directive.selectionId, hash };
  try {
    if (directive.kind === "from-reviewed-backup") {
      fence.reviewedRestore = await assertReviewedProvisionRestoreAuthority(
        sandboxRecordId,
        directive,
      );
    } else {
      await assertReviewedFreshBootAuthority(sandboxRecordId, directive);
    }
    return fence;
  } catch (error) {
    await releaseReviewedProvisionAdmissionFence(fence);
    throw error;
  }
}

interface PreparedReviewedProvisionRestore {
  storedChain: StoredAgentSandboxBackup[];
  backup: AgentSandboxBackup;
  state: AgentBackupStateData;
}

/**
 * Read, authenticate, decrypt, and reconstruct the exact reviewed chain before
 * provider admission. A second capture closes DB/R2 read races; the provision
 * path repeats this after the job-level check and carries the materialized
 * state to the final locked push rather than downgrading to a mutable id.
 */
export async function assertReviewedProvisionRestoreAuthority(
  sandboxRecordId: string,
  directive: ReviewedProvisionRestoreOverride,
): Promise<PreparedReviewedProvisionRestore> {
  try {
    await assertReviewedSelectionActivationAuthority(sandboxRecordId, directive);
    const storedChain = await captureStoredRestoreChain(directive.backupId, sandboxRecordId);
    if (
      !storedChain ||
      !storedRestoreChainMatchesReviewedAuthority(storedChain, sandboxRecordId, directive)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    const reconstructed = await reconstructStoredAgentSandboxBackupChain(storedChain);
    const confirmedChain = await captureStoredRestoreChain(directive.backupId, sandboxRecordId);
    if (
      !confirmedChain ||
      !storedRestoreChainStillCanonical(confirmedChain, storedChain) ||
      !storedRestoreChainMatchesReviewedAuthority(confirmedChain, sandboxRecordId, directive)
    ) {
      throw new Error(RESTORE_BACKUP_CHANGED);
    }
    return { storedChain, backup: reconstructed.target, state: reconstructed.state };
  } catch {
    throw new ApiError(
      409,
      "session_not_ready",
      "Reviewed backup authority changed before Dedicated provisioning",
    );
  }
}

/**
 * Outcome of carrying an agent's state onto a replacement container.
 *
 * `capture-unsupported` is not a failure to retry: the running image has no
 * snapshot endpoint, so the agent cannot be relocated at all and must be left
 * where it is. Every other reason describes a move that did not happen and can
 * be attempted again.
 */
export type StateTransferOutcome =
  | { transferred: true; snapshotId: string; sizeBytes: number }
  | {
      transferred: false;
      reason: "capture-unsupported" | "capture-failed" | "reconstruct-failed" | "push-failed";
      detail: string;
    };

/**
 * Sentinel error for "the running agent image does not serve POST /api/snapshot".
 * The deployed elizaOS (V2) agent image binds its API to ELIZA_PORT/PORT and
 * does not expose the bridge `/api/snapshot` route — only the cloud-agent
 * template image (and the in-memory test double) do. A scheduled (auto) backup
 * against such an agent is a no-op, not a failure, so the snapshot job treats
 * this exactly like "Sandbox is not running": skip without burning retries.
 */
export const SNAPSHOT_ENDPOINT_UNSUPPORTED = "Snapshot endpoint not supported by agent image";

/**
 * Transient pre-stop snapshot failure (agent returned 503 because its PGlite
 * connection was closing while dumpDataDir() ran). Distinct from a hard 500 so
 * a state-preserving restart can defer rather than permanently refuse to stop
 * (2026-08-11 fleet incident: a 500 here wedged healthy agent restarts).
 */
export const SNAPSHOT_CAPTURE_TRANSIENT = "Snapshot capture temporarily unavailable";
const AGENT_SNAPSHOT_CAPTURE_TRANSIENT_CODE = "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT";

const MAX_BACKUPS = 10;
// Heartbeat probes the agent over the headscale tailnet. When idle the path
// goes cold, so the first probe after a quiet period can fail while it
// re-establishes — retry before evicting a healthy agent.
const HEARTBEAT_PROBE_ATTEMPTS = 3;
const HEARTBEAT_PROBE_RETRY_MS = 2_000;
// A single failed cycle must not evict. Only mark disconnected after the agent
// has been continuously unreachable this long — last_heartbeat_at (bumped only
// on success) is the downtime clock. The ~30s heartbeat itself keeps the
// WireGuard NAT mapping warm, so a reachable agent never trips this.
const HEARTBEAT_DISCONNECT_AFTER_MS = 120_000;

// IP reconciliation (heartbeat + recovery): agent containers do not persist
// tailscale node state, so a container restart mints a fresh node key and
// headscale hands out the NEXT sequential IP — the stored headscale_ip /
// bridge_url go stale while the container itself is healthy. Every consumer
// reads those stored columns (the heartbeat probe, the agent-router's
// subdomain resolution, and therefore the public dedicated-agent proxy), so
// the heal must REPAIR the columns, not tolerate the miss.
const RECONCILE_SSH_CMD_TIMEOUT_MS = 15_000;
// Cap on consecutive heartbeat cycles a docker-healthy container may stay
// `running` while its current tailnet IP cannot be resolved (node SSH down,
// docker exec failing). Each such cycle guards error_count; hitting the cap
// escalates to `disconnected` so the recovery cycle's reprovision self-heal
// still fires — an unreachable paid agent must never look "running" forever.
const IP_RECONCILE_MAX_UNRESOLVED_CYCLES = 3;
const DB_LIVENESS_RESTART_MARKER = "[db-liveness-restart]";
const DB_LIVENESS_RESTART_BUDGET = 3;
const DB_LIVENESS_RESTART_COOLDOWN_MS = 10 * 60_000;
const DB_LIVENESS_RESTART_BUDGET_WINDOW_MS = 60 * 60_000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 120_000;
/**
 * Maximum bytes to read from a snapshot-fetch error response body for
 * diagnostic logging (#18228). The body distinguishes an agent-side 500
 * (carries the thrown error message) from a bridge/proxy-hop 500 (proxy
 * error page or empty). Bounded so a malicious or misconfigured upstream
 * cannot exhaust Worker memory.
 */
const SNAPSHOT_ERROR_BODY_EXCERPT_BYTES = 512;
/**
 * Hydration budgets (#16639): the worker heap died buffering unbounded
 * snapshot bodies (`res.json()` retained everything, then a re-stringify
 * doubled it). The raw budget is enforced WHILE streaming — bytes past it are
 * never retained — and the expanded file budgets are validated before the
 * payload is persisted. Env-overridable for staging soak.
 *
 * The raw budget is the RETAIN side of the v1 wire contract, so it is bounded
 * by what restore accepts: the override may lower it, never raise it past
 * `MAX_RESTORABLE_AGENT_BACKUP_BYTES` (#17172). Retaining more than that
 * yields a snapshot that authorizes a cutover and can never be restored.
 */
const SNAPSHOT_MAX_RAW_BYTES = resolveRetainableAgentBackupBytes(
  process.env.ELIZA_SNAPSHOT_MAX_RAW_BYTES,
);
const SNAPSHOT_MAX_FILES = (() => {
  const raw = Number.parseInt(process.env.ELIZA_SNAPSHOT_MAX_FILES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
})();
const SNAPSHOT_MAX_EXPANDED_BYTES = (() => {
  const raw = Number.parseInt(process.env.ELIZA_SNAPSHOT_MAX_EXPANDED_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 384 * 1024 * 1024;
})();
const SNAPSHOT_RESTORE_TIMEOUT_MS = 120_000;
const UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS = 30_000;
// A timed-out lifecycle awaiter does not cancel its underlying work. Keep a
// pre-cutover replacement out of the crash-recovery sweep long enough for the
// 15-minute cold-boot job ceiling and any bounded leaf cleanup to settle.
const PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES = 30;
// Hard cap on the container+VPN teardown during agent delete. The underlying
// docker rm (60s) and headscale deletion (15s) are each internally bounded, but
// an EARLY hang (SSH connect / provider init) was not — and a single stuck node
// could then hang the delete past the 300s job watchdog and wedge the whole
// provisioning worker. Generous over the internal caps, well under the watchdog.
const SANDBOX_DELETE_STOP_TIMEOUT_MS = 120_000;
type LifecycleTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Columns the tailnet-IP reconcile path reads to locate and repair an agent. */
type ReconcilableSandbox = Pick<
  AgentSandbox,
  | "id"
  | "node_id"
  | "container_name"
  | "environment_vars"
  | "bridge_url"
  | "health_url"
  | "headscale_ip"
>;

/** Outcome of a stale-tailnet-IP reconcile attempt (see reconcileStaleTailnetIp). */
type TailnetIpReconcileResult =
  | { outcome: "repaired"; headscaleIp: string; bridgeUrl: string; healthUrl: string }
  | { outcome: "container-dead" }
  | { outcome: "ip-unresolvable" }
  | { outcome: "unrepairable" };

interface AdminCanaryImageExecutionPolicy {
  operation: "upgrade" | "rollback";
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
  onCutoverInTx: (
    tx: DbTransaction,
    result: {
      oldNodeId: string;
      oldContainerName: string;
      newNodeId: string;
      newContainerName: string;
      newDigest: string;
    },
  ) => Promise<void>;
  onConvergedInTx: (tx: DbTransaction) => Promise<void>;
}

interface ImageSwapResult {
  success: boolean;
  oldNodeId?: string;
  oldContainerName?: string;
  newNodeId?: string;
  newContainerName?: string;
  newDigest?: string | null;
  error?: string;
  /**
   * True when a failed upgrade left the old container serving. The permanent
   * failure writeback must not mark such a sandbox terminal because the proxy
   * and orphan reconciler treat terminal rows as unavailable. Every blue
   * provision, health, digest, runtime, snapshot, and swap failure occurs
   * before cutover and tears down only blue; `false` is reserved for an agent
   * whose old container was already not serving.
   */
  rolledBack?: boolean;
  /**
   * The image cutover committed, but the replaced container's durable cleanup
   * fence remains populated. Callers must not present the operation as fully
   * converged until the replacement-cleanup reconciler clears it.
   */
  cleanupPending?: boolean;
}

type ReplacementCleanupLocator = {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  replacementAttemptId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
  vpnNodeName: string | null;
  previousVpnNodeId: string | null;
  vpnRegistrationStartedAt: Date | null;
  allocationCounted: boolean;
  createdAt: Date;
};

type ReplacementCleanupExpectation = {
  status: AgentSandboxStatus;
  environmentRevision: number;
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
};

export interface AdminCanaryCleanupExpectation {
  targetOwnerUserId: string;
  targetImage: string;
  targetDigest: string;
  newNodeId: string;
  newContainerName: string;
  oldNodeId: string;
  oldContainerName: string;
}

export class AdminCanaryCleanupExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCanaryCleanupExpectationError";
  }
}

function digestPinnedImageRef(imageRef: string, digest: string): string {
  if (imageRef.includes("@sha256:")) return imageRef;
  const lastColon = imageRef.lastIndexOf(":");
  const lastSlash = imageRef.lastIndexOf("/");
  const withoutTag = lastColon > lastSlash ? imageRef.slice(0, lastColon) : imageRef;
  return `${withoutTag}@${digest}`;
}

/**
 * Stream a Response body, enforcing a hard byte budget (#16639): the read is
 * aborted the moment the counted bytes exceed the budget, so an oversized
 * snapshot can never be retained in memory. Fail-closed with an explicit,
 * observable error.
 */
export async function readBodyWithinBudget(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new Error(
        `Snapshot payload exceeds the raw hydration budget (${maxBytes} bytes) — refusing to retain it`,
      );
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error(
            `Snapshot payload exceeds the raw hydration budget (${maxBytes} bytes) — refusing to retain it`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    // Release the connection whether we finished or bailed over budget.
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Validate the parsed snapshot's expanded budgets BEFORE it is persisted
 * (#16639): total file count and summed content bytes across the legacy
 * `workspaceFiles` map and the durable manifest files. Fail-closed — a
 * payload over budget is rejected outright, never partially restored.
 */
export function assertSnapshotExpandedBudgets(stateData: AgentBackupStateData): void {
  let files = 0;
  let expandedBytes = 0;
  const workspace = stateData.workspaceFiles ?? {};
  for (const content of Object.values(workspace)) {
    files += 1;
    expandedBytes += typeof content === "string" ? Buffer.byteLength(content, "utf-8") : 0;
  }
  const components = stateData.manifest?.components;
  if (components) {
    const fileSets = [
      components.database?.pglite,
      components.media,
      components.vault,
      components.stateFiles,
    ];
    for (const fileSet of fileSets) {
      for (const entry of fileSet?.files ?? []) {
        files += 1;
        // `size` is the declared decoded size; the base64 payload is the
        // retained one — count the larger of the two so a lying manifest
        // cannot under-declare.
        const decoded =
          typeof entry.bytesBase64 === "string"
            ? Math.floor((entry.bytesBase64.length * 3) / 4)
            : 0;
        expandedBytes += Math.max(typeof entry.size === "number" ? entry.size : 0, decoded);
      }
    }
    const configFile = components.character?.configFile;
    if (configFile) {
      files += 1;
      expandedBytes +=
        typeof configFile.bytesBase64 === "string"
          ? Math.floor((configFile.bytesBase64.length * 3) / 4)
          : 0;
    }
  }
  if (files > SNAPSHOT_MAX_FILES) {
    throw new Error(
      `Snapshot exceeds the file budget (${files} > ${SNAPSHOT_MAX_FILES}) — refusing to retain it`,
    );
  }
  if (expandedBytes > SNAPSHOT_MAX_EXPANDED_BYTES) {
    throw new Error(
      `Snapshot exceeds the expanded byte budget (${expandedBytes} > ${SNAPSHOT_MAX_EXPANDED_BYTES}) — refusing to retain it`,
    );
  }
}

function isDockerSandboxMetadata(value: unknown): value is DockerSandboxMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker" &&
    typeof (value as { nodeId?: unknown }).nodeId === "string" &&
    typeof (value as { hostname?: unknown }).hostname === "string" &&
    typeof (value as { containerName?: unknown }).containerName === "string"
  );
}

/**
 * True when a provider handle's metadata self-identifies as the real docker
 * fleet provider (`provider: "docker"`) — REGARDLESS of whether the rest of the
 * shape passes {@link isDockerSandboxMetadata}. This is deliberately laxer than
 * the full type guard: a docker-fleet container whose metadata drifts (a missing
 * field, an empty-string nodeId) still IS docker-backed and still occupies a
 * real node slot, even though the strict guard would reject it.
 *
 * Used to detect the C1b failure class (audit §C1b): a handle that is docker-
 * backed but for which we cannot recover a usable node_id. Such a row MUST NOT
 * be flipped to `running` (it would be an unattributable orphan the recount
 * undercounts and the orphan reconciler provably cannot reap — audit §C5).
 *
 * Non-docker providers (`local-docker`, `memory`) return false: they have no
 * node concept, so the attribution guard does not apply to them.
 */
function isDockerBackedMetadata(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker"
  );
}

/**
 * Distinguishable prefix for the C1b attribution-guard failure. Chosen so it can
 * NEVER collide with the port-collision retry classifier in provision()'s catch
 * (which matches "23505" / "unique" / "duplicate") — metadata drift is a
 * permanent-ish condition, so this failure must classify as NON-retryable and
 * fall through to markError, not spin the retry loop.
 */
const PROVISION_ATTRIBUTION_GUARD_PREFIX = "provision attribution guard:";

type RuntimeAgentSummary = {
  id?: string;
  name?: string;
  status?: string;
};

type RuntimeAgentListResult = {
  supported: boolean;
  agents: RuntimeAgentSummary[];
};

type AgentNetworkTarget = Pick<
  AgentSandbox,
  | "id"
  | "bridge_url"
  | "health_url"
  | "node_id"
  | "bridge_port"
  | "web_ui_port"
  | "headscale_ip"
  | "sandbox_id"
>;

type AgentApiTarget = AgentNetworkTarget & Pick<AgentSandbox, "environment_vars">;

type AgentFetchTarget = {
  url: string;
  forwardedHost?: string;
};

const AGENT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

class AgentRouterConfigurationError extends Error {
  constructor(variable: "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN") {
    super(`Worker agent routing requires a valid ${variable}`);
    this.name = "AgentRouterConfigurationError";
  }
}

const DEFAULT_CENTRAL_SERVER_ID = "00000000-0000-0000-0000-000000000000";

class BridgeRouteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeRouteUnavailableError";
  }
}

/**
 * Decide how the shared managed DB URL is exposed to an agent container (#8696).
 *
 * - A self-contained image that shipped its OWN `DATABASE_URL` keeps it; the
 *   managed URL is exposed under `ELIZA_MANAGED_DATABASE_URL` so it can opt in.
 * - A local-state agent (provisioned with `ELIZA_AGENT_LOCAL_STATE=1`) keeps
 *   agent-state in a local in-container PGlite DB on the persistent volume and
 *   uses the shared DB only for auth/discovery via the cloud API. The managed URL
 *   is exposed as `ELIZA_MANAGED_DATABASE_URL` (opt-in) and `DATABASE_URL` is left
 *   UNSET so plugin-sql falls back to local PGlite — removing the shared-Postgres
 *   connection hot path.
 * - Otherwise (existing agents with no flag) the managed URL is injected as
 *   `DATABASE_URL`, byte-identical to the prior behavior — a forward cutover with
 *   no migration.
 */
export function computeManagedAgentDbEnv(
  callerEnv: Record<string, string>,
  dbUri: string,
): Record<string, string> {
  const callerSuppliedDatabaseUrl =
    typeof callerEnv.DATABASE_URL === "string" && callerEnv.DATABASE_URL.trim().length > 0;
  const wantsLocalState = callerEnv.ELIZA_AGENT_LOCAL_STATE === "1";
  return callerSuppliedDatabaseUrl || wantsLocalState
    ? { ELIZA_MANAGED_DATABASE_URL: dbUri }
    : { DATABASE_URL: dbUri };
}

// HTTP statuses that make a snapshot fetch/restore fail for THIS snapshot in a
// way the current provision cannot retry away, so it must degrade to a fresh
// boot instead of bricking the agent (#15210): 401/403 (auth — a dead/rotated
// container or an unauthenticated/rotating token rejects every retry
// identically), 404 (endpoint or snapshot gone), 410 (gone). Everything else —
// 5xx, 408/429, network/timeout — can heal on a retry and must NOT appear here.
const UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES = new Set([401, 403, 404, 410]);
// The subset that is also PERMANENTLY LOST — the snapshot itself is gone and no
// later resume can restore it, so the dead backup chain should be pruned: 404
// (endpoint or snapshot gone) and 410 (gone). 401/403 are auth failures, which
// are RECOVERABLE (missing/rotating token — see #15263, where the incident 401
// was a healthy container whose restore push simply omitted the agent token),
// so they must degrade-but-PRESERVE the chain: never prune a snapshot a
// token-corrected resume could still restore (#15274).
const PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES = new Set([404, 410]);

// Anchored on the exact `fetchSnapshotState` / `pushState` throw shapes so only
// this file's snapshot HTTP throw sites classify — an unrelated error that
// merely embeds one of these strings does not.
const SNAPSHOT_HTTP_ERROR_SHAPE =
  /^(?:Snapshot fetch failed|State restore failed): HTTP (\d{3})(?:\s|$)/;

/**
 * True only when a stored backup snapshot can never be applied, no matter how
 * many times the provision retries. An agent's identity, config, and durable
 * data live in the DB record; a snapshot holds only volatile in-memory session
 * state — so the designed degrade for an unrecoverable snapshot (#15210) is
 * "boot fresh, lose only the volatile session", never "brick the whole agent".
 * Two shapes qualify:
 *
 * - UNDECRYPTABLE: the AEAD auth tag fails to verify (corruption / wrong key /
 *   wrong AAD, surfaced by the core KMS as `AeadError`) or the KMS key
 *   version that encrypted it no longer exists (`KeyNotFoundError` — thrown
 *   only by the ephemeral `memory` KMS backend, which derives a fresh
 *   per-process key on every restart and thus orphans everything it previously
 *   encrypted). Matched by error class NAME rather than `instanceof` because
 *   `AeadError` is internal to the core KMS submodule (not exported) and this code
 *   runs bundled, where a cross-realm `instanceof` on a dependency's error
 *   class is unreliable.
 * - UNRETRIEVABLE / UNRESTORABLE: the snapshot fetch or restore push was
 *   rejected with an unrecoverable-for-this-provision HTTP status (see
 *   `UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES`). The incident shape (HQ 14308, agent
 *   23766030): `State restore failed: HTTP 401 {"error":"Unauthorized"}` from a
 *   bridge URL — deterministic on every attempt of THIS provision, so retrying
 *   only re-failed it into status=error.
 *
 * Deliberately NARROW so it never swallows a recoverable failure: HTTP 5xx /
 * 408 / 429, network/timeout errors, a transient KMS error (the Steward
 * backend surfaces HTTP 5xx as a base `KmsError`, not `KeyNotFoundError`), and
 * DB/IO errors are NOT matched and still propagate — degrading on one of those
 * would silently discard state that a retry would have restored.
 *
 * NOTE: "unrecoverable for this provision" (boot fresh) is a strictly WIDER
 * classification than "permanently lost" (also prune the chain). A 401/403 is
 * unrecoverable here but the snapshot is NOT permanently lost — an auth failure
 * heals once the token is attached/rotated correctly (#15263), so
 * `isPermanentlyLostSnapshot` must gate any pruning, never this predicate.
 */
export function isUnrecoverableSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  // A size refusal is deliberately NOT unrecoverable-for-this-provision. It is
  // deterministic, so retrying is pointless — but the chain is intact and
  // restorable in principle, and the only reason it cannot be applied is a
  // limit WE chose. Degrading it to a fresh boot would discard recoverable
  // state; it gets its own terminal branch at each restore site instead, and
  // the one way past it is wake's explicit `forceFreshBoot` consent.
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}

/**
 * True only when the snapshot is PERMANENTLY LOST — no later resume, on any
 * container with any token, can ever restore it — so the dead backup chain is
 * safe to prune. A strict SUBSET of `isUnrecoverableSnapshotError`:
 *
 * - The crypto shapes (`AeadError` / `KeyNotFoundError`): the bytes can never
 *   be decrypted again (corruption, or the ephemeral `memory` KMS key that
 *   encrypted them is gone), so the chain is genuinely dead.
 * - HTTP 404 (endpoint or snapshot gone) / 410 (gone): the snapshot resource
 *   itself no longer exists to fetch.
 *
 * Excludes 401/403: those are AUTH failures (missing/rotating token), which are
 * RECOVERABLE — pruning on one would silently, permanently discard a snapshot a
 * token-corrected resume could still restore (#15274 regression class). On an
 * auth failure we still degrade to a fresh boot (never brick), but we PRESERVE
 * the chain and let the next authenticated resume restore it.
 */
export function isPermanentlyLostSnapshot(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}

/**
 * Rollback signal for `prepareManagedLaunchEnvironment`: the guarded
 * environment write matched no row, so another lifecycle owner won the race.
 * Thrown purely to unwind the transaction that also carries the credential
 * rotation, and converted back to `undefined` by the method that raised it —
 * it never escapes to a caller.
 */
class ManagedLaunchOwnershipLost extends Error {
  constructor() {
    super("Managed launch lost its agent ownership CAS");
    this.name = "ManagedLaunchOwnershipLost";
  }
}

/**
 * Read a bounded excerpt of an error response body for diagnostic logging.
 * Returns a trimmed string or null when the body is empty. Used by
 * `fetchSnapshotState` (#18228) so an agent-side 500 (carrying the thrown
 * error message) is distinguishable from a bridge/proxy-hop 500 (proxy error
 * page or empty body) in Worker logs.
 *
 * Streams the body via a ReadableStream reader and stops after
 * SNAPSHOT_ERROR_BODY_EXCERPT_BYTES of UTF-8, cancelling the remainder —
 * never buffering the full response (a malicious upstream could OOM the
 * Worker with an unbounded body).
 */
export async function readErrorBodyExcerpt(
  res: Pick<Response, "body" | "headers">,
): Promise<string | null> {
  // error-policy:J2 non-blocking diagnostic — a body-read failure degrades to
  // a null excerpt (status-only message) without aborting the snapshot path.
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const chunks: string[] = [];
    let totalBytes = 0;
    try {
      // error-policy:J2 stream cancellation after the byte budget is reached.
      while (totalBytes < SNAPSHOT_ERROR_BODY_EXCERPT_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = SNAPSHOT_ERROR_BODY_EXCERPT_BYTES - totalBytes;
        const sliced = value.length >= remaining ? truncateUtf8Bytes(value, remaining) : value;
        chunks.push(decoder.decode(sliced, { stream: true }));
        totalBytes += sliced.length;
      }
    } finally {
      // Cancel the reader to release the connection even if the body is larger.
      await reader.cancel().catch(() => {});
    }
    // Flush any trailing multi-byte UTF-8 sequence held by the stream decoder.
    chunks.push(decoder.decode());
    const body = chunks.join("");
    if (!body.trim()) return null;
    const contentType = res.headers.get("content-type") ?? "";
    // JSON error bodies carry structured diagnostics — try to extract a message.
    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(body) as { error?: unknown; message?: unknown };
        const msg = data.error ?? data.message;
        if (typeof msg === "string" && msg.trim()) {
          return msg.trim();
        }
      } catch {
        // Not valid JSON — fall through to raw excerpt.
      }
    }
    return body.trim();
  } catch {
    return null;
  }
}

/** Truncate UTF-8 bytes without splitting a multi-byte code point. */
function truncateUtf8Bytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const limit = Math.min(bytes.length, maxBytes);
  let safeEnd = limit;
  while (safeEnd > 0) {
    const byte = bytes[safeEnd - 1]!;
    if ((byte & 0x80) === 0) {
      return bytes.slice(0, safeEnd);
    }
    if ((byte & 0xc0) === 0x80) {
      safeEnd--;
      continue;
    }
    let sequenceLength = 1;
    if ((byte & 0xf8) === 0xf0) sequenceLength = 4;
    else if ((byte & 0xf0) === 0xe0) sequenceLength = 3;
    else if ((byte & 0xe0) === 0xc0) sequenceLength = 2;
    if (safeEnd - 1 + sequenceLength <= limit) {
      return bytes.slice(0, limit);
    }
    return bytes.slice(0, safeEnd - 1);
  }
  return bytes.slice(0, 0);
}

export class ElizaSandboxService {
  private _provider?: SandboxProvider;
  private _providerPromise?: Promise<SandboxProvider>;

  private readonly testHooks?: ElizaSandboxServiceTestHooks;

  constructor(provider?: SandboxProvider, testHooks?: ElizaSandboxServiceTestHooks) {
    if (provider) {
      this._provider = provider;
    }
    this.testHooks = testHooks;
  }

  private async getProvider(): Promise<SandboxProvider> {
    if (this._provider) return this._provider;
    if (!this._providerPromise) {
      this._providerPromise = createSandboxProvider().then((p) => {
        this._provider = p;
        return p;
      });
    }
    return this._providerPromise;
  }

  private getAgentApiToken(rec: Pick<AgentSandbox, "id" | "environment_vars">): string | undefined {
    const envVars = rec.environment_vars as Record<string, string> | null;
    const apiToken =
      envVars?.ELIZA_API_TOKEN?.trim() ||
      envVars?.ELIZAOS_API_KEY?.trim() ||
      envVars?.ELIZAOS_CLOUD_API_KEY?.trim();
    if (!apiToken) {
      logger.warn("[agent-sandbox] No API token for agent proxy", {
        agentId: rec.id,
      });
      return undefined;
    }
    return apiToken;
  }

  private getAgentJsonHeaders(rec: Pick<AgentSandbox, "id" | "environment_vars">) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiToken = this.getAgentApiToken(rec);
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
      headers["X-Api-Key"] = apiToken;
      headers["X-Eliza-Token"] = apiToken;
    }
    return headers;
  }

  private getRuntimeAgentsFromBody(body: unknown): RuntimeAgentSummary[] {
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const rawAgents = Array.isArray(root.agents)
      ? root.agents
      : Array.isArray(data.agents)
        ? data.agents
        : [];

    return rawAgents
      .map((item): RuntimeAgentSummary | null => {
        if (!item || typeof item !== "object") return null;
        const agent = item as Record<string, unknown>;
        return {
          id: typeof agent.id === "string" ? agent.id : undefined,
          name:
            typeof agent.name === "string"
              ? agent.name
              : typeof agent.characterName === "string"
                ? agent.characterName
                : undefined,
          status: typeof agent.status === "string" ? agent.status : undefined,
        };
      })
      .filter((agent): agent is RuntimeAgentSummary => Boolean(agent?.id || agent?.name));
  }

  private isRuntimeAgentReady(agent: RuntimeAgentSummary | undefined): boolean {
    if (!agent) return false;
    const status = agent.status?.toLowerCase();
    return status === "active" || status === "running" || status === "ready";
  }

  private selectRuntimeAgent(agents: RuntimeAgentSummary[]): RuntimeAgentSummary | undefined {
    return agents.find((agent) => this.isRuntimeAgentReady(agent)) ?? agents[0];
  }

  private async listRuntimeAgents(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
  ): Promise<RuntimeAgentListResult> {
    const agentsRes = await this.fetchAgentApi(rec, "/api/agents", {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (agentsRes.status === 404) {
      return { supported: false, agents: [] };
    }
    if (!agentsRes.ok) {
      throw new Error(`Runtime agent list returned HTTP ${agentsRes.status}`);
    }
    return {
      supported: true,
      agents: this.getRuntimeAgentsFromBody(await agentsRes.json().catch(() => ({}))),
    };
  }

  private buildRuntimeBootstrapAgent(
    rec: Pick<AgentSandbox, "id" | "agent_name" | "agent_config" | "environment_vars">,
  ) {
    const rawConfig =
      rec.agent_config && typeof rec.agent_config === "object" && !Array.isArray(rec.agent_config)
        ? ({ ...(rec.agent_config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawName =
      typeof rawConfig.name === "string" && rawConfig.name.trim()
        ? rawConfig.name.trim()
        : rec.agent_name?.trim() || `Cloud Agent ${rec.id}`;
    const plugins =
      Array.isArray(rawConfig.plugins) && rawConfig.plugins.length > 0
        ? rawConfig.plugins
        : ["@elizaos/plugin-sql", "@elizaos/plugin-elizacloud"];
    const rawSettings =
      rawConfig.settings &&
      typeof rawConfig.settings === "object" &&
      !Array.isArray(rawConfig.settings)
        ? ({ ...(rawConfig.settings as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawSecrets =
      rawSettings.secrets &&
      typeof rawSettings.secrets === "object" &&
      !Array.isArray(rawSettings.secrets)
        ? ({ ...(rawSettings.secrets as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const environmentVars =
      rec.environment_vars && typeof rec.environment_vars === "object"
        ? (rec.environment_vars as Record<string, string>)
        : {};
    const secrets = mergeRuntimeAgentSecretsFromEnv({ rawSecrets, environmentVars });
    const settings = {
      ...rawSettings,
      secrets,
    };

    return {
      ...rawConfig,
      name: rawName,
      username:
        typeof rawConfig.username === "string" && rawConfig.username.trim()
          ? rawConfig.username.trim()
          : rawName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "cloud-agent",
      // A dedicated agent is created with only a name (no persona is collected
      // at creation time), so without a real identity "what is your name" gets a
      // generic deflection. Seed a name-aware identity — mirroring
      // buildSharedRuntimeCharacter — so the runtime boots with a real system
      // prompt without claiming to be a differently-named character.
      system:
        typeof rawConfig.system === "string" && rawConfig.system.trim()
          ? rawConfig.system
          : `You are ${rawName}, a helpful assistant.`,
      bio:
        Array.isArray(rawConfig.bio) && rawConfig.bio.length > 0
          ? rawConfig.bio
          : [`${rawName} is a helpful Eliza Cloud agent.`],
      topics:
        Array.isArray(rawConfig.topics) && rawConfig.topics.length > 0 ? rawConfig.topics : [],
      adjectives:
        Array.isArray(rawConfig.adjectives) && rawConfig.adjectives.length > 0
          ? rawConfig.adjectives
          : [],
      style:
        rawConfig.style && typeof rawConfig.style === "object" && !Array.isArray(rawConfig.style)
          ? rawConfig.style
          : undefined,
      plugins,
      settings,
    };
  }

  private async startRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    runtimeAgentId: string,
  ): Promise<void> {
    const startRes = await this.fetchAgentApi(
      rec,
      `/api/agents/${encodeURIComponent(runtimeAgentId)}/start`,
      {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!startRes.ok) {
      throw new Error(`Runtime agent start returned HTTP ${startRes.status}`);
    }
  }

  private async createRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<string> {
    // Bootstrap secrets (OPENAI_API_KEY / ANTHROPIC_API_KEY / ...) are copied
    // out of environment_vars, which stores them encrypted at rest (#11332) —
    // materialize real values before building the bootstrap payload.
    const bootstrapEnv = await decryptAgentEnvVars(
      (rec.environment_vars as Record<string, string> | null) ?? {},
    );
    // Team credential pool (#11332): providers the agent has NO key for are
    // filled from the org's pooled credentials. Merged only into this
    // in-memory bootstrap payload (→ settings.secrets via
    // buildRuntimeBootstrapAgent) — never persisted to environment_vars.
    // A provider with no eligible pooled credential leaves the env unchanged
    // (the registry degrades a missing/unhealthy pool to null, its J4); a
    // genuine internal pool fault propagates and fails provisioning closed —
    // consistent with the decrypt/create throws above — rather than silently
    // booting an agent missing a credential it was meant to receive.
    const pooledEnv = await applyPooledCredentialsToBootstrapEnv({
      organizationId: rec.organization_id,
      userId: rec.user_id,
      sessionKey: rec.id,
      env: bootstrapEnv,
    });
    const createRes = await this.fetchAgentApi(rec, "/api/agents", {
      method: "POST",
      body: JSON.stringify({
        agent: this.buildRuntimeBootstrapAgent({ ...rec, environment_vars: pooledEnv }),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!createRes.ok) {
      throw new Error(`Runtime agent create returned HTTP ${createRes.status}`);
    }

    const body = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
    const data =
      body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
    const runtimeAgentId = typeof data.id === "string" ? data.id : undefined;
    if (!runtimeAgentId) {
      throw new Error("Runtime agent create response was missing data.id");
    }
    return runtimeAgentId;
  }

  private async ensureRuntimeAgentStarted(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<RuntimeAgentSummary | null> {
    const initial = await this.listRuntimeAgents(rec);
    if (!initial.supported) return null;

    const existing = this.selectRuntimeAgent(initial.agents);
    if (this.isRuntimeAgentReady(existing)) return existing ?? null;

    const runtimeAgentId = existing?.id ?? (await this.createRuntimeAgent(rec));
    await this.startRuntimeAgent(rec, runtimeAgentId);

    const afterStart = await this.listRuntimeAgents(rec);
    const started =
      afterStart.agents.find((agent) => agent.id === runtimeAgentId) ?? afterStart.agents[0];
    if (!this.isRuntimeAgentReady(started)) {
      throw new Error("Runtime agent did not become active after start");
    }
    return started;
  }

  private stableBridgeUuid(raw: string): string {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return raw;
    }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(
      17,
      20,
    )}-${hash.slice(20, 32)}`;
  }

  private stableBridgeUserId(params: Record<string, unknown>): string {
    const raw =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : typeof params.roomId === "string" && params.roomId.trim()
          ? params.roomId.trim()
          : "cloud-user";
    return this.stableBridgeUuid(raw);
  }

  private stableBridgeChannelId(agentId: string, params: Record<string, unknown>): string {
    const raw =
      typeof params.roomId === "string" && params.roomId.trim()
        ? params.roomId.trim()
        : typeof params.userId === "string" && params.userId.trim()
          ? params.userId.trim()
          : "default";
    return this.stableBridgeUuid(`cloud-bridge-channel:${agentId}:${raw}`);
  }

  // Agent CRUD

  async createAgent(params: CreateAgentParams): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    assertAgentExecutionTier(params.executionTier);
    // SECURITY (H1, #12230): gate a caller-supplied image against the managed-
    // agent allowlist BEFORE any DB write or provisioning. Throws
    // AgentImageNotAllowedError (→ 4xx at the route) so a non-allowlisted image
    // provisions nothing. Runs for EVERY createAgent caller — the gate lives in
    // the shared service path, not per-route.
    assertAgentImageAllowed(params.dockerImage);

    logger.info("[agent-sandbox] Creating agent", {
      orgId: params.organizationId,
      name: params.agentName,
      reuse: params.reuseExistingNonTerminal ?? false,
    });

    // Caller-supplied env can carry BYO secrets — encrypt them before the row
    // is inserted (#11332), mirroring updateAgentEnvironment.
    if (params.environmentVars && Object.keys(params.environmentVars).length > 0) {
      params = {
        ...params,
        environmentVars: await encryptAgentEnvVarsForStorage(
          params.organizationId,
          params.environmentVars,
        ),
      };
    }

    // Multi-agent-per-org callers (waifu launches, compat) leave the flag unset
    // and keep the plain insert — they legitimately mint several agents per org.
    if (!params.reuseExistingNonTerminal) {
      // Uncapped fast path for trusted internal multi-agent callers.
      if (params.maxNonTerminalAgents === undefined) {
        const created = await agentSandboxesRepository.create(
          buildAgentSandboxInsertValues(params),
        );
        return { agent: created, idempotent: false };
      }

      // Capped path (#11023): a user-facing forceCreate that bypasses the reuse
      // guard must still not mint unbounded dedicated containers. Count the org's
      // quota-holding sandboxes UNDER the same org advisory lock the reuse guard
      // uses and refuse past the cap.
      const cap = params.maxNonTerminalAgents;
      return dbWrite.transaction(async (tx) => {
        await configureElizaLifecycleTransaction(tx);
        await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
        await assertOrgAgentQuota(tx, params.organizationId, cap);

        const [created] = await tx
          .insert(agentSandboxes)
          .values(buildAgentSandboxInsertValues(params))
          .returning();
        if (!created) throw new Error("Failed to create agent record");
        return { agent: created, idempotent: false };
      });
    }

    // Mirrors createCodingContainerAgent: an org-scoped advisory lock + a
    // FOR UPDATE reuse guard serialize concurrent creates so a retry / SDK
    // double-call / provision flap can't strand the org with N agents (each =
    // a container + per-tenant DB + ingress).
    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, params.organizationId),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // The guard above only hands back a LIVE agent — a `stopped`/`sleeping`
      // one must be resumed/woken, not reused — so after a suspend there is
      // nothing to collapse onto and control falls through to a fresh insert.
      // Without a cap that insert is unbounded: a create→suspend→create loop
      // mints a new agent (each = a per-tenant managed DB) every iteration
      // (#11023 residual). Enforce the same per-org ceiling, still under the
      // org advisory lock.
      if (params.maxNonTerminalAgents !== undefined) {
        await assertOrgAgentQuota(tx, params.organizationId, params.maxNonTerminalAgents);
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(buildAgentSandboxInsertValues(params))
        .returning();
      if (!created) throw new Error("Failed to create agent record");
      return { agent: created, idempotent: false };
    });
  }

  async createCodingContainerAgent(params: CreateAgentParams & { dockerImage: string }): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    assertAgentExecutionTier(params.executionTier);
    const createParams: CreateAgentParams & { dockerImage: string } = {
      ...params,
      // Coding-container env carries caller secrets (tokens, provider keys) —
      // encrypt them before the row is inserted (#11332).
      environmentVars: params.environmentVars
        ? await encryptAgentEnvVarsForStorage(params.organizationId, params.environmentVars)
        : params.environmentVars,
    };

    logger.info("[agent-sandbox] Creating coding-container agent", {
      orgId: createParams.organizationId,
      name: createParams.agentName,
      image: createParams.dockerImage,
    });

    return dbWrite.transaction(async (tx) => {
      await configureElizaLifecycleTransaction(tx);
      // Acquire the per-ORG agent-create lock BEFORE the per-image lock. The
      // image lock alone (keyed on the exact docker_image) does NOT serialize
      // two concurrent creates for DIFFERENT images against one org, so the
      // quota count below would not be atomic without the org lock. Taking the
      // org lock first everywhere gives a strict org→image lock order, so this
      // path and createAgent (org lock only) can never deadlock. (#11023)
      await tx.execute(elizaAgentCreateAdvisoryLockSql(createParams.organizationId));
      await tx.execute(
        elizaCodingContainerImageAdvisoryLockSql(
          createParams.organizationId,
          createParams.dockerImage,
        ),
      );

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, createParams.organizationId),
            eq(agentSandboxes.docker_image, createParams.dockerImage),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // Per-org quota (#11023): the per-image reuse guard collapses only
      // same-image retries, so a distinct-image loop (`:v1`/`:v2`/`@sha256…`
      // under an allowlisted namespace) would otherwise mint unbounded custom
      // containers on the shared fleet. #11042 capped createAgent's plain-insert
      // branch but not this route; enforce the SAME per-org ceiling here, under
      // the org lock so the count→insert is atomic against concurrent creates.
      // Trusted internal callers pass no cap and stay uncapped.
      if (createParams.maxNonTerminalAgents !== undefined) {
        await assertOrgAgentQuota(
          tx,
          createParams.organizationId,
          createParams.maxNonTerminalAgents,
        );
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(buildAgentSandboxInsertValues(createParams))
        .returning();
      if (!created) throw new Error("Failed to create coding-container agent record");
      return { agent: created, idempotent: false };
    });
  }

  async getAgent(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
  }

  async getAgentById(agentId: string) {
    return agentSandboxesRepository.findById(agentId);
  }

  async updateAgentEnvironment(
    agentId: string,
    orgId: string,
    environmentVars: Record<string, string>,
  ): Promise<AgentSandbox | undefined> {
    // BYO secrets (provider API keys, tokens) are encrypted at rest (#11332);
    // the materialization paths (provision / fleet upgrade / runtime
    // bootstrap) decrypt, so the running agent still sees real values.
    const encryptedEnvironment = await encryptAgentEnvVarsForStorage(orgId, environmentVars);
    const updated = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return undefined;
      if (rec.deletion_attempt_id) {
        throw new ApiError(409, "session_not_ready", "Agent deletion is in progress");
      }
      const [row] = await tx
        .update(agentSandboxes)
        .set({
          environment_vars: encryptedEnvironment,
          environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
          warm_claim_credential_state: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN 'pending'
              ELSE ${agentSandboxes.warm_claim_credential_state}
            END
          `,
          warm_claim_key_fingerprint: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_key_fingerprint}
            END
          `,
          warm_claim_attested_at: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_attested_at}
            END
          `,
          warm_claim_attested_environment_revision: sql`
            CASE
              WHEN ${agentSandboxes.claimed_at} IS NOT NULL
                AND ${agentSandboxes.warm_claim_credential_state} = 'ready'
              THEN NULL
              ELSE ${agentSandboxes.warm_claim_attested_environment_revision}
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
            sql`COALESCE(${agentSandboxes.warm_claim_credential_state}, '') NOT IN ('pending', 'attested')`,
          ),
        )
        .returning();
      return row;
    });
    if (updated?.claimed_at && updated.warm_claim_credential_state === "pending") {
      const { provisioningJobService } = await import("./provisioning-jobs");
      await provisioningJobService.enqueueAgentRestartOnce({
        agentId: updated.id,
        organizationId: updated.organization_id,
        userId: updated.user_id,
      });
    }
    return updated;
  }

  /**
   * Rotate the generic managed-launch credential and persist its environment
   * under the same per-agent lifecycle lock used by delete/restart/upgrade.
   * Key minting stays inside that ownership window so a delete cannot revoke
   * and then lose to a late mint.
   *
   * The rotation runs on the launch transaction's own connection. It used to
   * reach for the global write pool instead, which made every launch hold one
   * connection while asking for a second. The Worker pool is sized `max: 1`
   * (`db/client.ts` `createPgPool`), so the request waited on the connection it
   * was itself holding: a guaranteed self-deadlock, resolved only by
   * `connectionTimeoutMillis` (30s) and returned as a 500. No concurrency was
   * required — every managed launch hit it. Sharing the connection also makes
   * the rotation atomic with the environment write, so an unwind restores the
   * previous key rather than needing a compensating revoke that could itself
   * fail.
   */
  async prepareManagedLaunchEnvironment(params: {
    agentId: string;
    organizationId: string;
    userId: string;
  }): Promise<
    | {
        sandbox: AgentSandbox;
        environment: ManagedElizaEnvironmentResult;
      }
    | undefined
  > {
    let committed:
      | { sandbox: AgentSandbox; environment: ManagedElizaEnvironmentResult }
      | undefined;
    try {
      committed = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, params.agentId, params.organizationId);
        const rec = await this.getAgentForLifecycleMutation(
          tx,
          params.agentId,
          params.organizationId,
        );
        if (!rec) return undefined;
        const tierRejection = containerBackedServiceRejection(rec, "credential");
        if (tierRejection) throw new Error(tierRejection);
        if (rec.deletion_attempt_id || rec.claimed_at) return undefined;

        const environment = await prepareManagedElizaSharedEnvironment({
          existingEnv: rec.environment_vars,
          organizationId: params.organizationId,
          userId: params.userId,
          agentSandboxId: rec.id,
          tx,
        });
        if (!environment.changed) {
          return { sandbox: rec, environment };
        }

        const [updated] = await tx
          .update(agentSandboxes)
          .set({
            environment_vars: environment.environmentVars,
            environment_revision: sql`${agentSandboxes.environment_revision} + 1`,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(agentSandboxes.id, rec.id),
              eq(agentSandboxes.organization_id, rec.organization_id),
              eq(agentSandboxes.environment_revision, rec.environment_revision),
              eq(agentSandboxes.lifecycle_revision, rec.lifecycle_revision),
              inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
              sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
              sql`${agentSandboxes.claimed_at} IS NULL`,
            ),
          )
          .returning();
        // Losing the ownership CAS must unwind the credential rotation with it.
        // Returning here would COMMIT a key swap the stored environment never
        // references, leaving the agent booting with a deleted key; throwing
        // rolls both back together.
        if (!updated) throw new ManagedLaunchOwnershipLost();
        return { sandbox: updated, environment };
      });
    } catch (error) {
      // error-policy:J4 user-facing degrade — only this path's own CAS-loss
      // signal becomes the documented "not prepared" result; the transaction
      // has already rolled the rotation back. Every other failure propagates.
      if (error instanceof ManagedLaunchOwnershipLost) return undefined;
      throw error;
    }

    // The rotation is durable only now. The invalidation inside the
    // transaction ran while the revoked rows were still visible to other
    // connections, so a request from the still-running container could have
    // re-cached one POSITIVELY for the full validation TTL. Repeat it here,
    // confirmed, before the caller shuts the container down or returns the
    // replacement credential — and sweep in every OUTSTANDING carrier parked
    // by an earlier attempt whose confirmation failed, so no code path can
    // finish while a superseded hash silently keeps authorizing.
    if (committed) {
      const toConfirm = [
        ...new Set([
          ...committed.environment.revokedKeyHashes,
          ...(await apiKeysService.collectOutstandingRevokedKeyHashes(params.agentId)),
        ]),
      ];
      if (toConfirm.length === 0) return committed;
      try {
        await apiKeysService.confirmRevocationAfterCommit(toConfirm);
        // Confirmed clear everywhere — reap EXACTLY the carriers this attempt
        // confirmed; a concurrent rotation's unconfirmed carrier stays parked.
        await apiKeysService.purgeConfirmedRevokedAgentKeys(params.agentId, toConfirm);
      } catch (cause) {
        // error-policy:J2 context-adding rethrow — there is no later pass that
        // could clear a re-cached entry, so an unconfirmed invalidation must
        // stop the launch rather than hand back a rotated credential while the
        // revoked one may still authenticate. The DB rotation is already
        // committed; the caller is being told the launch is PARTIALLY applied
        // and a retry re-rotates from the new state.
        throw new ElizaError(
          "Managed launch rotated the agent credential but could not confirm revocation of the previous one",
          {
            code: "MANAGED_LAUNCH_REVOCATION_UNCONFIRMED",
            cause,
            context: {
              agentId: params.agentId,
              organizationId: params.organizationId,
              revokedKeyCount: toConfirm.length,
              committed: true,
            },
            severity: "fatal",
          },
        );
      }
    }
    return committed;
  }

  /**
   * Edit an agent's profile in place — its display name and/or its persisted
   * `agent_config` (system prompt / character fields). `agentConfig` is merged
   * into the existing config so a partial edit never drops other keys. A name
   * edit applies immediately (cloud agent name + shared-runtime character);
   * dedicated-container config edits take effect on the next provision/restart.
   */
  async updateAgentProfile(
    agentId: string,
    orgId: string,
    input: { agentName?: string; agentConfig?: Record<string, unknown> },
  ): Promise<AgentSandbox | undefined> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return undefined;
      if (rec.deletion_attempt_id) {
        throw new ApiError(409, "session_not_ready", "Agent deletion is in progress");
      }

      const updates: { agent_name?: string; agent_config?: Record<string, unknown> } = {};
      if (input.agentName !== undefined) updates.agent_name = input.agentName;
      if (input.agentConfig !== undefined || input.agentName !== undefined) {
        const existing =
          rec.agent_config &&
          typeof rec.agent_config === "object" &&
          !Array.isArray(rec.agent_config)
            ? (rec.agent_config as Record<string, unknown>)
            : {};
        const [authority] = await tx
          .select()
          .from(personalDedicatedUpgradeAuthorities)
          .where(
            and(
              eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, rec.id),
              eq(personalDedicatedUpgradeAuthorities.organization_id, orgId),
            ),
          )
          .limit(1);
        const reservedProjection: Record<string, unknown> = {};
        if (authority) {
          if (authority.schema_version !== 1 || authority.user_id !== rec.user_id) {
            throw new ElizaError("Personal Dedicated authority is inconsistent", {
              code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
              context: { agentId, organizationId: orgId },
            });
          }
          reservedProjection[AGENT_UPGRADED_FROM_KEY] = authority.source_agent_id;
          if (authority.cutover_token !== null) {
            const cutover = readPersonalElizaCutover({
              [AGENT_PERSONAL_CUTOVER_KEY]: {
                mode: "dedicated",
                sourceAgentId: authority.source_agent_id,
                conversationId: authority.source_agent_id,
                cutoverToken: authority.cutover_token,
                sharedMessageCount: authority.shared_message_count,
                sharedScheduledTaskCount: authority.shared_scheduled_task_count,
                sharedTodoCount: authority.shared_todo_count,
                sharedTodoMutationCount: authority.shared_todo_mutation_count,
                sharedTodoDigest: authority.shared_todo_digest,
                activatedAt: authority.cutover_activated_at?.toISOString(),
              },
            });
            if (!cutover) {
              throw new ElizaError("Personal Dedicated cutover authority is malformed", {
                code: "PERSONAL_DEDICATED_AUTHORITY_INVALID",
                context: { agentId, organizationId: orgId },
              });
            }
            reservedProjection[AGENT_PERSONAL_CUTOVER_KEY] = cutover;
          }
        }
        // Only adoption state is untrusted on an existing row. Other internal
        // bindings are server-owned and must survive ordinary profile edits;
        // the broad input sanitizer still prevents callers from replacing any
        // internal key.
        updates.agent_config = {
          ...stripPersonalDedicatedAuthorityConfigKeys(existing),
          ...(input.agentConfig ? stripReservedElizaConfigKeys(input.agentConfig) : {}),
          ...reservedProjection,
        };
      }
      if (Object.keys(updates).length === 0) return rec;

      const [updated] = await tx
        .update(agentSandboxes)
        .set({ ...updates, updated_at: new Date() })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning();
      return updated;
    });
  }

  async getAgentForWrite(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
  }

  async listAgents(orgId: string) {
    return agentSandboxesRepository.listByOrganization(orgId);
  }

  async deleteAgent(
    agentId: string,
    orgId: string,
    options: {
      authorization?: DeleteAuthorization;
      stateLossAcknowledged?: boolean;
    } = {},
  ): Promise<DeleteAgentResult> {
    // Phase 0 — fail-closed pre-deletion capture (#18517), the discipline
    // shutdown() applies before stopping: a live dedicated container is never
    // destroyed without a current backup. Two delete surfaces reach here. The
    // synchronous compat path sees the row still `running`, so a refusal
    // leaves it untouched with nothing for the reconciler to re-arm. The
    // primary v1 path stamps `deletion_pending` at enqueue time and calls
    // this later from the job worker — there the container is still live with
    // its bridge intact, the capture happens before any teardown, and a
    // refusal leaves a recoverable tombstone the next attempt retries.
    let captureWaiverAlreadyPersisted = false;
    let captureWaiverGeneration: {
      bridgeUrl: string;
      environmentRevision: number;
      sandboxId: string | null;
    } | null = null;
    let preDeleteBackupCandidate: {
      id: string;
      deletionAttemptId: string;
    } | null = null;
    let preDeleteSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;
    let preDeleteCaptureAuthority: SnapshotAuthorityCapture | null = null;
    const snapshotSource = await this.getAgentForWrite(agentId, orgId);
    // An unauthorized delete of a still-`running` row is refused by
    // prepareAgentDelete no matter what happens here, so it skips the capture
    // and keeps its original "suspend it before deletion" refusal — a capture
    // outage must not change which refusal an unauthorized caller sees, nor
    // cost a doomed HTTP round-trip.
    //
    // A `deletion_pending` row is NOT that case: the enqueue already carried
    // the authorization when it stamped the status, and the re-enqueue of a
    // stuck deletion (ProvisioningJobService.reEnqueueFailedDeletions) passes
    // none. Gating phase 0 on `options.authorization` therefore left exactly
    // those jobs arriving at prepareAgentDelete with `snapshot: null` against
    // a capture-requiring row — refused as "lifecycle generation moved" on
    // every attempt, deadlocking the stuck-delete population this guard
    // exists to protect.
    const captureSkippedForUnauthorizedRunning =
      !options.authorization && snapshotSource?.status === "running";
    const captureSkippedForAccountDeletion = options.authorization === "account_deletion";
    if (
      !captureSkippedForUnauthorizedRunning &&
      !captureSkippedForAccountDeletion &&
      this.requiresPreDeleteCapture(snapshotSource)
    ) {
      // A deletion retry whose earlier attempt already captured (or recorded
      // the image's supported no-snapshot response) must not contact a bridge
      // the teardown may already have killed. Both candidates are revalidated
      // under the lifecycle lock before they authorize the delete.
      const priorBackup =
        snapshotSource.deletion_started_at !== null && snapshotSource.deletion_attempt_id !== null
          ? await agentSandboxesRepository.getLatestBackupByType(agentId, "pre-delete")
          : undefined;
      if (
        priorBackup &&
        snapshotSource.deletion_started_at !== null &&
        snapshotSource.deletion_attempt_id !== null &&
        priorBackup.created_at >= snapshotSource.deletion_started_at
      ) {
        preDeleteBackupCandidate = {
          id: priorBackup.id,
          deletionAttemptId: snapshotSource.deletion_attempt_id,
        };
      } else if (this.hasCurrentPreDeleteCaptureWaiver(snapshotSource)) {
        captureWaiverAlreadyPersisted = true;
      } else if (!snapshotSource.bridge_url) {
        logger.error("[agent-sandbox] Delete refused: data-bearing container has no bridge", {
          agentId,
          status: snapshotSource.status,
        });
        return {
          success: false,
          error:
            "Refusing to delete without a current backup: the agent's container has no reachable bridge to capture from",
        };
      } else {
        preDeleteCaptureAuthority = snapshotSource;
        try {
          preDeleteSnapshot = await this.fetchSnapshotState(snapshotSource);
        } catch (error) {
          // error-policy:J1 the delete command boundary translates capture
          // failures into an explicit refusal; a transient capture failure is
          // marked retryable so the delete job re-attempts without burning
          // its budget (shutdown's rule for the identical signal), and only
          // an image that cannot snapshot by construction proceeds.
          const message = error instanceof Error ? error.message : String(error);
          if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
            captureWaiverGeneration = {
              bridgeUrl: snapshotSource.bridge_url,
              environmentRevision: snapshotSource.environment_revision,
              sandboxId: snapshotSource.sandbox_id,
            };
            logger.warn(
              "[agent-sandbox] Delete proceeding without capture: image has no snapshot endpoint",
              { agentId },
            );
          } else if (options.stateLossAcknowledged) {
            // Explicit customer/operator recovery path: a capture failure can
            // otherwise make a data-bearing agent undeletable forever. Bind the
            // waiver to this exact deletion/container generation and persist it
            // under the lifecycle lock before any destructive work begins.
            captureWaiverGeneration = {
              bridgeUrl: snapshotSource.bridge_url,
              environmentRevision: snapshotSource.environment_revision,
              sandboxId: snapshotSource.sandbox_id,
            };
            logger.error(
              "[agent-sandbox] Delete proceeding WITHOUT pre-deletion capture: state loss acknowledged",
              { agentId, captureError: message },
            );
          } else if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
            logger.warn(
              "[agent-sandbox] Delete deferred: pre-deletion capture transiently unavailable, will retry",
              { agentId },
            );
            return {
              success: false,
              retryable: true,
              error: `Refusing to delete without a current backup: ${message}`,
            };
          } else {
            logger.error("[agent-sandbox] Delete refused: pre-deletion capture failed", {
              agentId,
              error: message,
            });
            return {
              success: false,
              error: `Refusing to delete without a current backup: ${message}`,
            };
          }
        }
      }
    }

    // Phase 1 — short transaction: take the lifecycle lock, validate
    // preconditions, and capture the fields needed for teardown. We deliberately
    // do NOT run the container teardown inside this transaction:
    // provider.stopForDeletion()
    // can hang on an early SSH connect / provider init, and holding the row lock
    // + write transaction + a pooled connection for the full teardown cap (up to
    // SANDBOX_DELETE_STOP_TIMEOUT_MS) would wedge concurrent lifecycle ops on the
    // same agent/org. The lock + transaction are released the moment this returns.
    const precheck = await this.prepareAgentDelete(agentId, orgId, options.authorization, {
      snapshot: preDeleteSnapshot,
      captureAuthority: preDeleteCaptureAuthority,
      captureWaiverGeneration,
      captureWaiverAlreadyPersisted,
      existingBackup: preDeleteBackupCandidate,
    });

    if (!precheck.ok) {
      return { success: false, error: precheck.error };
    }
    let deletionOwnership = precheck;

    logger.info("[agent-sandbox] Deleting agent", {
      agentId,
      sandbox: precheck.sandboxId,
    });

    // Phase 2 — bounded container + VPN teardown, run OUTSIDE the write-lock /
    // transaction. provider.stopForDeletion() removes the container and cleans
    // up the headscale route (each internally bounded), but an EARLY hang (SSH connect /
    // provider init) was unbounded — a single stuck node could hang this delete
    // past the 300s job watchdog and wedge the entire provisioning worker
    // (fail-closed on every provision).
    //
    // Provider errors are captured as values so `withTimeout` rejects ONLY on a
    // genuine hang. A real stop failure on a REACHABLE node still escalates
    // (returns failure / retry), since the container may still be running; an
    // "already gone" failure is ignorable and we proceed.
    // Whether the container is PROVEN not running. A bounded timeout completes the
    // delete but abandons a container that may still be running, so it is not
    // proof — releasing its slot would let the scheduler pack new containers
    // onto a box still running the old ones.
    let containerProvenNotRunning = true;
    let reconciliationReason: string | null = null;

    if (precheck.sandboxId) {
      const sandboxId = precheck.sandboxId;
      const stop = await this.runBoundedSandboxStop(sandboxId);

      if (stop.kind === "stop-timed-out") {
        const errorMessage = stop.error instanceof Error ? stop.error.message : String(stop.error);
        // The container may still be running, so this generation keeps its
        // node slot. The orphan reconciler releases it once it proves the
        // container is actually not running (#17185).
        containerProvenNotRunning = false;
        reconciliationReason = `container stop timed out: ${errorMessage}`;
        logger.warn(
          "[agent-sandbox] Stop during delete timed out; completing delete and ABANDONING the " +
            "container while retaining its capacity until reconciliation",
          { sandboxId, status: precheck.status, error: errorMessage },
        );
      } else if (stop.kind === "not-running-unresolved") {
        containerProvenNotRunning = false;
        reconciliationReason = stop.reason;
        logger.warn(
          "[agent-sandbox] Provider could not prove the container stopped during delete; " +
            "retaining its capacity until reconciliation",
          { sandboxId, status: precheck.status, reason: stop.reason },
        );
      } else if (stop.kind === "stop-failed") {
        const errorMessage = stop.error instanceof Error ? stop.error.message : String(stop.error);
        if (this.isIgnorableSandboxStopError(stop.error)) {
          logger.info("[agent-sandbox] Sandbox already absent during delete cleanup", {
            sandboxId,
            status: precheck.status,
            error: errorMessage,
          });
        } else {
          logger.warn("[agent-sandbox] Stop failed during delete", {
            sandboxId,
            status: precheck.status,
            error: errorMessage,
          });
          return { success: false, error: "Failed to delete sandbox" };
        }
      }
    }

    // The container is proven not running, so this generation hands its node slot back
    // — and does so BEFORE the steps that can still fail below (credential
    // revocation, the row-delete CAS, job-status persistence). Those failures
    // re-run this whole path; the CAS is what makes the second run a no-op
    // instead of a second decrement that frees a live sibling's slot (#17185).
    //
    // Unresolved teardown deliberately skips the release and keeps ownership.
    // A reachable stop failure returns above; a timeout or unreachable node
    // completes deletion but leaves the slot counted until the orphan
    // reconciler proves the container absent.
    if (containerProvenNotRunning && precheck.nodeId) {
      const release = await agentSandboxesRepository.tryReleaseDeletionAllocationForCommit(
        agentId,
        orgId,
        precheck.deletionAttemptId,
        precheck.nodeId,
        precheck.lifecycleRevision,
      );
      const outcome = release.outcome;
      if (release.lifecycleRevision !== null) {
        deletionOwnership = {
          ...deletionOwnership,
          lifecycleRevision: release.lifecycleRevision,
        };
      }
      // `not-owned` is the expected retry outcome and stays at info; only a
      // counter that failed to move while ownership WAS ours is an accounting
      // problem worth an operator's attention.
      const context = {
        outcome,
        agentId,
        nodeId: precheck.nodeId,
        deletionAttemptId: precheck.deletionAttemptId,
      };
      if (outcome === "counter-unchanged") {
        logger.warn("[agent-sandbox] Deletion node-slot release did not move the counter", context);
      } else {
        logger.info("[agent-sandbox] Deletion node-slot release", context);
      }
    }

    // Revoke both credential owners before deleting the row. The source-pool
    // id is durable recovery state for a claimed handoff; deleting first would
    // make a transient authoritative revocation failure impossible to retry.
    const credentialOwners = new Set(
      [agentId, precheck.sourcePoolId].filter((id): id is string => Boolean(id)),
    );
    for (const credentialOwnerId of credentialOwners) {
      await apiKeysService.revokeForAgent(credentialOwnerId);
    }

    // The ownership flag lives on the sandbox row, so unresolved teardown must
    // preserve that row as a terminal tombstone. The orphan reaper consumes the
    // flag after removing the immutable container ID; a later delete retry then
    // observes explicit absence and removes the tombstone. Deleting the row here
    // would erase the only proof that the node counter still includes this slot.
    let result: DeleteAgentResult;
    if (containerProvenNotRunning) {
      result = await this.commitAgentRowDelete(agentId, orgId, deletionOwnership);
    } else {
      if (!reconciliationReason) {
        throw new Error("Unresolved deletion is missing its reconciliation reason");
      }
      result = await this.commitAgentReconciliationPending(
        agentId,
        orgId,
        deletionOwnership,
        reconciliationReason,
      );
    }

    if (result.success && result.rowDeleted) {
      // Best-effort: drop the shared-runtime (Tier-0) conversation history for
      // this agent. That table is deliberately decoupled from the sandbox row
      // (no FK cascade), so the per-channel history rows would otherwise be
      // orphaned forever after the agent is gone. A failure here leaves stale
      // rows but never un-deletes the (already gone) sandbox.
      //
      // The channel list is recovered BEFORE the Postgres delete so it can also
      // drive the Durable Object purge below — each room's DO is named
      // `${agentId}:${channelId}` and keeps its own copy of the live
      // conversation window; without this step a deleted agent's conversation
      // content would persist indefinitely in DO storage (data-retention /
      // privacy gap, unbounded namespace growth).
      let channelIds: string[] = [];
      try {
        channelIds = await sharedRuntimeHistoryRepository.listChannelsByAgent(agentId);
        const removed = await sharedRuntimeHistoryRepository.deleteByAgent(agentId);
        if (removed > 0) {
          logger.info("[agent-sandbox] Cleaned up shared-runtime history after delete", {
            agentId,
            channelsRemoved: removed,
          });
        }
      } catch (err) {
        // error-policy:J6 the sandbox is already gone; failed history cleanup
        // leaves stale rows for a later sweep, never un-deletes the agent.
        logger.warn("[agent-sandbox] Failed to clean up shared-runtime history", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // #17006: purge each room's SharedRuntimeConversation Durable Object.
      // The DO copy is the live source of truth for the conversation window,
      // so dropping only the Postgres mirror above would leave the deleted
      // agent's conversation content resident in DO storage indefinitely. The
      // namespace binding exists only inside a Worker request (getCloudBinding
      // returns undefined in tests/node runtimes), and the purge is
      // best-effort per room: the deletion is already committed.
      if (channelIds.length > 0) {
        const conversations = getCloudBinding<RuntimeDurableObjectNamespace>(
          "SHARED_RUNTIME_CONVERSATIONS",
        );
        if (conversations && typeof conversations.getByName === "function") {
          try {
            const purge = await purgeSharedConversationRooms(agentId, channelIds, {
              namespace: conversations,
            });
            logger.info("[agent-sandbox] Purged shared-runtime conversation objects", {
              agentId,
              rooms: channelIds.length,
              ...purge,
            });
          } catch (err) {
            // error-policy:J6 the deletion is already committed; a purge
            // failure is teardown-only and must never fail the delete.
            logger.warn("[agent-sandbox] Shared-runtime conversation purge failed", {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return result;
  }

  /** Whether this row carries a waiver for its current deletion generation. */
  private hasCurrentPreDeleteCaptureWaiver(rec: AgentSandbox): boolean {
    return (
      rec.deletion_attempt_id !== null &&
      rec.pre_delete_capture_waiver_attempt_id === rec.deletion_attempt_id &&
      rec.pre_delete_capture_waiver_environment_revision === rec.environment_revision &&
      rec.pre_delete_capture_waiver_sandbox_id === rec.sandbox_id &&
      rec.pre_delete_capture_waiver_bridge_url !== null &&
      rec.pre_delete_capture_waiver_bridge_url === rec.bridge_url
    );
  }

  /**
   * Whether deleting this row must first prove a current backup (#18517).
   * Running rows always require proof. Error/disconnected rows require it when
   * they retain a container locator. A deletion continuation with no live
   * bridge requires it unless allocation ownership proves the row was already
   * stopped; this avoids mistaking a stopped row's retained `sandbox_id` for a
   * live container while still failing closed on ambiguous legacy intents.
   */
  private requiresPreDeleteCapture(rec: AgentSandbox | null | undefined): rec is AgentSandbox {
    if (
      !rec ||
      rec.execution_tier === "shared" ||
      (rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed")
    ) {
      return false;
    }
    if (rec.status === "running") return true;
    const hasContainerLocator = Boolean(
      rec.sandbox_id || rec.node_id || rec.container_name || rec.bridge_url,
    );
    if (rec.status === "disconnected" || rec.status === "error") {
      return hasContainerLocator;
    }
    if (rec.status === "deletion_pending" || rec.status === "deletion_failed") {
      return (
        Boolean(rec.bridge_url) ||
        (rec.deletion_allocation_counted !== false && hasContainerLocator)
      );
    }
    return false;
  }

  /**
   * Phase 1 of `deleteAgent` (see there): short write transaction that takes
   * the lifecycle lock, validates delete preconditions, and captures the
   * sandbox id + status for the (out-of-transaction) teardown. Kept separate so
   * the lock/transaction is held only for these quick DB ops, never across the
   * bounded container teardown.
   */
  private async prepareAgentDelete(
    agentId: string,
    orgId: string,
    authorization?: DeleteAuthorization,
    preDeleteCapture?: {
      snapshot: {
        stateData: AgentBackupStateData;
        sizeBytes: number;
        bridgeUrl: string;
      } | null;
      captureAuthority: SnapshotAuthorityCapture | null;
      captureWaiverGeneration: {
        bridgeUrl: string;
        environmentRevision: number;
        sandboxId: string | null;
      } | null;
      captureWaiverAlreadyPersisted: boolean;
      existingBackup: {
        id: string;
        deletionAttemptId: string;
      } | null;
    },
  ): Promise<
    | {
        ok: true;
        sandboxId: string | null;
        nodeId: string | null;
        status: AgentSandbox["status"];
        sourcePoolId: string | null;
        environmentRevision: number;
        lifecycleRevision: number;
        deletionAttemptId: string;
        deletionStartedAt: Date;
        preDeleteBackupId: string | null;
      }
    | { ok: false; error: string }
  > {
    // The deletion intent this stamps includes `deletion_allocation_counted`,
    // which the provisioning worker can reach before its migration has run
    // (its deploy does not gate on migrate-db). Ensure is memoized, so the DDL
    // runs once per isolate rather than once per delete.
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { ok: false as const, error: "Agent not found" };
      if (this.getReplacementCleanupLocator(rec)) {
        return {
          ok: false as const,
          error: "Agent replacement cleanup is still pending",
        };
      }

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      const hasActiveReplacementJob = await this.hasActiveReplacementJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob || hasActiveReplacementJob) {
        return { ok: false as const, error: "Agent provisioning is in progress" };
      }
      const isSharedRuntime = rec.execution_tier === "shared";
      const isUnclaimedWarmPoolEntry =
        rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed";
      if (
        rec.status === "running" &&
        !isSharedRuntime &&
        !isUnclaimedWarmPoolEntry &&
        !authorization
      ) {
        return {
          ok: false as const,
          error: "Agent is running; suspend it before deletion",
        };
      }
      let preDeleteBackupId: string | null = null;
      let captureWaiverToPersist: {
        bridgeUrl: string;
        environmentRevision: number;
        sandboxId: string | null;
      } | null = null;
      let snapshotToPersist: {
        stateData: AgentBackupStateData;
        sizeBytes: number;
      } | null = null;
      if (authorization !== "account_deletion" && this.requiresPreDeleteCapture(rec)) {
        const existingBackup = preDeleteCapture?.existingBackup ?? null;
        if (
          existingBackup &&
          rec.deletion_attempt_id === existingBackup.deletionAttemptId &&
          rec.deletion_started_at !== null &&
          (await agentSandboxesRepository.validateAttachedPreDeleteBackupForDeletion(tx, {
            backupId: existingBackup.id,
            sandboxRecordId: rec.id,
            deletionStartedAt: rec.deletion_started_at,
          }))
        ) {
          preDeleteBackupId = existingBackup.id;
        }

        const captureWaiverIsCurrent =
          preDeleteCapture?.captureWaiverAlreadyPersisted === true &&
          this.hasCurrentPreDeleteCaptureWaiver(rec);
        if (preDeleteBackupId === null && !captureWaiverIsCurrent) {
          const waiver = preDeleteCapture?.captureWaiverGeneration ?? null;
          const captureAuthority = preDeleteCapture?.captureAuthority ?? null;
          if (waiver) {
            if (!captureAuthority || !snapshotCaptureStillCanonical(rec, captureAuthority)) {
              return {
                ok: false as const,
                error:
                  "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
              };
            }
            captureWaiverToPersist = waiver;
          } else {
            const snapshot = preDeleteCapture?.snapshot ?? null;
            // The capture must be OF THIS exact generation (shutdown's rule).
            // Reusing a bridge URL does not make replacement compute the same
            // authority; every container identity and lifecycle field stays
            // fenced through the canonical comparator.
            if (
              !snapshot ||
              !captureAuthority ||
              !snapshotCaptureStillCanonical(rec, captureAuthority) ||
              rec.bridge_url !== snapshot.bridgeUrl
            ) {
              return {
                ok: false as const,
                error:
                  "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
              };
            }
            snapshotToPersist = snapshot;
          }
        }
      }

      const deletionAttemptId = rec.deletion_attempt_id ?? crypto.randomUUID();
      const deletionStartedAt = rec.deletion_started_at ?? new Date();
      // A retry preserves the original audit timestamp while taking a fresh
      // database generation for the new teardown attempt.
      //
      // Allocation ownership rides the same rule, for the same reason: a
      // continuation must inherit the original generation's recorded answer, not
      // re-derive it from a row this deletion has already moved to
      // `deletion_pending` — which would read as "still counted" forever and free
      // a live sibling's slot on every retry (#17185).
      const [owned] = await tx
        .update(agentSandboxes)
        .set({
          status: "deletion_pending",
          deletion_attempt_id: deletionAttemptId,
          ...(rec.deletion_started_at === null ? { deletion_started_at: deletionStartedAt } : {}),
          ...(isDeletionContinuation(rec)
            ? {}
            : { deletion_allocation_counted: holdsCountedNodeSlot(rec) }),
          ...(captureWaiverToPersist
            ? {
                pre_delete_capture_waiver_attempt_id: deletionAttemptId,
                pre_delete_capture_waiver_environment_revision:
                  captureWaiverToPersist.environmentRevision,
                pre_delete_capture_waiver_sandbox_id: captureWaiverToPersist.sandboxId,
                pre_delete_capture_waiver_bridge_url: captureWaiverToPersist.bridgeUrl,
              }
            : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            sql`${agentSandboxes.replacement_cleanup_sandbox_id} IS NULL`,
          ),
        )
        .returning({
          id: agentSandboxes.id,
          deletionAttemptId: agentSandboxes.deletion_attempt_id,
          deletionStartedAt: agentSandboxes.deletion_started_at,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        });
      if (!owned) {
        return { ok: false as const, error: "Agent deletion ownership changed" };
      }
      if (!owned.deletionAttemptId || !owned.deletionStartedAt) {
        throw new Error("Agent deletion intent was not persisted");
      }

      // The retention predicate deliberately requires a pre-delete backup to
      // be no older than this deletion intent. Persist only after the intent is
      // durable in the same transaction; otherwise the backup helper stamps
      // created_at first and the freshly captured row cannot be detached at
      // commit. The backup metadata update advances lifecycle_revision, so use
      // the post-trigger revision it returns as the ownership fence.
      let lifecycleRevision = owned.lifecycleRevision;
      if (snapshotToPersist) {
        const persisted = await this.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-delete",
          snapshotToPersist.stateData,
          snapshotToPersist.sizeBytes,
        );
        preDeleteBackupId = persisted.backupId;
        lifecycleRevision = persisted.lifecycleRevision;
      }

      return {
        ok: true as const,
        sandboxId: rec.sandbox_id,
        nodeId: rec.node_id,
        status: rec.status,
        sourcePoolId: rec.warm_claim_source_pool_id,
        environmentRevision: rec.environment_revision,
        lifecycleRevision,
        deletionAttemptId: owned.deletionAttemptId,
        deletionStartedAt: owned.deletionStartedAt,
        preDeleteBackupId,
      };
    });
  }

  /**
   * Phase 3 of `deleteAgent` (see there): short write transaction that re-takes
   * the lifecycle lock, re-validates (a concurrent provision could have started
   * while the out-of-transaction teardown ran), then deletes the sandbox row.
   */
  private async commitAgentRowDelete(
    agentId: string,
    orgId: string,
    ownership: {
      sandboxId: string | null;
      environmentRevision: number;
      lifecycleRevision: number;
      deletionAttemptId: string;
      deletionStartedAt: Date;
      preDeleteBackupId: string | null;
    },
  ): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;
      if (this.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (
        rec.status !== "deletion_pending" ||
        rec.deletion_attempt_id !== ownership.deletionAttemptId ||
        rec.sandbox_id !== ownership.sandboxId ||
        rec.environment_revision !== ownership.environmentRevision ||
        rec.lifecycle_revision !== ownership.lifecycleRevision ||
        hasActiveProvisionJob
      ) {
        return {
          success: false,
          error: "Agent deletion ownership changed",
        } as const;
      }

      if (ownership.preDeleteBackupId) {
        const retained = await agentSandboxesRepository.retainPreDeleteBackupForDeletedAgent(tx, {
          backupId: ownership.preDeleteBackupId,
          sandboxRecordId: agentId,
          organizationId: orgId,
          deletionAttemptId: ownership.deletionAttemptId,
          deletionStartedAt: ownership.deletionStartedAt,
          expiresAt: new Date(Date.now() + PRE_DELETE_BACKUP_RETENTION_MS),
        });
        if (!retained) {
          throw new ElizaError("Pre-delete recovery backup ownership changed", {
            code: "PRE_DELETE_BACKUP_RETENTION_LOST",
            context: {
              agentId,
              organizationId: orgId,
              deletionAttemptId: ownership.deletionAttemptId,
              backupId: ownership.preDeleteBackupId,
            },
            severity: "fatal",
          });
        }
      }

      const [deletedSandbox] = await tx
        .delete(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "deletion_pending"),
            eq(agentSandboxes.deletion_attempt_id, ownership.deletionAttemptId),
            sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${ownership.sandboxId}`,
            eq(agentSandboxes.environment_revision, ownership.environmentRevision),
            eq(agentSandboxes.lifecycle_revision, ownership.lifecycleRevision),
          ),
        )
        .returning();

      if (!deletedSandbox) {
        // Throwing rolls back the recovery detachment above; returning a
        // structured miss would commit an orphaned backup while retaining the
        // agent row, making the next retry unable to find its capture.
        throw new ElizaError("Agent row delete lost its lifecycle ownership", {
          code: "AGENT_DELETE_COMMIT_LOST",
          context: { agentId, organizationId: orgId, ...ownership },
          severity: "ephemeral",
        });
      }
      return { success: true, rowDeleted: true, deletedSandbox } as const;
    });
  }

  /**
   * Persists unresolved deletion as a terminal tombstone without spending its
   * capacity ownership. This completes the queue attempt promptly while keeping
   * the durable row the orphan reaper and low-frequency delete retry require.
   */
  private async commitAgentReconciliationPending(
    agentId: string,
    orgId: string,
    ownership: {
      sandboxId: string | null;
      environmentRevision: number;
      lifecycleRevision: number;
      deletionAttemptId: string;
    },
    reason: string,
  ): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;
      if (this.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (
        rec.status !== "deletion_pending" ||
        rec.deletion_attempt_id !== ownership.deletionAttemptId ||
        rec.sandbox_id !== ownership.sandboxId ||
        rec.environment_revision !== ownership.environmentRevision ||
        rec.lifecycle_revision !== ownership.lifecycleRevision ||
        hasActiveProvisionJob
      ) {
        return {
          success: false,
          error: "Agent deletion ownership changed",
        } as const;
      }

      const [pendingSandbox] = await tx
        .update(agentSandboxes)
        .set({
          status: "deletion_failed",
          error_message: `Deletion is awaiting container reconciliation: ${reason}`,
          error_count: sql`${agentSandboxes.error_count} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "deletion_pending"),
            eq(agentSandboxes.deletion_attempt_id, ownership.deletionAttemptId),
            sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${ownership.sandboxId}`,
            eq(agentSandboxes.environment_revision, ownership.environmentRevision),
            eq(agentSandboxes.lifecycle_revision, ownership.lifecycleRevision),
          ),
        )
        .returning();

      return pendingSandbox
        ? ({
            success: true,
            rowDeleted: false,
            reconciliationPending: true,
            deletedSandbox: pendingSandbox,
          } as const)
        : ({ success: false, error: "Agent not found" } as const);
    });
  }

  /**
   * Reverse a queued deletion while the container is still alive (#18517).
   * `deletion_pending` used to be a one-way door: cancelling the queued
   * `agent_delete` job stranded the row, and `reEnqueueFailedDeletions`
   * re-armed a fresh delete on every sweep. Run before teardown starts, this
   * atomically cancels the queued job(s) and returns the row to `running`
   * with its deletion-intent columns cleared, so the reconciler has nothing
   * left to re-arm. Refusals leave everything untouched: an executing delete
   * (job `in_progress`) may already be tearing the container down, and a row
   * whose bridge is gone has no live workload for `running` to describe.
   */
  async cancelAgentDeletion(
    agentId: string,
    orgId: string,
  ): Promise<{ success: boolean; error?: string }> {
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => this.cancelAgentDeletionTx(tx, agentId, orgId));
  }

  /** Transaction body of {@link cancelAgentDeletion}, separated so the
   *  deterministic suite can drive it against a fake lifecycle transaction. */
  private async cancelAgentDeletionTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<{ success: boolean; error?: string }> {
    await this.lockLifecycle(tx, agentId, orgId);

    const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };
    if (rec.status !== "deletion_pending") {
      return {
        success: false,
        error: `Agent is not pending deletion (status: ${rec.status})`,
      };
    }
    const previousBillingStatus = rec.deletion_previous_billing_status;
    if (
      rec.deletion_previous_status !== "running" ||
      previousBillingStatus === null ||
      !["active", "warning", "suspended", "shutdown_pending", "exempt"].includes(
        previousBillingStatus,
      )
    ) {
      return {
        success: false,
        error: "Agent deletion does not have a reversible running-state receipt",
      };
    }
    // A running receipt plus a live bridge proves the workload still matches
    // the state being restored. Legacy deletion rows have no receipt and are
    // refused above; a missing bridge means teardown may already have begun.
    if (!rec.bridge_url) {
      return {
        success: false,
        error: "Agent container is no longer reachable; the deletion can only complete",
      };
    }
    const executing = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type = ${JOB_TYPES.AGENT_DELETE}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status = 'in_progress'
      LIMIT 1
    `);
    if (executing.rows.length > 0) {
      return { success: false, error: "Agent deletion is already executing" };
    }

    // Cancel queued (never claimed) delete jobs in the same transaction as the
    // row restore, so no window exists where a worker claims the job against a
    // row that is about to leave `deletion_pending`.
    await tx.execute(sql`
      UPDATE ${jobs}
      SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
      WHERE type = ${JOB_TYPES.AGENT_DELETE}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status = 'pending'
    `);

    // Restore the captured billing state, never a guessed healthy default. A
    // delete requested while billing was warning/suspended must not become a
    // billing bypass when it is cancelled. Clearing allocation ownership
    // withdraws the pending release-at-commit marker (#17185).
    const restored = await tx.execute<{ id: string }>(sql`
      UPDATE ${agentSandboxes}
      SET status = ${rec.deletion_previous_status},
          billing_status = ${previousBillingStatus},
          shutdown_warning_sent_at = ${rec.deletion_previous_shutdown_warning_sent_at},
          scheduled_shutdown_at = ${rec.deletion_previous_scheduled_shutdown_at},
          deletion_attempt_id = NULL,
          deletion_started_at = NULL,
          deletion_previous_status = NULL,
          deletion_previous_billing_status = NULL,
          deletion_previous_shutdown_warning_sent_at = NULL,
          deletion_previous_scheduled_shutdown_at = NULL,
          deletion_allocation_counted = NULL,
          error_count = 0,
          error_message = NULL,
          updated_at = NOW()
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
        AND status = 'deletion_pending'
        AND deletion_attempt_id IS NOT DISTINCT FROM ${rec.deletion_attempt_id}
      RETURNING id
    `);
    if (restored.rows.length !== 1) {
      return { success: false, error: "Agent deletion ownership changed" };
    }

    logger.info("[agent-sandbox] Cancelled queued deletion; agent restored to running", {
      agentId,
      orgId,
    });
    return { success: true };
  }

  /**
   * Phase 2 of `deleteAgent` (see there): the bounded container + VPN teardown.
   * Provider errors are captured as values so `withTimeout` rejects ONLY on a
   * genuine hang. The provider's tagged outcome distinguishes proven absence
   * from an unreachable workload; failures and timeouts remain distinct so the
   * deletion workflow can preserve capacity without wedging its worker.
   */
  private async runBoundedSandboxStop(
    sandboxId: string,
  ): Promise<BoundedDeletionSandboxStopResult> {
    return withTimeout(
      (async (): Promise<SandboxDeletionStopOutcome | { kind: "stop-failed"; error: unknown }> => {
        try {
          const provider = await this.getProvider();
          return await provider.stopForDeletion(sandboxId);
        } catch (error) {
          // error-policy:J1 provider boundary translation — deletion records the
          // exact stop failure so the outer workflow can report a structured outcome.
          return { kind: "stop-failed", error };
        }
      })(),
      SANDBOX_DELETE_STOP_TIMEOUT_MS,
      `agent-delete stop ${sandboxId}`,
    ).catch(
      // error-policy:J1 timeout boundary translation — the deletion workflow
      // distinguishes a bounded timeout from a completed provider failure.
      (error: unknown) => ({ kind: "stop-timed-out" as const, error }),
    );
  }

  /**
   * Replacement teardown is stricter than deletion: it may not abandon an
   * unreachable workload because a second container would produce two live
   * agents when the old node recovers. Providers must positively implement the
   * absence-proof boundary; missing support, errors, and timeouts all preserve
   * the database fence and block replacement.
   */
  private async runBoundedSandboxStopForReplacement(
    sandboxId: string,
  ): Promise<BoundedSandboxStopResult> {
    return withTimeout(
      (async (): Promise<null | { error: unknown }> => {
        try {
          const provider = await this.getProvider();
          if (!provider.stopForReplacement) {
            throw new Error("Sandbox provider cannot prove workload absence before replacement");
          }
          await provider.stopForReplacement(sandboxId);
          return null;
        } catch (error) {
          // error-policy:J1 provider boundary translation — replacement remains
          // fenced until the structured stop failure is handled by its caller.
          return { error };
        }
      })(),
      SANDBOX_DELETE_STOP_TIMEOUT_MS,
      `agent-replacement stop ${sandboxId}`,
    ).catch(
      // error-policy:J1 timeout boundary translation — an unproven replacement
      // stop is an explicit timed-out failure, never inferred absence.
      (error: unknown) => ({ error, timedOut: true as const }),
    );
  }

  /**
   * Async-path counterpart to `deleteAgent`, invoked by the provisioning
   * worker daemon when it picks up an `agent_delete` job. Returns a
   * structured outcome the daemon stores in the job result so observers can
   * tell apart "container survived stop" (ops needed) from "row delete
   * failed" (probably retried by next attempt).
   *
   * Wraps `deleteAgent` so the SSH/DB sequence stays in one place,
   * but maps the return shape to what the queue handler expects and
   * tracks whether the container actually went down before the row was
   * removed. Unresolved teardown is terminal for this queue attempt but keeps a
   * reconciliation tombstone, so `rowDeleted` remains explicit in the result.
   */
  async executeDeletion(
    agentId: string,
    orgId: string,
    authorization?: DeleteAuthorization,
    stateLossAcknowledged?: boolean,
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    rowDeleted: boolean;
    error?: string;
    retryable?: true;
  }> {
    const result = await this.deleteAgent(agentId, orgId, {
      authorization,
      stateLossAcknowledged,
    });
    if (!result.success) {
      // If the row is already gone, treat as success. This covers the retry
      // case where a prior attempt deleted the row but failed before updating
      // the job status to "completed", causing the runner to retry.
      if (result.error === "Agent not found") {
        return { success: true, containerStopped: true, rowDeleted: true };
      }
      return {
        success: false,
        containerStopped: false,
        rowDeleted: false,
        error: result.error,
        retryable: result.retryable,
      };
    }

    // Character deletion used to live in the HTTP DELETE handler. Now that
    // delete is async via the queue, the daemon owns this step so orphan
    // characters do not pile up when the deletion completes outside of an
    // HTTP request context. Best-effort: a failure here leaves an orphan
    // character but does not reverse the agent's logical deletion.
    //
    // Only once the sandbox row is actually gone. On the `deletion_failed`
    // tombstone path the row survives for the recovery sweep, and
    // `agent_sandboxes.character_id` is `onDelete: "set null"` — so deleting
    // the character here would strip the tombstone's identity while it is
    // still visible as an agent, leaving the sweep nothing to reconcile
    // against. Mirrors the shared-runtime history drop above, which already
    // gates on `result.rowDeleted`.
    const characterId = result.deletedSandbox.character_id;
    if (
      result.rowDeleted &&
      characterId &&
      !reusesExistingElizaCharacter(result.deletedSandbox.agent_config)
    ) {
      try {
        await userCharactersRepository.delete(characterId);
        logger.info("[agent-sandbox] Cleaned up linked character after delete", {
          agentId,
          characterId,
        });
      } catch (charErr) {
        logger.warn("[agent-sandbox] Linked character cleanup failed after delete", {
          agentId,
          characterId,
          error: charErr instanceof Error ? charErr.message : String(charErr),
        });
      }
    }

    return {
      success: true,
      containerStopped: result.rowDeleted,
      rowDeleted: result.rowDeleted,
    };
  }

  // Provision

  /**
   * `restoreOverride` narrows step 5's backup restore for callers that have
   * already decided the restore source: `executeWake` (#15603 B6) and manual
   * `restore()`. `from-backup` restores a specific validated backup and NEVER
   * degrades an unrecoverable restore error to a fresh boot; manual restore also
   * requires the endpoint, while wake retains its custom-image 404 compatibility
   * skip. `fresh-boot` skips restore after explicit data-loss consent. Omitted:
   * latest-backup auto-restore with the designed unrecoverable-snapshot degrade.
   */
  async provision(
    agentId: string,
    orgId: string,
    restoreOverride?: ProvisionRestoreOverride,
  ): Promise<ProvisionResult> {
    let reviewedRestore: PreparedReviewedProvisionRestore | undefined;
    if (restoreOverride?.kind === "from-reviewed-backup") {
      try {
        reviewedRestore = await assertReviewedProvisionRestoreAuthority(agentId, restoreOverride);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Reviewed backup authority changed",
        };
      }
    } else if (restoreOverride?.kind === "reviewed-fresh-boot") {
      try {
        await assertReviewedFreshBootAuthority(agentId, restoreOverride);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Reviewed fresh-boot authority changed",
        };
      }
    }
    if (
      restoreOverride?.kind === "from-reviewed-backup" ||
      restoreOverride?.kind === "reviewed-fresh-boot"
    ) {
      await this.testHooks?.afterReviewedRestorePreflight?.();
    }
    const expectedAdmission =
      restoreOverride?.kind === "from-backup" && restoreOverride.requireRestoreEndpoint
        ? restoreOverride.expectedAdmission
        : undefined;
    let rec: AgentSandbox;
    let previousStatus: AgentSandboxStatus;

    if (expectedAdmission) {
      if (expectedAdmission.id !== agentId || expectedAdmission.organization_id !== orgId) {
        return { success: false, error: RESTORE_AUTHORITY_CHANGED };
      }
      // Manual stopped restore selected and hydrated a specific backup from this
      // exact generation. Admission must therefore be the first lifecycle
      // action: a replica re-read, cleanup preparation, or generic running-row
      // reuse could otherwise mutate/report a different generation while
      // claiming that the selected backup was applied.
      const lock =
        await agentSandboxesRepository.trySetProvisioningFromRestoreCapture(expectedAdmission);
      if (!lock) {
        return { success: false, error: RESTORE_AUTHORITY_CHANGED };
      }
      rec = lock;
      // Preserve the captured pre-CAS state. The returned row is already
      // `provisioning`; using that value would incorrectly re-probe a retained
      // stopped handle instead of creating the restore replacement.
      previousStatus = expectedAdmission.status;
    } else {
      let candidate = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
      if (!candidate) return { success: false, error: "Agent not found" } as ProvisionResult;
      const initialTierRejection = rejectNonContainerBackedProvision(candidate);
      if (initialTierRejection) return initialTierRejection;
      if (candidate.claimed_at && candidate.warm_claim_credential_state === "failed") {
        const retryPreparation = await this.retireFailedWarmClaimForRetry(agentId, orgId);
        if (!retryPreparation.success) {
          return {
            success: false,
            sandboxRecord: candidate,
            error: retryPreparation.error,
          };
        }
        candidate = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
        if (!candidate) return { success: false, error: "Agent not found" } as ProvisionResult;
        const retryTierRejection = rejectNonContainerBackedProvision(candidate);
        if (retryTierRejection) return retryTierRejection;
      }
      if (this.getReplacementCleanupLocator(candidate)) {
        try {
          await this.retirePersistedReplacementCleanup(agentId, orgId);
        } catch (error) {
          // error-policy:J1 provisioning boundary translation — unresolved cleanup
          // becomes an explicit retryable failure while the durable fence remains.
          return {
            success: false,
            retryable: true,
            sandboxRecord: candidate,
            error: `Replacement cleanup is still pending: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        candidate = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
        if (!candidate) return { success: false, error: "Agent not found" } as ProvisionResult;
        const cleanupTierRejection = rejectNonContainerBackedProvision(candidate);
        if (cleanupTierRejection) return cleanupTierRejection;
      }

      previousStatus = candidate.status;
      const lock = await agentSandboxesRepository.trySetProvisioning(candidate.id);
      if (!lock) {
        if (candidate.status === "running" && candidate.bridge_url && candidate.health_url) {
          if (isExplicitBackupRestore(restoreOverride)) {
            return {
              success: false,
              sandboxRecord: candidate,
              error: RESTORE_AUTHORITY_CHANGED,
            };
          }
          return {
            success: true,
            sandboxRecord: candidate,
            bridgeUrl: candidate.bridge_url,
            healthUrl: candidate.health_url,
          };
        }
        return {
          success: false,
          sandboxRecord: candidate,
          error: "Agent is already being provisioned",
        };
      }
      rec = lock;
    }

    let reviewedAdmissionFence: ReviewedProvisionAdmissionFence | undefined;
    if (
      restoreOverride?.kind === "from-reviewed-backup" ||
      restoreOverride?.kind === "reviewed-fresh-boot"
    ) {
      try {
        reviewedAdmissionFence = await acquireReviewedProvisionAdmissionFence(
          rec.id,
          rec.organization_id,
          restoreOverride,
        );
        reviewedRestore = reviewedAdmissionFence.reviewedRestore;
        await this.testHooks?.afterReviewedRestoreFence?.();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Reviewed restore authority changed";
        if (reviewedAdmissionFence) {
          await releaseReviewedProvisionAdmissionFence(reviewedAdmissionFence);
          reviewedAdmissionFence = undefined;
        }
        await this.markError(rec, message);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: message,
        };
      }
    }

    // biome-ignore format: keep the existing provision body stable while this guard owns fence cleanup.
    try {
    // 1. Database
    let dbUri = rec.database_uri;
    if (rec.database_status !== "ready" || !dbUri) {
      const db = await this.provisionAgentDatabase(rec);
      if (!db.success) {
        await this.markError(rec, `Database provisioning failed: ${db.error}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: db.error ?? "Unknown database error",
        };
      }
      dbUri = db.connectionUri!;
      // DB assignment updates the row but doesn't return the full record; re-fetch to avoid stale data
      const refreshed = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
      if (refreshed) {
        rec = refreshed;
      }
    }

    const recoveringPendingWarmClaim =
      rec.claimed_at !== null &&
      (rec.warm_claim_credential_state === "pending" ||
        rec.warm_claim_credential_state === "attested");
    const isWarmPoolProvision =
      rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed";
    const containerLaunch = resolveSandboxContainerLaunchConfig(rec.agent_config);

    // Every claimed row carries the exact managed key owned by its durable
    // handoff fence. Generic environment preparation revokes that key before
    // writing the replacement, so it is reserved for cold-created rows; warm
    // claims reuse their persisted environment through restart and attestation.
    if (!rec.claimed_at) {
      const managedEnvironment = await prepareManagedElizaEnvironment({
        existingEnv: (rec.environment_vars as Record<string, string>) ?? {},
        organizationId: rec.organization_id,
        userId: rec.user_id,
        sandboxId: agentId,
      });
      if (managedEnvironment.changed) {
        const updatedEnvRecord = await agentSandboxesRepository.update(rec.id, {
          environment_vars: managedEnvironment.environmentVars,
        });
        if (updatedEnvRecord) {
          rec = updatedEnvRecord;
        } else {
          rec = {
            ...rec,
            environment_vars: managedEnvironment.environmentVars,
          };
        }
      }
    }

    // 2-5. Sandbox creation + DB persistence with retry for port collision
    // TOCTOU race: Port allocation happens in-memory (provider allocates next available port),
    // but persistence to DB (unique constraint on node_id + bridge_port) happens later.
    // If two concurrent provisions pick the same port, one will fail with PG 23505.
    // Solution: Retry loop catches unique constraint errors, cleans up ghost container, and retries.
    const MAX_PROVISION_ATTEMPTS = 3;
    let lastError: string = "Unknown error";
    // Only a port collision retries; any other failure gives up after its first
    // attempt. `attempt` is scoped to the loop header, so the count that
    // actually ran is mirrored here for the post-loop markError message —
    // reporting the constant instead told operators "after 3 attempts" for a
    // one-attempt failure and misdirected a live outage investigation (#22508).
    let attemptsMade = 0;
    // Whether the failure that ended the loop was a port collision (the only
    // retryable class). Drives the "(not retryable)" marker: keying it off the
    // attempt count instead mislabels a collision-then-hard-failure run.
    let lastErrorRetryable = false;
    const provisionDockerImage =
      isWarmPoolProvision &&
      rec.docker_image &&
      rec.image_digest &&
      /^sha256:[0-9a-f]{64}$/.test(rec.image_digest)
        ? digestPinnedImageRef(rec.docker_image, rec.image_digest)
        : resolveManagedProvisionDockerImage(rec.docker_image);

    // Materialize the stored env for the container: BYO secrets are encrypted
    // at rest (#11332); compatibility plaintext values pass through unchanged. A
    // decrypt failure fails the provision (never boot a container with
    // ciphertext standing in for a secret) and is surfaced like any other
    // pre-provision failure.
    let materializedEnv: Record<string, string>;
    try {
      materializedEnv = await decryptAgentEnvVars(
        (rec.environment_vars as Record<string, string>) ?? {},
      );
    } catch (envError) {
      const message = envError instanceof Error ? envError.message : String(envError);
      await this.markError(rec, `Environment decryption failed: ${message}`);
      return {
        success: false,
        sandboxRecord: await agentSandboxesRepository.findById(rec.id),
        error: message,
      };
    }

    for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt++) {
      attemptsMade = attempt;
      let handle;

      try {
        const retryHandle =
          attempt === 1 && previousStatus === "provisioning"
            ? this.buildProvisioningRetryHandle(rec)
            : null;
        if (retryHandle) {
          handle = retryHandle;
          logger.info(
            "[agent-sandbox] Re-probing persisted provisioning container before create",
            {
              agentId: rec.id,
              sandboxId: handle.sandboxId,
            },
          );
        } else {
          // 2. Sandbox (via provider)
          const callerEnv = materializedEnv;
          // DATABASE_URL precedence: a self-contained image (e.g. a coding
          // container running its own bot) can ship its OWN database. Do not
          // silently clobber it with the managed shared DB URL — that would force the
          // image onto a DB it never asked for. If the caller already set
          // DATABASE_URL, keep it and expose the managed URL under a distinct
          // name (ELIZA_MANAGED_DATABASE_URL) so the image can opt in. Only when
          // the caller did NOT supply one do we inject the managed URL as
          // DATABASE_URL — the normal managed-agent path, byte-identical to before.
          const dbEnv = computeManagedAgentDbEnv(callerEnv, dbUri);
          handle = await (await this.getProvider()).create({
            agentId: rec.id,
            agentName: rec.agent_name ?? "CloudAgent",
            organizationId: rec.organization_id,
            executionTier: rec.execution_tier,
            environmentVars: applyRemoteDockerRuntimeMode({
              ...callerEnv,
              ...dbEnv,
            }),
            // Path A: pass the persisted character so the container boots AS
            // this agent (see docker-sandbox-provider ELIZA_AGENT_CHARACTER_JSON
            // injection + packages/agent/src/runtime/sandbox-character.ts).
            agentConfig: agentConfigForProvision(rec),
            // Path A: the gateways route by character_id, so the container must
            // register under, and answer as, that id (see
            // SANDBOX_ROUTE_AGENT_ID injection).
            routeAgentId: rec.character_id ?? undefined,
            snapshotId: rec.snapshot_id ?? undefined,
            dockerImage: provisionDockerImage,
            container: containerLaunch,
            ...this.replacementCleanupCallbacks(rec.id, rec.organization_id, {
              status: "provisioning",
              environmentRevision: rec.environment_revision,
              sandboxId: rec.sandbox_id,
              nodeId: rec.node_id,
              containerName: rec.container_name,
            }),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof SandboxReplacementCleanupUnresolvedError) {
          await this.persistUnresolvedReplacementCleanupFence(rec.id, rec.organization_id, err);
          return {
            success: false,
            retryable: true,
            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
            error: msg,
          };
        }
        await this.markError(rec, `Sandbox creation failed: ${msg}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: msg,
        };
      }

      try {
        // 3. Health check (via provider). Use the detailed probe so a
        // TRANSPORT-unresolved outcome (the probe never actually reached the
        // container — SSH flapping / node briefly unreachable) is treated as a
        // RETRYABLE condition instead of tearing down a likely-healthy
        // container and marking the row failed (the readiness-probe
        // false-negative split-brain, #15310 failure mode #6). A genuine
        // not-ready still fails the provision and self-heals via the normal
        // timeout path.
        const provider = await this.getProvider();
        const health = provider.checkHealthDetailed
          ? await provider.checkHealthDetailed(handle)
          : {
              ready: await provider.checkHealth(handle),
              verdict: "not_ready" as const,
            };

        const dockerMeta = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;

        if (!health.ready) {
          if (
            health.verdict === "transport_unresolved" ||
            health.verdict === "ingress_unresolved"
          ) {
            // Do NOT tear the container down: the probe never reached it, so it
            // is probably up and serving. PERSIST the container handle onto the
            // row (status stays `provisioning`) BEFORE throwing so that:
            //   (1) the daemon-side stuck-provisioning reconciler can FIND the
            //       row — it requires `sandbox_id IS NOT NULL` — and re-probe /
            //       flip it to `running` once transport recovers, and
            //   (2) a provision-job retry ADOPTS the same container (name +
            //       ports already on the row) instead of re-creating the
            //       deterministic container name, hitting an "already in use"
            //       collision, and tearing down the very container we preserved.
            // Without this write the leave-and-reconcile path is defeated for
            // exactly the SSH-transport-blip case it exists for.
            await this.persistContainerHandleForRetry(
              rec.id,
              rec.organization_id,
              rec.environment_revision,
              handle,
              dockerMeta,
            );
            throw new SandboxReachabilityUnresolvedError(
              health.verdict === "ingress_unresolved"
                ? "Sandbox container is healthy but its managed ingress is unresolved; leaving the container in place for retry/reconciliation"
                : "Sandbox readiness probe could not reach the container (SSH transport unresolved); leaving the container in place for retry/reconciliation",
            );
          }
          throw new Error("Sandbox health check timed out");
        }

        // C1b attribution guard (audit §C1b/§C5): a docker-fleet container MUST
        // carry a durable node_id before we flip the row to `running`. dockerMeta
        // is undefined whenever the strict type guard fails (metadata shape
        // drift: a missing field, or the empty-string nodeId that a partial
        // provider handle can produce). In that case the row would be flipped to
        // running + bridge_url set with node_id NULL — an unattributable orphan
        // that (a) undercounts the node recount (over-scheduling, autoscaler
        // spawns billable nodes — #15378), and (b) the orphan reconciler PROVABLY
        // cannot reap (allHaveNodeAndStamp skips live null-node rows — §C5). So
        // when the handle self-identifies as docker-backed but we have no usable
        // nodeId, fail LOUD and NON-retryable instead of minting the orphan. The
        // container already exists; the catch below stops it per the standard
        // post-create-failure convention and this message (distinct from the
        // unique/duplicate/23505 retry patterns) breaks straight to markError.
        //
        // Non-docker providers (local-docker, memory) have no node concept and
        // are unaffected. This does NOT touch the shared-tier insert path
        // (buildAgentSandboxInsertValues), which is running-with-null-node BY DESIGN.
        if (isDockerBackedMetadata(handle.metadata) && !dockerMeta?.nodeId) {
          logger.warn(
            "[agent-sandbox] Refusing to flip running: docker-backed handle has no durable node_id",
            {
              agentId: rec.id,
              sandboxId: handle.sandboxId,
              executionTier: rec.execution_tier,
              hasDockerMeta: Boolean(dockerMeta),
              metadataProvider:
                typeof handle.metadata === "object" && handle.metadata !== null
                  ? (handle.metadata as { provider?: unknown }).provider
                  : undefined,
            },
          );
          throw new Error(
            `${PROVISION_ATTRIBUTION_GUARD_PREFIX} docker-backed sandbox ${handle.sandboxId} produced no durable node_id (metadata shape drift or empty nodeId); refusing to mark running with node_id NULL`,
          );
        }

        const runtimeRec = {
          ...rec,
          sandbox_id: handle.sandboxId,
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          node_id: dockerMeta?.nodeId ?? rec.node_id,
          container_name: dockerMeta?.containerName ?? rec.container_name,
          bridge_port: dockerMeta?.bridgePort ?? rec.bridge_port,
          web_ui_port: dockerMeta?.webUiPort ?? rec.web_ui_port,
          headscale_ip: dockerMeta?.headscaleIp ?? rec.headscale_ip,
        };

        await this.ensureRuntimeAgentStarted(runtimeRec);

        // 4. Persist the reachable container and provider-specific metadata.
        //
        // User rows flip to `running` before restore because that status is the
        // proxy reachability gate; delaying it made a responsive agent render
        // as "waking" throughout restore (#14038). Unclaimed pool rows are the
        // exception: exposing them as claimable before the restore tail
        // succeeds recreates the readiness crash window, so they stay
        // `provisioning` until the final status+stamp CAS below.
        const updateData: Parameters<typeof agentSandboxesRepository.update>[1] = {
          // Pool rows stay non-claimable until the entire provision tail
          // succeeds. Their final status+readiness stamp is one repository CAS
          // below; user rows retain the early reachability flip.
          status: recoveringPendingWarmClaim || isWarmPoolProvision ? "provisioning" : "running",
          sandbox_id: handle.sandboxId,
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          last_heartbeat_at: new Date(),
          error_message: null,
          replacement_cleanup_sandbox_id: null,
          replacement_cleanup_node_id: null,
          replacement_cleanup_container_name: null,
          replacement_cleanup_attempt_id: null,
          replacement_cleanup_container_id: null,
          replacement_cleanup_vpn_node_id: null,
          replacement_cleanup_vpn_node_name: null,
          replacement_cleanup_preserved_vpn_node_id: null,
          replacement_cleanup_vpn_registration_started_at: null,
          replacement_cleanup_allocation_counted: null,
          replacement_cleanup_created_at: null,
        };

        if (dockerMeta) {
          if (dockerMeta.nodeId) updateData.node_id = dockerMeta.nodeId;
          if (dockerMeta.containerName) updateData.container_name = dockerMeta.containerName;
          if (dockerMeta.bridgePort) updateData.bridge_port = dockerMeta.bridgePort;
          if (dockerMeta.webUiPort) updateData.web_ui_port = dockerMeta.webUiPort;
          if (dockerMeta.headscaleIp) updateData.headscale_ip = dockerMeta.headscaleIp;
          if (dockerMeta.dockerImage) {
            // Warm-pool rows retain the configured logical image reference so
            // the API's exact-image claim contract can see them. Their actual
            // immutable runtime generation is recorded by image_digest.
            updateData.docker_image =
              isWarmPoolProvision && rec.docker_image ? rec.docker_image : dockerMeta.dockerImage;
          }
          // Always overwrite the digest (including null) so a re-provision
          // onto a different image clears any stale value. The reconciler
          // treats null as "unknown, wait until probe succeeds before
          // deciding", which is what we want during registry outages.
          updateData.image_digest = dockerMeta.imageDigest;
        }

        const updated = await this.transferReplacementToPrimary(
          rec.id,
          rec.organization_id,
          handle,
          rec.environment_revision,
          updateData,
        );

        // Re-enter the billable set on every successful provision. A
        // credit-suspended agent (billing_status='suspended') that a user tops
        // up and resumes/wakes via the user-facing routes would otherwise run
        // (status='running') permanently EXCLUDED from listBillableSandboxes =
        // free dedicated compute forever. The service-key resume/restart routes
        // already reactivate; do it here so ALL provision paths re-enter billing.
        // Idempotent + exempt-guarded (ne billing_status 'exempt').
        await agentBillingRepository.reactivateSandboxBillingAfterFunding(rec.id, new Date());

        // 5. Restore from backup (reconstructs incrementals back to a full).
        //
        // The snapshot holds only volatile in-memory session state — the agent's
        // identity, config, and durable data live in the DB record — so an
        // UNRECOVERABLE snapshot degrades to a FRESH boot instead of failing the
        // whole provision closed (error-policy:J4 designed degrade — the state is
        // unrestorable regardless of retries, so booting without prior in-memory
        // state is correct, not a fabricated success). Two unrecoverable shapes,
        // classified by `isUnrecoverableSnapshotError`: UNDECRYPTABLE (the org
        // DEK that encrypted it is gone — the ephemeral `memory` KMS backend
        // rotates its key on every restart — or the bytes are corrupt) and
        // UNRESTORABLE (the restore push is rejected with a permanent HTTP
        // status; HQ 14308 bricked an agent on a deterministic 401). Degrading on
        // FIRST detection matters: these failures re-fail identically on every
        // attempt, so retrying only burns the provision attempts and lands in
        // markError. A transient DB/IO/network/5xx error is rethrown so the
        // provision fails and the resume job retries rather than silently
        // discarding recoverable state.
        let backup: Awaited<ReturnType<typeof agentSandboxesRepository.getLatestBackup>>;
        let restoreState: Awaited<
          ReturnType<typeof agentSandboxesRepository.getReconstructedBackupState>
        >;
        if (
          restoreOverride?.kind === "fresh-boot" ||
          restoreOverride?.kind === "reviewed-fresh-boot"
        ) {
          // Explicit opt-in (wake forceFreshBoot): the caller accepted the
          // data loss, so no backup is read, degraded, or pruned — the stored
          // chain stays intact for a later explicit restore.
          backup = undefined;
          restoreState = undefined;
          logger.warn("[agent-sandbox] Backup restore skipped: explicit fresh boot requested", {
            agentId: rec.id,
          });
        } else {
          try {
            backup = reviewedRestore
              ? reviewedRestore.backup
              : restoreOverride?.kind === "from-backup"
                ? await agentSandboxesRepository.getBackupById(restoreOverride.backupId)
                : await agentSandboxesRepository.getLatestBackup(rec.id);
            if (isExplicitBackupRestore(restoreOverride)) {
              // Cross-sandbox ids are rejected here as defense in depth; the
              // wake gate and route already enforce ownership.
              if (!backup || backup.sandbox_record_id !== rec.id) {
                throw new Error(
                  `Restore backup ${restoreOverride.backupId} not found for this agent`,
                );
              }
            }
            restoreState = reviewedRestore
              ? reviewedRestore.state
              : backup
                ? await agentSandboxesRepository.getReconstructedBackupState(backup.id)
                : undefined;
            if (isExplicitBackupRestore(restoreOverride) && !restoreState) {
              // The exact row can disappear or leave the legacy-visible lane
              // between lookup and chain reconstruction. An explicit restore
              // must fail closed instead of booting a reachable empty runtime.
              throw new Error(
                `Restore backup ${restoreOverride.backupId} could not be reconstructed`,
              );
            }
          } catch (error) {
            // An explicitly-requested backup must NEVER silently degrade to a
            // fresh boot — the caller opted into THAT restore point, so a
            // failure here fails the provision (retryable by the wake job)
            // instead of booting empty (#15603 B6).
            // Ordered before the from-backup rethrow: the gated wake ALWAYS
            // passes `from-backup`, so checking that first would swallow the
            // consent sentence on the one path where the consent mechanism
            // exists.
            if (error instanceof SnapshotPayloadTooLargeError) {
              // Size refusal fails CLOSED even on an ordinary provision: the
              // chain is intact, only too large — booting empty would silently
              // drop every byte of it. The one consent path is wake's
              // forceFreshBoot.
              throw new ElizaError(
                `Restore refused: ${error.message}. Booting empty would discard this agent's state; wake with forceFreshBoot to explicitly accept the data loss.`,
                {
                  code: "SNAPSHOT_RESTORE_REQUIRES_FRESH_BOOT_CONSENT",
                  cause: error,
                  context: {
                    agentId: rec.id,
                    payloadBytes: error.payloadBytes,
                    limitBytes: error.limitBytes,
                  },
                  severity: "fatal",
                },
              );
            }
            if (isExplicitBackupRestore(restoreOverride)) throw error;
            if (!isUnrecoverableSnapshotError(error)) throw error;
            await this.degradeUnrecoverableSnapshot(rec.id, backup?.id, error);
            backup = undefined;
            restoreState = undefined;
          }
        }
        if (restoreState) {
          try {
            if (reviewedRestore && restoreOverride?.kind === "from-reviewed-backup") {
              await dbWrite.transaction(async (tx) => {
                const lockedRestoreChain = await tx
                  .select()
                  .from(agentSandboxBackups)
                  .where(
                    and(
                      inArray(
                        agentSandboxBackups.id,
                        reviewedRestore.storedChain.map((row) => row.id),
                      ),
                      eq(agentSandboxBackups.sandbox_record_id, rec.id),
                    ),
                  )
                  .orderBy(asc(agentSandboxBackups.id))
                  .for("update")
                  .execute();
                if (
                  !storedRestoreChainStillCanonical(
                    lockedRestoreChain,
                    reviewedRestore.storedChain,
                  ) ||
                  !storedRestoreChainMatchesReviewedAuthority(
                    lockedRestoreChain,
                    rec.id,
                    restoreOverride,
                  )
                ) {
                  throw new Error(RESTORE_BACKUP_CHANGED);
                }
                await this.pushState(handle.bridgeUrl, restoreState, {
                  trusted: true,
                  authRec: rec,
                });
              });
            } else {
              await this.pushState(handle.bridgeUrl, restoreState, {
                trusted: true,
                authRec: rec,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const missingCustomRestoreEndpoint =
              rec.execution_tier === "custom" &&
              message.startsWith("State restore failed: HTTP 404");
            if (error instanceof SnapshotPayloadTooLargeError) {
              // Ordered before the from-backup rethrow for the same reason as
              // the fetch branch: a gated wake would otherwise never see the
              // consent sentence.
              throw new ElizaError(
                `Restore refused: ${error.message}. Booting empty would discard this agent's state; wake with forceFreshBoot to explicitly accept the data loss.`,
                {
                  code: "SNAPSHOT_RESTORE_REQUIRES_FRESH_BOOT_CONSENT",
                  cause: error,
                  context: {
                    agentId: rec.id,
                    payloadBytes: error.payloadBytes,
                    limitBytes: error.limitBytes,
                  },
                  severity: "fatal",
                },
              );
            } else if (
              isExplicitBackupRestore(restoreOverride) &&
              (restoreOverride.kind === "from-reviewed-backup" ||
                restoreOverride.requireRestoreEndpoint ||
                !missingCustomRestoreEndpoint)
            ) {
              // Same no-silent-fresh-boot rule as the fetch above: an explicit
              // restore point that cannot be pushed fails the provision. A
              // manual restore requires the endpoint because restore() reports
              // that exact point as applied; the historical wake lane alone
              // keeps its custom-image 404 compatibility skip (#15603 B6).
              throw error;
            } else if (missingCustomRestoreEndpoint) {
              // Ordinary custom-image provisions may legitimately lack the
              // restore endpoint. Keep the snapshot intact for a future image;
              // manual restores opt into strict endpoint enforcement above.
              logger.info(
                "[agent-sandbox] Backup restore skipped: custom image has no restore endpoint",
                {
                  agentId: rec.id,
                  backupId: backup?.id,
                },
              );
            } else if (isUnrecoverableSnapshotError(error)) {
              await this.degradeUnrecoverableSnapshot(rec.id, backup?.id, error);
            } else {
              throw error;
            }
          }
        } else if (backup) {
          logger.warn("[agent-sandbox] Backup restore skipped: reconstructed state was null", {
            agentId: rec.id,
            backupId: backup.id,
          });
        }

        let completed = updated;
        if (isWarmPoolProvision) {
          const ready = await agentSandboxesRepository.commitPoolEntryReady(updated);
          if (!ready) {
            throw new ElizaError("Warm-pool readiness generation changed before final commit", {
              code: "WARM_POOL_READINESS_CAS_MISSED",
              context: {
                poolId: updated.id,
                environmentRevision: updated.environment_revision,
                sandboxId: updated.sandbox_id,
                nodeId: updated.node_id,
                containerName: updated.container_name,
              },
              severity: "ephemeral",
            });
          }
          completed = ready;
        }

        logger.info("[agent-sandbox] Provisioned", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
        });
        return {
          success: true,
          sandboxRecord: completed,
          bridgeUrl: handle.bridgeUrl,
          healthUrl: handle.healthUrl,
        };
      } catch (err) {
        // Ghost container deletion: provider.create() succeeded but DB update or health check failed
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;

        // Transport-unresolved readiness probe: the probe never reached the
        // container, so it is likely healthy. DO NOT tear it down and DO NOT
        // markError — that is exactly the false-negative that wedges a healthy
        // row (#15310 #6). Leave the container running and return a RETRYABLE
        // failure: the provision job retries, and the daemon stuck-provisioning
        // reconciler re-probes and flips the row to `running` once transport
        // recovers. Preserve the (pending/provisioning) row so the reconciler
        // and job retry both have something to act on.
        if (err instanceof SandboxReachabilityUnresolvedError) {
          logger.warn(
            "[agent-sandbox] Managed reachability remains unresolved; leaving container in place for retry/reconciliation",
            { agentId: rec.id, sandboxId: handle.sandboxId, attempt },
          );
          return {
            success: false,
            retryable: true,
            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
            error: msg,
          };
        }

        logger.warn("[agent-sandbox] Post-create failure, cleaning up container", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
          error: msg,
        });

        try {
          const current = await agentSandboxesRepository.findByIdAndOrg(
            rec.id,
            rec.organization_id,
          );
          if (current && this.getReplacementCleanupLocator(current)) {
            await this.retirePersistedReplacementCleanup(rec.id, rec.organization_id);
          } else {
            const provider = await this.getProvider();
            if (!provider.stopForReplacement) {
              throw new Error("Sandbox provider cannot prove failed provision absent");
            }
            await provider.stopForReplacement(handle.sandboxId);
          }
        } catch (stopErr) {
          // error-policy:J1 provisioning boundary translation — failed ghost
          // cleanup is surfaced as retryable and retains its durable locator.
          logger.error("[agent-sandbox] Ghost container cleanup remains unresolved", {
            sandboxId: handle.sandboxId,
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
          return {
            success: false,
            retryable: true,
            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
            error: `${msg}; replacement cleanup remains pending: ${
              stopErr instanceof Error ? stopErr.message : String(stopErr)
            }`,
          };
        }

        // Check if it's a unique constraint error (port collision) -> retry
        const isUniqueConstraintError =
          msg.includes("23505") ||
          msg.toLowerCase().includes("unique") ||
          msg.toLowerCase().includes("duplicate");
        lastErrorRetryable = isUniqueConstraintError;

        if (isUniqueConstraintError && attempt < MAX_PROVISION_ATTEMPTS) {
          logger.info("[agent-sandbox] Port collision detected, retrying", {
            attempt,
            nextAttempt: attempt + 1,
          });
          continue; // Retry
        }

        // Non-retryable error or max attempts reached -> fail
        break;
      }
    }

    // Exhausted: either the retry budget is spent, or the last failure was not
    // a port collision and therefore was never eligible for a retry.
    const attemptsLabel = attemptsMade === 1 ? "1 attempt" : `${attemptsMade} attempts`;
    const giveUpReason = lastErrorRetryable ? "" : " (not retryable)";
    await this.markError(
      rec,
      `Provisioning failed after ${attemptsLabel}${giveUpReason}: ${lastError}`,
    );
    return {
      success: false,
      sandboxRecord: await agentSandboxesRepository.findById(rec.id),
      error: lastError,
    };
    } finally {
      if (reviewedAdmissionFence) {
        await releaseReviewedProvisionAdmissionFence(reviewedAdmissionFence);
      }
    }
  }

  private async getSafeBridgeEndpoint(
    sandboxOrBridgeUrl:
      | Pick<AgentSandbox, "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id">
      | string,
    path: string,
    options?: { trusted?: boolean },
  ): Promise<string> {
    if (typeof sandboxOrBridgeUrl === "string") {
      if (options?.trusted) {
        return new URL(path, sandboxOrBridgeUrl).toString();
      }

      return (await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl).toString())).toString();
    }

    const dockerBridgeBaseUrl = await this.getTrustedDockerBridgeBaseUrl(sandboxOrBridgeUrl);
    if (
      dockerBridgeBaseUrl &&
      sandboxOrBridgeUrl.bridge_url &&
      this.matchesTrustedDockerBridge(sandboxOrBridgeUrl.bridge_url, dockerBridgeBaseUrl)
    ) {
      return new URL(path, dockerBridgeBaseUrl).toString();
    }

    if (!sandboxOrBridgeUrl.bridge_url) {
      throw new Error("Sandbox bridge is missing");
    }

    if (this.isTrustedLegacyPrivateBridgeUrl(sandboxOrBridgeUrl)) {
      return new URL(path, sandboxOrBridgeUrl.bridge_url).toString();
    }

    return (
      await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl.bridge_url).toString())
    ).toString();
  }

  private getConfiguredAgentBaseDomain(): string | null {
    const configured = getCloudAwareEnv().ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim();
    if (!configured) return null;
    return this.normalizeConfiguredHostname(configured);
  }

  private normalizeConfiguredHostname(hostname: string): string | null {
    const normalized = hostname
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
      .replace(/\.+$/, "");
    return normalized || null;
  }

  /**
   * Parse routing hosts more strictly than the display-URL helpers do. These
   * values select the recipient of the agent's bearer token, so a malformed
   * Worker binding must stop the request before fetch rather than fall back to
   * the public UUID hostname (which same-zone routing sends to wildcard DNS)
   * or a credential/path embedded in an otherwise hostname-only binding.
   */
  private getRequiredWorkerRoutingHost(
    variable: "AGENT_ROUTER_ORIGIN_HOST" | "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
    value: string | undefined,
    options: { allowPort: boolean },
  ): string {
    const raw = value?.trim();
    if (!raw || raw.startsWith("//")) throw new AgentRouterConfigurationError(variable);

    let parsed: URL;
    try {
      parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      // error-policy:J3 an unparsable routing binding is an explicit invalid
      // configuration signal; it must never fall through to a token recipient.
      throw new AgentRouterConfigurationError(variable);
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const validDnsName =
      hostname.length > 0 &&
      hostname.length <= 253 &&
      hostname
        .split(".")
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        );
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !validDnsName ||
      (!options.allowPort && parsed.port)
    ) {
      throw new AgentRouterConfigurationError(variable);
    }

    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  }

  private getWorkerAgentRouterFetchTarget(
    rec: AgentNetworkTarget,
    path: string,
  ): AgentFetchTarget | null {
    if (!this.isCloudflareWorkerRuntime()) return null;

    const env = getCloudAwareEnv();
    const originHost = this.getRequiredWorkerRoutingHost(
      "AGENT_ROUTER_ORIGIN_HOST",
      env.AGENT_ROUTER_ORIGIN_HOST,
      { allowPort: true },
    );
    const baseDomain = this.getRequiredWorkerRoutingHost(
      "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
      env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      { allowPort: false },
    );
    const agentId = rec.id.trim().toLowerCase();
    if (!AGENT_ID_RE.test(agentId)) {
      throw new Error("Worker agent routing requires a valid agent UUID");
    }

    const route = new URL(path, "https://agent-route.invalid/");
    if (route.origin !== "https://agent-route.invalid") {
      throw new Error("Agent API path must be relative to the agent origin");
    }

    const target = new URL(`https://${originHost}/`);
    target.pathname = route.pathname;
    target.search = route.search;
    target.hash = route.hash;
    return {
      url: target.toString(),
      forwardedHost: `${agentId}.${baseDomain}`,
    };
  }

  private async getAgentApiFetchTarget(
    rec: AgentNetworkTarget,
    path: string,
  ): Promise<AgentFetchTarget> {
    const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
    if (workerTarget) return workerTarget;

    const baseDomain = this.getConfiguredAgentBaseDomain();

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return { url: new URL(path, trustedWebBaseUrl).toString() };
    }

    if (baseDomain) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) return { url: publicEndpoint };
    }

    return { url: await this.getSafeBridgeEndpoint(rec, path) };
  }

  private async fetchAgentTarget(
    rec: Pick<AgentSandbox, "id" | "environment_vars">,
    target: AgentFetchTarget,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("host");
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
    const trustedHeaders = new Headers(this.getAgentJsonHeaders(rec));
    if (!trustedHeaders.has("authorization")) {
      throw new Error(`Agent proxy requires an API token for ${rec.id}`);
    }
    trustedHeaders.forEach((value, name) => headers.set(name, value));
    if (target.forwardedHost) {
      headers.set("x-forwarded-host", target.forwardedHost);
      headers.set("x-forwarded-proto", "https");
    }
    // Fetch strips Authorization on a cross-origin redirect, but preserves
    // custom auth headers such as X-Api-Key and X-Eliza-Token. Never let the
    // configured control-plane origin redirect an agent token to another host.
    return await fetch(target.url, { ...init, headers, redirect: "manual" });
  }

  private async fetchAgentApi(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const target = await this.getAgentApiFetchTarget(rec, path);
    return await this.fetchAgentTarget(rec, target, init);
  }

  private async fetchCanonicalConversationApi(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit,
    canonicalBridgeBase: unknown,
  ): Promise<Response> {
    const trimTrailingSlashes = (value: string): string => {
      let end = value.length;
      while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
      return value.slice(0, end);
    };
    const requestedBase =
      typeof canonicalBridgeBase === "string"
        ? trimTrailingSlashes(canonicalBridgeBase.trim())
        : null;
    const storedBase = rec.bridge_url ? trimTrailingSlashes(rec.bridge_url.trim()) : null;
    if (requestedBase && requestedBase === storedBase) {
      const url = new URL(requestedBase);
      const isLoopback =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback) {
        // The local control plane deliberately multiplexes sandboxes beneath a
        // path-prefixed loopback URL. Only the exact DB-owned target may bypass
        // outbound SSRF validation; preserving its prefix reaches the same
        // canonical conversation that accepted the cutover import.
        return await this.fetchAgentTarget(rec, { url: `${requestedBase}${path}` }, init);
      }
    }

    const baseDomain = this.getConfiguredAgentBaseDomain();
    if (baseDomain) {
      const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
      if (workerTarget) {
        return await this.fetchAgentTarget(rec, workerTarget, init);
      }
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) {
        return await this.fetchAgentTarget(rec, { url: publicEndpoint }, init);
      }
    }

    return await this.fetchAgentTarget(
      rec,
      {
        url: await this.getSafeBridgeEndpoint(rec, path),
      },
      init,
    );
  }

  private async getAgentWebFetchTarget(
    rec: AgentNetworkTarget,
    path: string,
  ): Promise<AgentFetchTarget> {
    const workerTarget = this.getWorkerAgentRouterFetchTarget(rec, path);
    if (workerTarget) return workerTarget;

    return { url: await this.getAgentWebEndpoint(rec, path) };
  }

  private async fetchAgentWeb(
    rec: AgentApiTarget,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const target = await this.getAgentWebFetchTarget(rec, path);
    return await this.fetchAgentTarget(rec, target, init);
  }

  private async getAgentWebEndpoint(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<string> {
    const baseDomain = this.getConfiguredAgentBaseDomain();
    const publicEndpoint = getElizaAgentPublicWebUiUrl(
      rec,
      baseDomain ? { baseDomain, path } : { path },
    );
    if (publicEndpoint) return publicEndpoint;

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return new URL(path, trustedWebBaseUrl).toString();
    }

    return this.getSafeBridgeEndpoint(rec, path);
  }

  private async getTrustedDockerWebBaseUrl(
    sandbox: Pick<
      AgentSandbox,
      "node_id" | "web_ui_port" | "headscale_ip" | "health_url" | "bridge_url"
    >,
  ): Promise<string | null> {
    if (sandbox.health_url) {
      try {
        return new URL(sandbox.health_url).origin;
      } catch {
        // Fall through to metadata-based resolution.
      }
    }

    if (!sandbox.node_id || !sandbox.web_ui_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.web_ui_port}`;
  }

  private async getTrustedDockerBridgeBaseUrl(
    sandbox: Pick<AgentSandbox, "node_id" | "bridge_port" | "headscale_ip">,
  ): Promise<string | null> {
    if (!sandbox.node_id || !sandbox.bridge_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.bridge_port}`;
  }

  private isTrustedLegacyPrivateBridgeUrl(
    sandbox: Pick<
      AgentSandbox,
      "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id"
    >,
  ): boolean {
    if (!sandbox.bridge_url) {
      return false;
    }

    let candidate: URL;
    try {
      candidate = new URL(sandbox.bridge_url);
    } catch {
      return false;
    }

    if (candidate.protocol !== "http:" || !this.isAgentPrivateBridgeHost(candidate.hostname)) {
      return false;
    }

    const candidatePort = Number.parseInt(candidate.port, 10);
    const hasMatchingBridgePort =
      sandbox.bridge_port != null &&
      Number.isInteger(candidatePort) &&
      candidatePort === sandbox.bridge_port;
    const hasMatchingHeadscaleIp =
      !!sandbox.headscale_ip && candidate.hostname === sandbox.headscale_ip;
    const hasDockerNodeSignal = !!sandbox.node_id;
    // Older Docker-backed records may predate the node/headscale backfill but
    // still carry the provider-generated `sandbox_id`/container name.

    return (
      hasMatchingHeadscaleIp ||
      (hasDockerNodeSignal && hasMatchingBridgePort) ||
      (hasDockerNodeSignal && hasMatchingHeadscaleIp)
    );
  }

  private isLegacyDockerSandboxId(sandboxId: string | null | undefined): boolean {
    return typeof sandboxId === "string" && /^agent-[0-9a-f-]{36}$/i.test(sandboxId);
  }

  private isAgentPrivateBridgeHost(hostname: string): boolean {
    if (isIP(hostname) !== 4) {
      return false;
    }

    const [first, second] = hostname.split(".").map((part) => Number.parseInt(part, 10));
    // CGNAT (100.64.0.0/10)
    if (first === 100 && second >= 64 && second <= 127) return true;
    // RFC1918: 10.0.0.0/8
    if (first === 10) return true;
    // RFC1918: 172.16.0.0/12
    if (first === 172 && second >= 16 && second <= 31) return true;
    // RFC1918: 192.168.0.0/16
    if (first === 192 && second === 168) return true;
    return false;
  }

  private matchesTrustedDockerBridge(
    bridgeUrl: string,
    trustedDockerBridgeBaseUrl: string,
  ): boolean {
    try {
      const candidate = new URL(bridgeUrl);
      const trusted = new URL(trustedDockerBridgeBaseUrl);
      return candidate.host === trusted.host;
    } catch {
      return false;
    }
  }

  private isCloudflareWorkerRuntime(): boolean {
    return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
  }

  private sharedRuntimeStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private sharedRuntimeStringList(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }

  private isSharedTurnMessage(value: unknown): value is SharedTurnMessage {
    const message = this.nestedBridgeRecord(value);
    return (
      (message?.role === "user" || message?.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    );
  }

  private async loadSharedRuntimeHistory(
    agentId: string,
    channelId: string,
  ): Promise<SharedTurnMessage[]> {
    // Durable source of truth is Postgres (the cache is disabled on the prod
    // Worker, CACHE_ENABLED=false, so it never persisted). See
    // db/schemas/shared-runtime-history.ts.
    const stored = await sharedRuntimeHistoryRepository.get(agentId, channelId);
    return stored.filter((message): message is SharedTurnMessage =>
      this.isSharedTurnMessage(message),
    );
  }

  private async saveSharedRuntimeHistory(
    agentId: string,
    channelId: string,
    history: SharedTurnMessage[],
  ): Promise<void> {
    await sharedRuntimeHistoryRepository.merge(agentId, channelId, history);
  }

  private sharedRuntimeBillingPrompt(
    character: SharedAgentCharacter,
    history: SharedTurnMessage[],
    message: string,
  ): Array<{ content: string }> {
    return [
      { content: character.system },
      ...(character.bio ?? []).map((content) => ({ content })),
      ...history.map((turn) => ({ content: turn.content })),
      { content: message },
    ].filter((entry) => entry.content.trim().length > 0);
  }

  private sharedRuntimeBillingUsage(
    turn: RunSharedAgentTurnResult,
    estimatedInputTokens: number,
  ): AIUsage {
    return this.sharedRuntimeBillingUsageForReply(turn.reply, turn.usage, estimatedInputTokens);
  }

  private sharedRuntimeBillingUsageForReply(
    reply: string,
    usage: SharedAgentTurnUsage | undefined,
    estimatedInputTokens: number,
  ): AIUsage {
    const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
    const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      return usage ?? {};
    }
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: estimateInputTokens([{ content: reply }]),
    };
  }

  private async buildSharedRuntimeCharacter(rec: AgentSandbox): Promise<SharedAgentCharacter> {
    const config = this.nestedBridgeRecord(rec.agent_config) ?? {};
    const configCharacter = this.nestedBridgeRecord(config.character) ?? config;
    const linkedCharacter = rec.character_id
      ? await userCharactersRepository.findByIdInOrganization(rec.character_id, rec.organization_id)
      : undefined;
    const linkedSettings = this.nestedBridgeRecord(linkedCharacter?.settings);

    const name =
      this.sharedRuntimeStringValue(linkedCharacter?.name) ??
      this.sharedRuntimeStringValue(configCharacter.name) ??
      this.sharedRuntimeStringValue(config.name) ??
      rec.agent_name ??
      "Eliza agent";
    const system =
      this.sharedRuntimeStringValue(linkedCharacter?.system) ??
      this.sharedRuntimeStringValue(configCharacter.system) ??
      this.sharedRuntimeStringValue(config.system) ??
      this.sharedRuntimeStringValue(configCharacter.prompt) ??
      this.sharedRuntimeStringValue(config.prompt) ??
      `You are ${name}, a helpful assistant.`;
    const bio = [
      ...this.sharedRuntimeStringList(linkedCharacter?.bio),
      ...this.sharedRuntimeStringList(configCharacter.bio),
      ...this.sharedRuntimeStringList(config.bio),
    ];
    const model =
      this.sharedRuntimeStringValue(linkedSettings?.model) ??
      this.sharedRuntimeStringValue(configCharacter.model) ??
      this.sharedRuntimeStringValue(config.model);

    return {
      name,
      system,
      ...(bio.length > 0 ? { bio } : {}),
      ...(model ? { model } : {}),
    };
  }

  private async bridgeSharedStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        agentName: rec.agent_name ?? undefined,
        runtime: "shared",
      },
    };
  }

  private async bridgeSharedMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<BridgeResponse> {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const channelId = this.stableBridgeChannelId(rec.id, params);
    const [character, history] = await Promise.all([
      this.buildSharedRuntimeCharacter(rec),
      this.loadSharedRuntimeHistory(rec.id, channelId),
    ]);
    const billingModel = resolveSharedAgentTurnModel(character.model);
    const estimatedInputTokens = billingModel
      ? estimateInputTokens(this.sharedRuntimeBillingPrompt(character, history, text))
      : 0;
    const idempotencyKey = `shared-runtime:${rec.id}:${channelId}:${crypto.randomUUID()}`;
    const requestId = `shared-runtime-${crypto.randomUUID()}`;
    const billingContext: BillingContext | null = billingModel
      ? {
          organizationId: rec.organization_id,
          userId: rec.user_id,
          model: billingModel,
          requestId,
          description: `Shared runtime turn: ${character.name}`,
          metadata: {
            agentId: rec.id,
            channelId,
            executionTier: rec.execution_tier,
            idempotencyKey,
            prompt: text,
            runtime: "shared",
          },
        }
      : null;
    let reservation: CreditReservation | null = null;
    let settleReservedCredits = createCreditReservationSettler(undefined);
    const settleReservation = async (
      actualCost: number,
    ): Promise<CreditReconciliationResult | null> => settleReservedCredits(actualCost);
    if (billingContext) {
      try {
        reservation = await reserveCredits(billingContext, estimatedInputTokens, 500);
        settleReservedCredits = createCreditReservationSettler(reservation);
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return {
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: BRIDGE_INSUFFICIENT_CREDITS_CODE,
              message: `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
            },
          };
        }
        throw error;
      }
    }
    // #11169-class refund guard: the reserve above is settled on the degraded
    // and billing-failure paths below, but a THROW between here and the settle —
    // runSharedAgentTurn raising, or saveSharedRuntimeHistory hitting a DB blip
    // (it runs OUTSIDE the inner billing try/catch) — would otherwise propagate
    // without ever refunding, stranding the hold and over-charging the org.
    // settleReservation is idempotent (reservationSettled), so refunding here
    // never double-refunds a turn that already settled on a normal path. The
    // deferred billing tail below owns its own settle-or-refund end-to-end, so
    // this catch never races it: by the time the tail is registered, every
    // throw it can produce is contained inside the tail's own try/catch.
    try {
      const turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
        capabilityText: text,
        execution: {
          agentKey: rec.id,
          roomKey: channelId,
          channel: { type: ChannelType.DM, source: "shared-runtime" },
        },
      });
      if (turn.degraded) {
        // A failed/degraded turn isn't persisted or billed — just refund the hold.
        await settleReservation(0);
      } else {
        await this.saveSharedRuntimeHistory(rec.id, channelId, turn.history);
        if (billingContext) {
          // The reply is final once the turn ran and history persisted, but the
          // billing tail (billUsage → settleReservation → analytics → audit) is
          // ~1.7s of cross-region Worker→DB RTT. On a Worker, defer it via
          // executionCtx.waitUntil so it completes off the response path;
          // without an executionCtx (tests, non-Worker callers) it runs inline,
          // exactly as before. The deferred task ALWAYS settles the hold:
          // success settles at billing.totalCost, any failure refunds via the
          // idempotent settleReservation(0), and a refund throw is contained
          // and logged (never an unhandled waitUntil rejection) — the #11169
          // sweep-credit-reservations cron backstops a hold stranded by a
          // dropped waitUntil or a failed refund.
          await settleOffResponsePath(executionCtx, async () => {
            try {
              const billing = await billUsage(
                billingContext,
                this.sharedRuntimeBillingUsage(turn, estimatedInputTokens),
                reservation
                  ? {
                      ...reservation,
                      reconcile: async (actualCost) =>
                        (await settleReservation(actualCost)) ?? undefined,
                    }
                  : undefined,
              );
              const settlement = await settleReservation(billing.totalCost);
              const usageRecord = await recordUsageAnalytics(billingContext, billing, {
                type: "chat",
                content: turn.reply,
                prompt: text,
              });
              if (usageRecord) {
                await aiBillingRecordsService
                  .record({
                    context: billingContext,
                    billing,
                    usageRecord,
                    idempotencyKey,
                    reconciliation: settlement,
                  })
                  .catch((error) => {
                    logger.error("[shared-runtime] AI billing audit record failed", {
                      error: error instanceof Error ? error.message : String(error),
                      agentId: rec.id,
                    });
                  });
              }
            } catch (error) {
              // error-policy:J1 deferred-settlement boundary — the response may
              // already be gone, so the refund is the handling: settle(0) is
              // idempotent, and a refund failure is logged for the cron sweep.
              try {
                await settleReservation(0);
              } catch (refundError) {
                logger.error(
                  "[shared-runtime] deferred billing refund failed; sweep-credit-reservations will reclaim the hold",
                  {
                    error: refundError instanceof Error ? refundError.message : String(refundError),
                    agentId: rec.id,
                  },
                );
              }
              logger.error("[shared-runtime] billing failed", {
                error: error instanceof Error ? error.message : String(error),
                agentId: rec.id,
              });
            }
          });
        }
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: turn.reply,
          agentName: character.name,
          channelId,
          model: turn.model,
          degraded: turn.degraded,
          runtime: "shared",
          transport: "shared-runtime",
        },
      };
    } catch (settleError) {
      // Refund the upfront hold on any post-reserve failure, then rethrow.
      await settleReservation(0);
      throw settleError;
    }
  }

  private async bridgeSharedMessageStream(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<Response> {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return this.createBridgeSseErrorResponse("message.send requires params.text");
    }

    const channelId = this.stableBridgeChannelId(rec.id, params);
    const [character, history] = await Promise.all([
      this.buildSharedRuntimeCharacter(rec),
      this.loadSharedRuntimeHistory(rec.id, channelId),
    ]);
    const billingModel = resolveSharedAgentTurnModel(character.model);
    const estimatedInputTokens = billingModel
      ? estimateInputTokens(this.sharedRuntimeBillingPrompt(character, history, text))
      : 0;
    const idempotencyKey = `shared-runtime:${rec.id}:${channelId}:${crypto.randomUUID()}`;
    const requestId = `shared-runtime-${crypto.randomUUID()}`;
    const billingContext: BillingContext | null = billingModel
      ? {
          organizationId: rec.organization_id,
          userId: rec.user_id,
          model: billingModel,
          requestId,
          description: `Shared runtime turn: ${character.name}`,
          metadata: {
            agentId: rec.id,
            channelId,
            executionTier: rec.execution_tier,
            idempotencyKey,
            prompt: text,
            runtime: "shared",
          },
        }
      : null;
    let reservation: CreditReservation | null = null;
    let settleReservedCredits = createCreditReservationSettler(undefined);
    const settleReservation = async (
      actualCost: number,
    ): Promise<CreditReconciliationResult | null> => settleReservedCredits(actualCost);
    if (billingContext) {
      try {
        reservation = await reserveCredits(billingContext, estimatedInputTokens, 500);
        settleReservedCredits = createCreditReservationSettler(reservation);
      } catch (error) {
        // error-policy:J1 boundary translation — no SSE bytes exist before credit
        // reservation, so the HTTP route can still return the canonical 402.
        if (error instanceof InsufficientCreditsError) {
          throw new InsufficientCreditsApiError(
            `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
          );
        }
        throw error;
      }
    }

    try {
      const turn = await runSharedAgentTurnStream({
        character,
        history,
        message: text,
        capabilityText: text,
        execution: {
          agentKey: rec.id,
          roomKey: channelId,
          channel: { type: ChannelType.DM, source: "shared-runtime" },
        },
      });
      if (turn.degraded) {
        await settleReservation(0);
        return this.createBridgeSseTextResponse(turn.reply ?? "");
      }
      const parts = turn.parts;
      if (!parts) {
        await settleReservation(0);
        return this.createBridgeSseErrorResponse("Shared runtime stream did not start");
      }

      const messageId = crypto.randomUUID();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          let reply = "";
          let finished = false;
          // Once the billing tail is registered it owns settlement end-to-end
          // (success settles at totalCost, failure refunds). The stream catch
          // below must then leave the reservation alone: a client cancel makes
          // the `done` enqueue throw AFTER registration, and racing a
          // settle(0) against the deferred tail's settle(totalCost) would turn
          // a fully-delivered, persisted reply into an unbilled one depending
          // on which write lands first.
          let billingTailOwnsSettlement = false;
          try {
            for await (const part of parts) {
              if (part.type === "text-delta") {
                reply += part.text;
                controller.enqueue(
                  encoder.encode(
                    chatSseFrame("chunk", {
                      messageId,
                      chunk: part.text,
                      text: part.text,
                      fullText: reply,
                      timestamp: Date.now(),
                    }),
                  ),
                );
                continue;
              }

              finished = true;
              const finalReply = part.text.trim() || reply.trim() || "…";
              const sentAt = Date.now();
              const nextHistory: SharedTurnMessage[] = [
                ...history,
                { role: "user", content: text.trim(), createdAt: sentAt },
                {
                  role: "assistant",
                  content: finalReply,
                  createdAt: sentAt + 1,
                  ...(turn.internalGrounding ? { grounding: turn.internalGrounding } : {}),
                },
              ];
              await this.saveSharedRuntimeHistory(rec.id, channelId, nextHistory);
              if (billingContext) {
                // The reply is final once the last token arrived and history
                // persisted, but the billing tail (billUsage → settleReservation
                // → analytics → audit) is ~4 serial cross-region Worker→DB
                // round-trips (~1.5-2s) that previously ran INLINE before the
                // `done` SSE frame — the exact firstText≈1.4s / done≈4s gap
                // measured on staging. Same deferral the non-stream send got
                // (#8759 / settleOffResponsePath): on a Worker the tail runs via
                // executionCtx.waitUntil OFF the `done` path; without an
                // executionCtx (tests, non-Worker callers) it runs inline,
                // exactly as before. The deferred task ALWAYS settles the hold:
                // success settles at billing.totalCost, any failure refunds via
                // the idempotent settleReservation(0), and a refund throw is
                // contained and logged (never an unhandled waitUntil rejection)
                // — the #11169 sweep-credit-reservations cron backstops a hold
                // stranded by a dropped waitUntil or a failed refund.
                billingTailOwnsSettlement = true;
                await settleOffResponsePath(executionCtx, async () => {
                  try {
                    const billing = await billUsage(
                      billingContext,
                      this.sharedRuntimeBillingUsageForReply(
                        finalReply,
                        part.usage,
                        estimatedInputTokens,
                      ),
                      reservation
                        ? {
                            ...reservation,
                            reconcile: async (actualCost) =>
                              (await settleReservation(actualCost)) ?? undefined,
                          }
                        : undefined,
                    );
                    const settlement = await settleReservation(billing.totalCost);
                    const usageRecord = await recordUsageAnalytics(billingContext, billing, {
                      type: "chat",
                      content: finalReply,
                      prompt: text,
                    });
                    if (usageRecord) {
                      await aiBillingRecordsService
                        .record({
                          context: billingContext,
                          billing,
                          usageRecord,
                          idempotencyKey,
                          reconciliation: settlement,
                        })
                        .catch((error) => {
                          logger.error("[shared-runtime] AI billing audit record failed", {
                            error: error instanceof Error ? error.message : String(error),
                            agentId: rec.id,
                          });
                        });
                    }
                  } catch (error) {
                    // error-policy:J1 deferred-settlement boundary — the `done`
                    // frame may already be flushed, so the refund is the
                    // handling: settle(0) is idempotent, and a refund failure is
                    // logged for the cron sweep.
                    try {
                      await settleReservation(0);
                    } catch (refundError) {
                      logger.error(
                        "[shared-runtime] deferred billing refund failed; sweep-credit-reservations will reclaim the hold",
                        {
                          error:
                            refundError instanceof Error
                              ? refundError.message
                              : String(refundError),
                          agentId: rec.id,
                        },
                      );
                    }
                    logger.error("[shared-runtime] billing failed", {
                      error: error instanceof Error ? error.message : String(error),
                      agentId: rec.id,
                    });
                  }
                });
              }
              const doneData = { messageId, text: finalReply, fullText: finalReply };
              controller.enqueue(encoder.encode(chatSseFrame("done", doneData)));
            }
            if (!finished) {
              await settleReservation(0);
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("error", {
                    message: "Shared runtime stream ended without completion",
                  }),
                ),
              );
            }
          } catch (error) {
            // error-policy:J1 stream boundary translation — partial SSE streams
            // cannot become HTTP errors, so emit a terminal error frame. The
            // refund only runs while the reservation is still this scope's to
            // settle — once the billing tail is registered it owns the hold.
            if (!billingTailOwnsSettlement) {
              await settleReservation(0);
            }
            logger.warn("[shared-runtime] stream failed", {
              error: error instanceof Error ? error.message : String(error),
              agentId: rec.id,
            });
            controller.enqueue(
              encoder.encode(chatSseFrame("error", { message: "Shared runtime stream failed" })),
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    } catch (error) {
      // error-policy:J2 context is added by runSharedAgentTurnStream; the bridge
      // boundary only owns releasing the reservation before rethrowing.
      await settleReservation(0);
      throw error;
    }
  }

  /**
   * Read the persisted turn history for a shared-runtime agent's room, keyed by
   * the SAME stable channel id the bridge `message.send` path writes under — so
   * the REST conversation adapter (cloud-api `.../agents/:id/api/*`) returns the
   * exact transcript the bridge produced. `roomId` defaults to the agent id (the
   * canonical single-conversation channel the adapter uses).
   */
  async getSharedConversationHistory(
    agentId: string,
    roomId?: string,
  ): Promise<SharedTurnMessage[]> {
    const channelId = this.stableBridgeChannelId(agentId, {
      roomId: roomId ?? agentId,
    });
    return this.loadSharedRuntimeHistory(agentId, channelId);
  }

  /**
   * Resolve the effective character (name/system/bio/model) for a shared-runtime
   * agent — the SAME `SharedAgentCharacter` the bridge `message.send` turn uses,
   * so the REST `GET .../api/character` adapter returns exactly what the agent
   * answers as. Returns `null` when no running shared sandbox matches the org;
   * a pending Dedicated agent must wait for its container and cannot borrow the
   * Shared runtime.
   */
  async getSharedRuntimeCharacter(
    agentId: string,
    orgId: string,
  ): Promise<SharedAgentCharacter | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (rec && rec.execution_tier === "shared") {
      return this.buildSharedRuntimeCharacter(rec);
    }
    return null;
  }

  /**
   * Post-claim character apply (warm pool). A pool container boots GENERIC
   * (no ELIZA_AGENT_CHARACTER_JSON — agent-warm-pool-creator provisions with
   * empty env), so after `claimWarmContainer` transfers the DB row the RUNNING
   * container would still answer as the default Eliza. This pushes the user's
   * character onto the live runtime via the container's own
   * `PUT /api/character` route (which applies it in-memory, persists it to the
   * agent DB so it survives restarts, and journals character history) — no
   * container restart, no cold boot.
   *
   * Bounded and non-fatal by contract: the CALLER treats a failure as
   * "claim still succeeds, character applies on next container restart"
   * (the row's agent_config feeds ensureRuntimeAgentStarted / the env path on
   * any subsequent boot). Throws on failure so the caller can log the
   * `warm_pool.character_push_failed` event with context.
   */
  async pushClaimedWarmContainerCharacter(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "execution_tier"
    >,
  ): Promise<{ pushed: boolean; agentName?: string }> {
    const tierRejection = containerBackedServiceRejection(rec, "character push");
    if (tierRejection) throw new Error(tierRejection);
    const payload = buildWarmClaimCharacterPayload(rec.agent_config, rec.agent_name);
    if (!payload) return { pushed: false };

    const res = await this.fetchAgentApi(rec, "/api/character", {
      method: "PUT",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WARM_CLAIM_CHARACTER_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Warm-claim character push failed: HTTP ${res.status}`);
    }
    return { pushed: true, agentName: String(payload.name) };
  }

  /**
   * Post-claim inference-credential re-key (warm pool, F0). A pool container
   * boots under the sentinel pool org with a managed cloud inference key
   * scoped to THAT org, so after `claimWarmContainer` transfers the row the
   * RUNNING container still holds the pool-org key and every inference reply is
   * the "key isn't authorized" fallback. This:
   *
   *   1. mints a NEW `agent-sandbox:<claimed-row-id>` inference key scoped to
   *      the claiming user's org;
   *   2. persists that key onto the claimed row's env (`ELIZAOS_CLOUD_API_KEY`)
   *      so restart recovery is always possible;
   *   3. revokes the old `agent-sandbox:<pool-row-id>` credential;
   *   4. pushes the replacement onto the live container via its authenticated
   *      `POST /api/cloud/login/persist` route with `forceInferenceEnabled`,
   *      and requires a fingerprint attestation from runtime-resolved state.
   *
   * Secret handling: the plaintext key rides only in the authed TLS-internal
   * (tailnet) PUT body `fetchAgentApi` uses; it is NEVER logged — the return
   * carries only booleans + a short safe prefix, and the fingerprint exchange
   * carries a sha-256 prefix, never key material.
   *
   * A transport or attestation failure throws. The caller must enqueue restart
   * recovery and must not report the claimed agent as ready.
   */
  async pushClaimedWarmContainerInferenceKey(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "organization_id"
      | "user_id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    > & { warm_pool_row_id: string },
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    // Guard: never re-key a row that is (still) owned by the sentinel pool org.
    // The caller invokes this ONLY after a successful claim, when the row is
    // the user's, but a defensive check here means a pool-org row can never be
    // handed a fresh user-billable key by mistake.
    if (rec.organization_id === WARM_POOL_ORG_ID) {
      throw new Error("Refusing warm-claim key push for a sentinel-pool-org row (not claimed)");
    }
    if (!rec.warm_pool_row_id) {
      throw new Error("Warm-claim key push requires the source agent-sandbox pool row id");
    }

    return await this.completeWarmClaimCredentialHandoff(
      rec.id,
      rec.organization_id,
      rec.warm_pool_row_id,
    );
  }

  /**
   * Retry a durable warm-claim credential handoff after a route/worker crash.
   * The source pool id and target fingerprint live on the sandbox row, so no
   * plaintext credential or request-local state is required for recovery.
   */
  async recoverPendingWarmClaimInferenceKey(
    agentId: string,
    organizationId: string,
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    return await this.completeWarmClaimCredentialHandoff(agentId, organizationId);
  }

  /**
   * Upgrade a pre-fence claimed row into the durable handoff protocol before
   * restart tears down its live container. The row is never declared ready
   * from legacy metadata: the subsequent provision resolves a fresh immutable
   * image digest and recovery remints, pushes, and live-attests a user-org key.
   */
  private async prepareLegacyWarmClaimCredentialRecovery(
    agentId: string,
    organizationId: string,
  ): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (!current.claimed_at) return;
      if (current.warm_claim_credential_state !== null) return;
      if (!["running", "provisioning", "stopped", "error"].includes(current.status)) {
        throw new Error(
          `Legacy warm-claim credential recovery cannot start from ${current.status}`,
        );
      }
      const prepared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'provisioning',
          warm_claim_credential_state = 'pending',
          warm_claim_source_pool_id = NULL,
          warm_claim_key_fingerprint = NULL,
          warm_claim_attested_at = NULL,
          warm_claim_attested_environment_revision = NULL,
          warm_claim_cleanup_completed_at = NULL,
          error_message = 'Legacy warm claim requires credential and image re-attestation',
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status IN ('running', 'provisioning', 'stopped', 'error')
          AND claimed_at IS NOT NULL
          AND warm_claim_credential_state IS NULL
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (prepared.rows.length !== 1) {
        throw new Error("Legacy warm-claim preparation lost its state CAS");
      }
    });
  }

  /**
   * An explicit provision after durable failed-handoff cleanup starts a cold
   * retry. Clearing the claim fence happens under the lifecycle lock only after
   * both retained credential owners were revoked, so cleanup can never revoke a
   * newly minted retry key.
   */
  private async retireFailedWarmClaimForRetry(
    agentId: string,
    organizationId: string,
  ): Promise<{ success: true } | { success: false; error: string }> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (current) {
        const tierRejection = containerBackedServiceRejection(current, "credential");
        if (tierRejection) throw new Error(tierRejection);
      }
      if (
        !current?.claimed_at ||
        current.warm_claim_credential_state !== "failed" ||
        !current.warm_claim_cleanup_completed_at
      ) {
        return {
          success: false as const,
          error: "Warm-claim retry ownership changed before teardown",
        };
      }
      if (!current.sandbox_id && (current.node_id || current.container_name)) {
        return {
          success: false as const,
          error: "Previous warm-claim container locator is incomplete",
        };
      }
      if (current.sandbox_id) {
        const stop = await this.runBoundedSandboxStopForReplacement(current.sandbox_id);
        if (stop) {
          return {
            success: false as const,
            error: "Failed to retire the previous warm-claim container",
          };
        }
      }
      const reset = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          claimed_at = NULL,
          warm_claim_credential_state = NULL,
          warm_claim_source_pool_id = NULL,
          warm_claim_key_fingerprint = NULL,
          warm_claim_attested_at = NULL,
          warm_claim_attested_environment_revision = NULL,
          warm_claim_cleanup_completed_at = NULL,
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          node_id = NULL,
          container_name = NULL,
          headscale_ip = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND claimed_at IS NOT NULL
          AND warm_claim_credential_state = 'failed'
          AND warm_claim_cleanup_completed_at IS NOT NULL
          AND sandbox_id IS NOT DISTINCT FROM ${current.sandbox_id}
          AND node_id IS NOT DISTINCT FROM ${current.node_id}
          AND container_name IS NOT DISTINCT FROM ${current.container_name}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (reset.rows.length !== 1) {
        throw new Error("Failed warm-claim retry lost its cleanup CAS");
      }
      return { success: true as const };
    });
  }

  /**
   * Revoke every credential owner retained by an exhausted handoff. The row
   * remains the durable retry record until both revocations succeed and a
   * lifecycle-locked CAS records cleanup completion.
   */
  async cleanupFailedWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
  ): Promise<boolean> {
    const prepared = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current || current.warm_claim_credential_state !== "failed") {
        return null;
      }
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (current.warm_claim_cleanup_completed_at) {
        return {
          alreadyComplete: true,
          sourcePoolId: null,
          lifecycleRevision: current.lifecycle_revision,
          revoked: [] as Array<{ ownerId: string; hashes: string[] }>,
        };
      }
      const credentialOwners = new Set(
        [agentId, current.warm_claim_source_pool_id].filter((id): id is string => Boolean(id)),
      );
      const revoked: Array<{ ownerId: string; hashes: string[] }> = [];
      for (const credentialOwnerId of credentialOwners) {
        revoked.push({
          ownerId: credentialOwnerId,
          hashes: await apiKeysService.revokeForAgent(credentialOwnerId, tx),
        });
      }
      return {
        alreadyComplete: false,
        sourcePoolId: current.warm_claim_source_pool_id,
        lifecycleRevision: current.lifecycle_revision,
        revoked,
      };
    });
    if (!prepared) return false;
    if (prepared.alreadyComplete) return true;

    for (const { ownerId, hashes } of prepared.revoked) {
      if (hashes.length === 0) continue;
      await apiKeysService.confirmRevocationAfterCommit(hashes);
      await apiKeysService.purgeConfirmedRevokedAgentKeys(ownerId, hashes);
    }

    return await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return false;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.warm_claim_credential_state !== "failed" ||
        current.warm_claim_source_pool_id !== prepared.sourcePoolId ||
        current.lifecycle_revision !== prepared.lifecycleRevision
      ) {
        return Boolean(
          current.warm_claim_credential_state === "failed" &&
            current.warm_claim_cleanup_completed_at,
        );
      }
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          warm_claim_source_pool_id = NULL,
          warm_claim_cleanup_completed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND warm_claim_credential_state = 'failed'
          AND warm_claim_cleanup_completed_at IS NULL
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${prepared.sourcePoolId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${prepared.lifecycleRevision}
        RETURNING id
      `);
      if (result.rows.length === 1) return true;
      throw new Error("Failed warm-claim credential cleanup lost its state CAS");
    });
  }

  private async completeWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
    expectedSourcePoolId?: string,
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    // Every re-key below runs on `tx` for the same reason the managed-launch
    // path does, and the hashes it revokes are collected here so the
    // invalidation can be repeated once the rotation is durable. Only ever
    // read after the transaction resolves.
    const rotatedKeyHashes: string[] = [];
    const prepared = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) {
        throw new Error("Warm-claim key push requires a claimed sandbox row");
      }
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (!current.claimed_at) {
        throw new Error("Warm-claim key push requires a claimed sandbox row");
      }
      if (
        current.warm_claim_credential_state === "ready" &&
        current.status === "running" &&
        current.warm_claim_source_pool_id === null
      ) {
        return { current, plainKey: null, fingerprint: current.warm_claim_key_fingerprint };
      }
      if (current.status !== "provisioning") {
        throw new Error(`Warm-claim credential handoff cannot run from ${current.status}`);
      }
      if (expectedSourcePoolId && current.warm_claim_source_pool_id !== expectedSourcePoolId) {
        throw new Error("Warm-claim source pool row changed before credential handoff");
      }

      const materialized = await decryptAgentEnvVars(current.environment_vars);
      const persistedKey = materialized.ELIZAOS_CLOUD_API_KEY;
      if (current.warm_claim_credential_state === "attested") {
        if (!persistedKey) {
          throw new Error("Attested warm-claim target credential is missing");
        }
        const persistedFingerprint = await warmClaimKeyFingerprint(persistedKey);
        if (
          current.warm_claim_key_fingerprint !== persistedFingerprint ||
          current.warm_claim_attested_environment_revision !== current.environment_revision
        ) {
          // Every raw transition carries the database generation loaded under
          // the lifecycle lock; the trigger advances the returned generation.
          const rows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              warm_claim_credential_state = 'pending',
              warm_claim_key_fingerprint = NULL,
              warm_claim_attested_at = NULL,
              warm_claim_attested_environment_revision = NULL,
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'attested'
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                current.warm_claim_source_pool_id
              }
              AND environment_revision = ${current.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${current.lifecycle_revision}
            RETURNING *
          `);
          const rearmed = rows.rows[0];
          if (!rearmed) {
            throw new Error("Warm-claim re-attestation lost its state CAS");
          }
          const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
            organizationId,
            userId: rearmed.user_id,
            agentSandboxId: rearmed.id,
            tx,
          });
          rotatedKeyHashes.push(...revokedKeyHashes);
          const fingerprint = await warmClaimKeyFingerprint(plainKey);
          const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
            ELIZAOS_CLOUD_API_KEY: plainKey,
            ELIZAOS_CLOUD_ENABLED: "true",
          });
          const remintedRows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
              environment_revision = environment_revision + 1,
              warm_claim_key_fingerprint = ${fingerprint},
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint IS NULL
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                rearmed.warm_claim_source_pool_id
              }
              AND environment_revision = ${rearmed.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${rearmed.lifecycle_revision}
            RETURNING *
          `);
          const reminted = remintedRows.rows[0];
          if (!reminted) {
            throw new Error("Warm-claim credential remint lost its state CAS");
          }
          return {
            current: reminted,
            plainKey,
            fingerprint,
          };
        }
        return { current, plainKey: null, fingerprint: current.warm_claim_key_fingerprint };
      }
      if (
        current.warm_claim_credential_state !== "pending" &&
        current.warm_claim_credential_state !== null
      ) {
        throw new Error(`Warm-claim credential handoff is ${current.warm_claim_credential_state}`);
      }
      if (current.warm_claim_key_fingerprint) {
        if (
          !persistedKey ||
          (await warmClaimKeyFingerprint(persistedKey)) !== current.warm_claim_key_fingerprint
        ) {
          const rows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              warm_claim_key_fingerprint = NULL,
              warm_claim_attested_at = NULL,
              warm_claim_attested_environment_revision = NULL,
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint = ${current.warm_claim_key_fingerprint}
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                current.warm_claim_source_pool_id
              }
              AND environment_revision = ${current.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${current.lifecycle_revision}
            RETURNING *
          `);
          const rearmed = rows.rows[0];
          if (!rearmed) {
            throw new Error("Warm-claim pending credential re-arm lost its state CAS");
          }
          const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
            organizationId,
            userId: rearmed.user_id,
            agentSandboxId: rearmed.id,
            tx,
          });
          rotatedKeyHashes.push(...revokedKeyHashes);
          const fingerprint = await warmClaimKeyFingerprint(plainKey);
          const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
            ELIZAOS_CLOUD_API_KEY: plainKey,
            ELIZAOS_CLOUD_ENABLED: "true",
          });
          const remintedRows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
              environment_revision = environment_revision + 1,
              warm_claim_key_fingerprint = ${fingerprint},
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint IS NULL
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                rearmed.warm_claim_source_pool_id
              }
              AND environment_revision = ${rearmed.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${rearmed.lifecycle_revision}
            RETURNING *
          `);
          const reminted = remintedRows.rows[0];
          if (!reminted) {
            throw new Error("Warm-claim pending credential remint lost its state CAS");
          }
          return { current: reminted, plainKey, fingerprint };
        }
        return {
          current,
          plainKey: persistedKey,
          fingerprint: current.warm_claim_key_fingerprint,
        };
      }

      const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
        organizationId,
        userId: current.user_id,
        agentSandboxId: current.id,
        tx,
      });
      rotatedKeyHashes.push(...revokedKeyHashes);
      const fingerprint = await warmClaimKeyFingerprint(plainKey);
      const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
        ELIZAOS_CLOUD_API_KEY: plainKey,
        ELIZAOS_CLOUD_ENABLED: "true",
      });
      const rows = await tx.execute<AgentSandbox>(sql`
        UPDATE ${agentSandboxes}
        SET
          environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
          environment_revision = environment_revision + 1,
          warm_claim_key_fingerprint = ${fingerprint},
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND claimed_at IS NOT NULL
          AND (
            warm_claim_credential_state = 'pending'
            OR warm_claim_credential_state IS NULL
          )
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING *
      `);
      const updated = rows.rows[0];
      if (!updated) {
        throw new Error("Warm-claim credential persistence lost its state CAS");
      }
      return { current: updated, plainKey, fingerprint };
    });

    // Durable now. Repeat the invalidation the transaction ran while the
    // revoked rows were still visible, so a request that re-cached one in that
    // gap cannot keep authenticating on it. Outstanding carriers are swept in
    // UNCONDITIONALLY: the attested/pending re-use branches above return a
    // persisted key without re-minting, so `rotatedKeyHashes` alone would be
    // empty there and a carrier from a failed earlier attempt would never be
    // re-offered (codex round-4 P1#1).
    {
      const outstandingCarrierHashes = [
        ...new Set([
          ...rotatedKeyHashes,
          ...(await apiKeysService.collectOutstandingRevokedKeyHashes(agentId)),
        ]),
      ];
      if (outstandingCarrierHashes.length > 0) {
        try {
          await apiKeysService.confirmRevocationAfterCommit(outstandingCarrierHashes);
          // Reap EXACTLY what this attempt confirmed — nothing broader.
          await apiKeysService.purgeConfirmedRevokedAgentKeys(agentId, outstandingCarrierHashes);
        } catch (cause) {
          // error-policy:J2 context-adding rethrow — the re-key is committed, so
          // an unconfirmed invalidation leaves a superseded credential possibly
          // live in cache. Surface it rather than report a clean handoff.
          throw new ElizaError(
            "Warm-claim credential handoff could not confirm revocation of the superseded credential",
            {
              code: "WARM_CLAIM_REVOCATION_UNCONFIRMED",
              cause,
              context: {
                agentId,
                organizationId,
                revokedKeyCount: outstandingCarrierHashes.length,
              },
              severity: "fatal",
            },
          );
        }
      }
    }

    if (
      prepared.current.warm_claim_credential_state === "ready" &&
      prepared.current.status === "running"
    ) {
      return {
        pushed: false,
        keyPrefix: prepared.plainKey ? safeKeyPrefix(prepared.plainKey) : undefined,
      };
    }
    if (prepared.current.warm_claim_credential_state === "attested") {
      await this.finalizeWarmClaimCredentialHandoff(
        agentId,
        organizationId,
        prepared.current.warm_claim_source_pool_id,
        prepared.current.warm_claim_key_fingerprint,
        prepared.current.warm_claim_attested_environment_revision,
      );
      return { pushed: false };
    }
    if (!prepared.plainKey || !prepared.fingerprint) {
      throw new Error("Warm-claim target credential is unavailable");
    }

    const body = buildWarmClaimKeyPushBody({
      apiKey: prepared.plainKey,
      organizationId,
      userId: prepared.current.user_id,
    });
    if (!body) {
      // A blank minted key or missing org is a broken mint pipeline. Reporting
      // `pushed: false` here would let the caller advertise an un-re-keyed
      // container as ready — the exact failure class this handoff exists to
      // prevent — so it fails closed like every other handoff fault.
      throw new Error("Warm-claim key push has no usable minted key/org for the claimed row");
    }

    const attestedRevision = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return null;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (current.warm_claim_credential_state === "attested") {
        return current.warm_claim_attested_environment_revision;
      }
      if (
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "pending" ||
        current.warm_claim_key_fingerprint !== prepared.fingerprint ||
        current.warm_claim_source_pool_id !== prepared.current.warm_claim_source_pool_id
      ) {
        return null;
      }
      const currentEnv = await decryptAgentEnvVars(current.environment_vars);
      const currentKey = currentEnv.ELIZAOS_CLOUD_API_KEY;
      if (!currentKey || (await warmClaimKeyFingerprint(currentKey)) !== prepared.fingerprint) {
        return null;
      }
      // Keep the authoritative row lock across the bounded runtime write. A
      // tier transition therefore cannot race the credential PUT and later
      // turn a container-free row into the owner of the runtime side effect.
      const res = await this.fetchAgentApi(
        { ...current, environment_vars: currentEnv },
        "/api/cloud/login/persist",
        {
          method: "POST",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(WARM_CLAIM_KEY_PUSH_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        throw new Error(`Warm-claim key push failed: HTTP ${res.status}`);
      }
      const responseBody = (await res.json()) as {
        ok?: unknown;
        appliedKeyFingerprint?: unknown;
      };
      const echoedFingerprint =
        typeof responseBody.appliedKeyFingerprint === "string"
          ? responseBody.appliedKeyFingerprint
          : undefined;
      if (responseBody.ok !== true || echoedFingerprint !== prepared.fingerprint) {
        throw new Error("Warm-claim key push was not attested by the running runtime");
      }

      const attestedAt = new Date();
      const result = await tx.execute<{ environment_revision: number }>(sql`
        UPDATE ${agentSandboxes}
        SET
          warm_claim_credential_state = 'attested',
          warm_claim_attested_at = ${attestedAt},
          warm_claim_attested_environment_revision = environment_revision,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND warm_claim_credential_state = 'pending'
          AND warm_claim_key_fingerprint = ${prepared.fingerprint}
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
            prepared.current.warm_claim_source_pool_id
          }
          AND environment_revision = ${current.environment_revision}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING environment_revision
      `);
      return result.rows[0]?.environment_revision ?? null;
    });
    if (attestedRevision === null) {
      throw new Error("Warm-claim credential attestation lost its state CAS");
    }
    await this.finalizeWarmClaimCredentialHandoff(
      agentId,
      organizationId,
      prepared.current.warm_claim_source_pool_id,
      prepared.fingerprint,
      attestedRevision,
    );

    return { pushed: true, keyPrefix: safeKeyPrefix(prepared.plainKey) };
  }

  private async finalizeWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
    expectedSourcePoolId: string | null,
    expectedFingerprint: string | null,
    expectedEnvironmentRevision: number | null,
  ): Promise<void> {
    if (!expectedFingerprint || expectedEnvironmentRevision === null) {
      throw new Error("Warm-claim attestation metadata is incomplete");
    }
    const revocation = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (current) {
        const tierRejection = containerBackedServiceRejection(current, "credential");
        if (tierRejection) throw new Error(tierRejection);
      }
      if (
        !current ||
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "attested" ||
        current.warm_claim_source_pool_id !== expectedSourcePoolId ||
        current.warm_claim_key_fingerprint !== expectedFingerprint ||
        current.environment_revision !== expectedEnvironmentRevision ||
        current.warm_claim_attested_environment_revision !== expectedEnvironmentRevision
      ) {
        return null;
      }
      const revokedKeyHashes = expectedSourcePoolId
        ? await apiKeysService.revokeForAgent(expectedSourcePoolId, tx)
        : [];
      return {
        lifecycleRevision: current.lifecycle_revision,
        revokedKeyHashes,
      };
    });
    if (!revocation) {
      throw new Error("Warm-claim source revocation lost its state CAS");
    }

    if (expectedSourcePoolId && revocation.revokedKeyHashes.length > 0) {
      await apiKeysService.confirmRevocationAfterCommit(revocation.revokedKeyHashes);
      await apiKeysService.purgeConfirmedRevokedAgentKeys(
        expectedSourcePoolId,
        revocation.revokedKeyHashes,
      );
    }

    const finalized = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, organizationId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (current) {
        const tierRejection = containerBackedServiceRejection(current, "credential");
        if (tierRejection) throw new Error(tierRejection);
      }
      if (
        current?.status === "running" &&
        current.warm_claim_credential_state === "ready" &&
        current.warm_claim_source_pool_id === null
      ) {
        return true;
      }
      if (
        !current ||
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "attested" ||
        current.warm_claim_source_pool_id !== expectedSourcePoolId ||
        current.warm_claim_key_fingerprint !== expectedFingerprint ||
        current.environment_revision !== expectedEnvironmentRevision ||
        current.warm_claim_attested_environment_revision !== expectedEnvironmentRevision ||
        current.lifecycle_revision !== revocation.lifecycleRevision
      ) {
        return false;
      }
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'running',
          warm_claim_credential_state = 'ready',
          warm_claim_source_pool_id = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND warm_claim_credential_state = 'attested'
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${expectedSourcePoolId}
          AND warm_claim_key_fingerprint = ${expectedFingerprint}
          AND environment_revision = ${expectedEnvironmentRevision}
          AND warm_claim_attested_environment_revision = ${expectedEnvironmentRevision}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${revocation.lifecycleRevision}
        RETURNING id
      `);
      return result.rows.length === 1;
    });
    if (!finalized) {
      throw new Error("Warm-claim credential finalization lost its state CAS");
    }
  }

  // Bridge

  async bridge(
    agentId: string,
    orgId: string,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<BridgeResponse> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Bridge call to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox is not running" },
      };
    }

    try {
      if (rec.execution_tier === "shared") {
        if (rpc.method === "status.get" || rpc.method === "heartbeat") {
          return await this.bridgeSharedStatus(rec, rpc);
        }
        if (rpc.method === "message.send") {
          return await this.bridgeSharedMessageSend(rec, rpc, executionCtx);
        }
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
      }

      if (!rec.bridge_url) {
        logger.warn("[agent-sandbox] Bridge call to running sandbox without bridge URL", {
          agentId,
          method: rpc.method,
        });
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "Sandbox is not running" },
        };
      }

      if (rpc.method === "status.get" || rpc.method === "heartbeat") {
        return await this.bridgeStatus(rec, rpc);
      }
      if (rpc.method === "message.send") {
        return await this.bridgeMessageSend(rec, rpc);
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
    } catch {
      logger.warn("[agent-sandbox] Bridge request failed", {
        agentId,
        method: rpc.method,
        failureClass: "sandbox_bridge_failed",
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
  }

  private async bridgeStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const runtimeAgents = await this.listRuntimeAgents(rec);
    if (runtimeAgents.supported) {
      const agent = this.selectRuntimeAgent(runtimeAgents.agents);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          status: agent?.status ?? (agent ? "running" : "starting"),
          ready: this.isRuntimeAgentReady(agent),
          agentId: rec.id,
          runtimeAgentId: agent?.id,
          agentName: agent?.name,
        },
      };
    }

    const rootRes = await this.fetchAgentWeb(rec, "/", {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (!rootRes.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: `Bridge returned HTTP ${rootRes.status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        runtime: "web",
        chat: true,
      },
    };
  }

  private async bridgeMessageSend(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const canonicalConversationId =
      typeof params.conversationId === "string" && params.conversationId.trim()
        ? params.conversationId.trim()
        : null;
    if (canonicalConversationId) {
      // Cutover connectors name the imported conversation explicitly. Do not
      // fall through to a newly-created REST conversation or another bridge
      // surface: either this exact history accepts the turn, or delivery fails
      // closed and the provider retries the same clientMessageId.
      return await this.bridgeConversationMessageSend(rec, rpc, params, canonicalConversationId);
    }

    const attempts = [
      // Try the cloud-agent image's native /bridge JSON-RPC first. This is
      // the canonical surface served by packages/app-core/deploy/cloud-agent-shared.ts.
      // It returns 200 with {result:{text}} on success, 500 with
      // {error:{message}} on runtime failures (e.g. no LLM key). When an
      // image doesn't expose /bridge (public ghcr.io/elizaos/eliza compatibility
      // image) it 404s and we fall through to the REST attempts below.
      () => this.bridgeNativeJsonRpcSend(rec, rpc, params),
      () => this.bridgeConversationMessageSend(rec, rpc, params),
      () => this.bridgeOpenAiChatCompletionSend(rec, rpc, params),
      () => this.bridgeCentralChannelMessageSend(rec, rpc, params),
    ];
    let lastResponse: BridgeResponse | null = null;

    for (const attempt of attempts) {
      try {
        const response = await attempt();
        if (this.bridgeResponseHasText(response)) {
          return response;
        }
        lastResponse = response;
      } catch (error) {
        if (error instanceof BridgeRouteUnavailableError) {
          continue;
        }
        throw error;
      }
    }

    if (lastResponse?.error) {
      return lastResponse;
    }
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);
    if (fallbackText) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: fallbackText,
          fallback: true,
          reason: "agent_no_reply",
          transport: "fallback",
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32000,
        message: "Bridge message produced an empty response",
      },
    };
  }

  // Deliberately text-only: a runtime-side canned failure reply (result carries
  // `failureKind`, e.g. "provider issue" / credits-depleted text from
  // packages/agent chat routes) still short-circuits the ladder. Production
  // consumers (agent-gateway connectors, provisioning jobs, the REST adapters)
  // surface that designed failure text to end users; falling through would
  // replace it with the fabricated generic fallback and add up to ~50s of
  // central-channel polling per failed turn. Strict callers (the e2e chat
  // scripts) reject on the propagated `failureKind` instead (#15616).
  private bridgeResponseHasText(response: BridgeResponse): boolean {
    return typeof response.result?.text === "string" && response.result.text.trim().length > 0;
  }

  /**
   * The agent runtime's conversation route answers HTTP 200 with canned text
   * plus a `failureKind` discriminator when the model path is dead (provider
   * issue, rate limit, credit exhaustion, no provider). Surface it so callers
   * can tell a genuine model reply from a canned failure (#15616).
   */
  private extractBridgeFailureKind(body: Record<string, unknown>): string | undefined {
    return typeof body.failureKind === "string" && body.failureKind.trim()
      ? body.failureKind.trim()
      : undefined;
  }

  /**
   * Native JSON-RPC POST to the cloud-agent image's `/bridge` endpoint.
   * Source: packages/app-core/deploy/cloud-agent-shared.ts (the handler this
   * proxies to). Returns the agent's reply unchanged on 200, propagates
   * runtime errors as JSON-RPC error envelopes on 500, throws
   * BridgeRouteUnavailableError on 404 so callers fall through to legacy
   * REST endpoints (the public ghcr.io/elizaos/eliza image doesn't expose
   * /bridge).
   */
  private async bridgeNativeJsonRpcSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    _params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    if (!rec.bridge_url) {
      throw new BridgeRouteUnavailableError("Sandbox has no bridge_url", 0);
    }
    const res = await this.fetchAgentApi(rec, "/bridge", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        method: "message.send",
        params: rpc.params ?? {},
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Cloud-agent /bridge route not present (legacy image?)",
        res.status,
      );
    }
    // Parse envelope; cloud-agent returns valid JSON-RPC on both 200 and 500.
    const body = (await res.json().catch((error) => {
      logger.warn("[agent-sandbox] Failed to parse native bridge JSON-RPC body", {
        agentId: rec.id,
        status: res.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    })) as {
      jsonrpc?: string;
      id?: unknown;
      result?: { text?: string };
      error?: { code?: number; message?: string };
    } | null;
    if (!body || body.jsonrpc !== "2.0") {
      throw new BridgeRouteUnavailableError(
        `Cloud-agent /bridge returned non-JSON-RPC body (status ${res.status})`,
        res.status,
      );
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      ...(body.result
        ? {
            result: {
              ...(body.result as Record<string, unknown>),
              transport: "native-jsonrpc",
            } as BridgeResponse["result"],
          }
        : {}),
      ...(body.error ? { error: body.error as BridgeResponse["error"] } : {}),
    };
  }

  private async bridgeConversationMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
    canonicalConversationId?: string,
  ): Promise<BridgeResponse> {
    const conversationId =
      canonicalConversationId ?? (await this.createBridgeConversation(rec, params));
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
    const init = {
      method: "POST",
      body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    } satisfies RequestInit;
    const res = canonicalConversationId
      ? await this.fetchCanonicalConversationApi(rec, path, init, params.canonicalBridgeBase)
      : await this.fetchAgentApi(rec, path, init);
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const failureKind = this.extractBridgeFailureKind(body);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractBridgeMessageText(body) ?? "",
        agentName: typeof body.agentName === "string" ? body.agentName : undefined,
        conversationId,
        transport: "conversation-rest",
        ...(failureKind ? { failureKind } : {}),
      },
    };
  }

  /**
   * Recreates an authoritative cutover conversation after a Dedicated runtime
   * loses its local conversation index during relocation or fresh boot. Exact
   * source ids make concurrent repairs idempotent at the runtime boundary.
   */
  async importCanonicalConversation(
    agentId: string,
    orgId: string,
    conversationId: string,
    messages: Array<{
      sourceId: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
    }>,
  ): Promise<{
    complete: true;
    sourceMessageCount: number;
    inserted: number;
    skipped: number;
  } | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) return null;
    const serverSecret = getCloudAwareEnv().AGENT_SERVER_SHARED_SECRET?.trim();
    if (!serverSecret) return null;

    const res = await this.fetchCanonicalConversationApi(
      rec,
      `/api/conversations/${encodeURIComponent(conversationId)}/import`,
      {
        method: "POST",
        headers: { "X-Server-Token": serverSecret },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(20_000),
      },
      rec.bridge_url,
    );
    if (!res.ok) return null;

    // error-policy:J3 an unreadable import receipt is explicitly invalid and
    // cannot authorize the connector retry.
    const body = (await res.json().catch(() => null)) as {
      conversationId?: unknown;
      complete?: unknown;
      sourceMessageCount?: unknown;
      inserted?: unknown;
      skipped?: unknown;
    } | null;
    if (!body || typeof body.inserted !== "number" || typeof body.skipped !== "number") {
      return null;
    }
    const inserted = body.inserted;
    const skipped = body.skipped;
    const countsMatch = inserted + skipped === messages.length;
    const modernReceipt = body?.complete === true && body.sourceMessageCount === messages.length;
    const legacyReceipt =
      body?.complete === undefined &&
      body.sourceMessageCount === undefined &&
      body.conversationId === conversationId;
    if (!countsMatch || (!modernReceipt && !legacyReceipt)) {
      return null;
    }
    return {
      complete: true,
      sourceMessageCount: messages.length,
      inserted,
      skipped,
    };
  }

  private async bridgeMessagingSessionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const sessionId = await this.createBridgeMessagingSession(rec, runtimeAgent.id, params);
    const res = await this.fetchAgentApi(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(this.buildBridgeSessionMessageBody(params)),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const agentText = await this.waitForBridgeSessionAgentReply(rec, sessionId, runtimeAgent.id);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        sessionId,
        messageId: typeof body.id === "string" ? body.id : undefined,
      },
    };
  }

  private async bridgeCentralChannelMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const channelId = this.stableBridgeChannelId(runtimeAgent.id, params);
    const res = await this.fetchAgentApi(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(this.buildBridgeCentralChannelMessageBody(params, runtimeAgent.id)),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Central channel messaging API is unavailable",
        res.status,
      );
    }
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = this.nestedBridgeRecord(body.data) ?? {};
    const agentText = await this.waitForBridgeCentralChannelAgentReply(
      rec,
      channelId,
      runtimeAgent.id,
    );
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        channelId,
        transport: "central-channel",
        messageId:
          typeof data.id === "string" ? data.id : typeof body.id === "string" ? body.id : undefined,
      },
    };
  }

  private async bridgeOpenAiChatCompletionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) {
      throw new BridgeRouteUnavailableError("OpenAI chat compatibility API is unavailable", status);
    }
    if (status < 200 || status >= 300) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractOpenAiChatCompletionText(body) ?? "",
        model: typeof body.model === "string" ? body.model : undefined,
        completionId: typeof body.id === "string" ? body.id : undefined,
        transport: "openai-compat",
      },
    };
  }

  private async requestBridgeOpenAiChatCompletion(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchAgentApi(rec, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(this.buildBridgeOpenAiChatBody(params)),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  private buildBridgeOpenAiChatBody(params: Record<string, unknown>): Record<string, unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId.trim() : "default";
    const userId =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : this.stableBridgeUserId(params);
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud";

    return {
      model: "eliza",
      messages: [{ role: "user", content: text }],
      user: roomId,
      metadata: {
        conversation_id: roomId,
        user_id: userId,
        source,
        bridgeRoomId: roomId,
      },
    };
  }

  private buildBridgeNoReplyFallbackText(params: Record<string, unknown>): string | null {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) return null;

    const lower = text.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lower.length) {
      const start = lower.indexOf("exact word", searchFrom);
      if (start === -1) break;
      searchFrom = start + 1;
      const preceding = start > 0 ? lower.charCodeAt(start - 1) : 0;
      const precededByWord =
        (preceding >= 48 && preceding <= 57) ||
        (preceding >= 97 && preceding <= 122) ||
        preceding === 95;
      if (precededByWord) continue;

      let cursor = start + "exact word".length;
      if (lower.charCodeAt(cursor) === 115) cursor++;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (lower.charCodeAt(cursor) !== 58) continue;
      cursor++;
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor++;

      let end = text.length;
      while (end > cursor && /\s/.test(text[end - 1] ?? "")) end--;
      if (cursor < end && (text[cursor] === '"' || text[cursor] === "'")) cursor++;
      if (cursor < end && (text[end - 1] === '"' || text[end - 1] === "'")) end--;
      const exact = text.slice(cursor, end).trim();
      if (exact && !exact.includes("\n") && !exact.includes("\r")) return exact;
    }

    searchFrom = 0;
    while (searchFrom < lower.length) {
      const start = lower.indexOf("reply", searchFrom);
      if (start === -1) break;
      searchFrom = start + 1;
      const preceding = start > 0 ? lower.charCodeAt(start - 1) : 0;
      const precededByWord =
        (preceding >= 48 && preceding <= 57) ||
        (preceding >= 97 && preceding <= 122) ||
        preceding === 95;
      if (precededByWord) continue;

      let cursor = start + "reply".length;
      const whitespaceStart = cursor;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (cursor === whitespaceStart) continue;
      if (lower.startsWith("briefly", cursor)) {
        cursor += "briefly".length;
        const brieflyWhitespaceStart = cursor;
        while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
        if (cursor === brieflyWhitespaceStart) continue;
      }
      if (!lower.startsWith("with", cursor)) continue;
      cursor += "with".length;
      const withWhitespaceStart = cursor;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (cursor === withWhitespaceStart) continue;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") continue;
      const singleQuoteClose = text.indexOf("'", cursor + 1);
      const doubleQuoteClose = text.indexOf('"', cursor + 1);
      const close =
        singleQuoteClose === -1
          ? doubleQuoteClose
          : doubleQuoteClose === -1
            ? singleQuoteClose
            : Math.min(singleQuoteClose, doubleQuoteClose);
      if (close === -1) continue;
      const reply = text.slice(cursor + 1, close).trim();
      if (reply) return reply;
    }

    return "Agent runtime is online, but no model response was produced before the cloud bridge timeout.";
  }

  private async createBridgeConversation(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<string> {
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source : "cloud";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId : "default";
    const res = await this.fetchAgentApi(rec, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        title: `${source}:${roomId}`.slice(0, 120),
        metadata: { scope: "general" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new BridgeRouteUnavailableError("Conversation API is unavailable", res.status);
      }
      throw new Error(`Bridge conversation create returned HTTP ${res.status}`);
    }

    const body = (await res.json().catch(() => ({}))) as {
      conversation?: { id?: unknown };
    };
    const conversationId = body.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId.trim()) {
      throw new Error("Bridge conversation create response was missing conversation.id");
    }
    return conversationId;
  }

  private async createBridgeMessagingSession(
    rec: AgentSandbox,
    runtimeAgentId: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const res = await this.fetchAgentApi(rec, "/api/messaging/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: runtimeAgentId,
        userId: this.stableBridgeUserId(params),
        metadata: {
          source:
            typeof params.source === "string" && params.source.trim()
              ? params.source.trim()
              : "cloud",
          roomId: typeof params.roomId === "string" ? params.roomId : undefined,
          sender:
            params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
              ? params.sender
              : undefined,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError("Messaging sessions API is unavailable", res.status);
    }
    if (!res.ok) {
      throw new Error(`Bridge session create returned HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (!sessionId) {
      throw new Error("Bridge session create response was missing sessionId");
    }
    return sessionId;
  }

  private buildBridgeConversationMessageBody(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      text: typeof params.text === "string" ? params.text : "",
      source:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
        bridgeSender:
          params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
            ? params.sender
            : undefined,
      },
    };
    if (params.channelType === "GROUP") {
      body.channelType = "GROUP";
    } else {
      body.channelType = "DM";
    }
    if (params.mode === "power") {
      body.conversationMode = "power";
    } else {
      body.conversationMode = "simple";
    }
    if (typeof params.clientMessageId === "string" && params.clientMessageId.trim()) {
      body.clientMessageId = params.clientMessageId.trim();
    }
    return body;
  }

  private buildBridgeSessionMessageBody(params: Record<string, unknown>): Record<string, unknown> {
    return {
      content: typeof params.text === "string" ? params.text : "",
      attachments: Array.isArray(params.attachments) ? params.attachments : undefined,
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
    };
  }

  private buildBridgeCentralChannelMessageBody(
    params: Record<string, unknown>,
    runtimeAgentId: string,
  ): Record<string, unknown> {
    const metadata =
      params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { ...(params.metadata as Record<string, unknown>) }
        : {};
    const sender =
      params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
        ? (params.sender as Record<string, unknown>)
        : {};
    const displayName =
      typeof sender.displayName === "string" && sender.displayName.trim()
        ? sender.displayName.trim()
        : typeof sender.name === "string" && sender.name.trim()
          ? sender.name.trim()
          : "Cloud User";

    return {
      author_id: this.stableBridgeUserId(params),
      content: typeof params.text === "string" ? params.text : "",
      server_id: DEFAULT_CENTRAL_SERVER_ID,
      raw_message: {
        text: typeof params.text === "string" ? params.text : "",
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
      },
      metadata: {
        ...metadata,
        isDm: true,
        channelType: "DM",
        targetUserId: runtimeAgentId,
        user_display_name: displayName,
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
      source_type:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
    };
  }

  private getBridgeMessages(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== "object") return [];

    const root = body as Record<string, unknown>;
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const result =
      root.result && typeof root.result === "object"
        ? (root.result as Record<string, unknown>)
        : {};

    for (const candidate of [
      root.messages,
      root.items,
      data.messages,
      data.items,
      result.messages,
      result.items,
    ]) {
      if (Array.isArray(candidate)) return candidate;
    }

    return [];
  }

  private normalizeBridgeRole(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  private bridgeRoleIsAgent(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "assistant" ||
      role === "agent" ||
      role === "bot" ||
      role === "ai" ||
      role === "model" ||
      role === "assistant_message" ||
      role === "agent_message"
    );
  }

  private bridgeRoleIsUser(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "user" ||
      role === "human" ||
      role === "client" ||
      role === "owner" ||
      role === "user_message" ||
      role === "client_message"
    );
  }

  private bridgeMessageIdMatches(value: unknown, runtimeAgentId?: string): boolean {
    return (
      typeof runtimeAgentId === "string" &&
      runtimeAgentId.length > 0 &&
      typeof value === "string" &&
      value === runtimeAgentId
    );
  }

  private nestedBridgeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private isBridgeAgentMessage(message: Record<string, unknown>, runtimeAgentId?: string): boolean {
    if (message.isAgent === true || message.fromAgent === true || message.isBot === true) {
      return true;
    }
    if (message.isAgent === false || message.fromAgent === false || message.isBot === false) {
      return false;
    }
    const sourceType = this.normalizeBridgeRole(message.sourceType ?? message.source_type);
    if (sourceType === "agent_response") {
      return true;
    }

    for (const key of ["role", "type", "senderType", "senderRole", "authorRole", "messageType"]) {
      const value = message[key];
      if (this.bridgeRoleIsAgent(value)) return true;
      if (this.bridgeRoleIsUser(value)) return false;
    }

    for (const key of ["sender", "author", "from", "entity", "metadata"]) {
      const nested = this.nestedBridgeRecord(message[key]);
      if (!nested) continue;
      if (nested.isAgent === true || nested.fromAgent === true || nested.isBot === true)
        return true;
      if (nested.isAgent === false || nested.fromAgent === false || nested.isBot === false) {
        return false;
      }
      for (const nestedKey of ["role", "type", "senderType", "authorRole"]) {
        const nestedValue = nested[nestedKey];
        if (this.bridgeRoleIsAgent(nestedValue)) return true;
        if (this.bridgeRoleIsUser(nestedValue)) return false;
      }
      for (const nestedIdKey of ["id", "entityId", "agentId", "runtimeAgentId", "senderId"]) {
        if (this.bridgeMessageIdMatches(nested[nestedIdKey], runtimeAgentId)) return true;
      }
    }

    for (const idKey of ["entityId", "agentId", "runtimeAgentId", "senderId", "authorId"]) {
      if (this.bridgeMessageIdMatches(message[idKey], runtimeAgentId)) return true;
    }

    return false;
  }

  private extractBridgeTextValue(value: unknown, depth = 0): string | null {
    if (depth > 4) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => this.extractBridgeTextValue(item, depth + 1))
        .filter((text): text is string => Boolean(text));
      return parts.length > 0 ? parts.join("") : null;
    }

    const record = this.nestedBridgeRecord(value);
    if (!record) return null;

    for (const key of [
      "text",
      "fullText",
      "content",
      "message",
      "body",
      "reply",
      "response",
      "value",
    ]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    for (const key of ["parts", "items", "chunks"]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    return null;
  }

  private extractBridgeMessageText(message: Record<string, unknown>): string | null {
    for (const key of ["text", "fullText", "content", "message", "body", "reply", "response"]) {
      const text = this.extractBridgeTextValue(message[key]);
      if (text) return text;
    }
    return null;
  }

  private extractBridgeErrorMessage(body: Record<string, unknown>): string | null {
    const error = this.nestedBridgeRecord(body.error);
    if (error) {
      const message = this.extractBridgeTextValue(error.message);
      if (message) return message;
      const text = this.extractBridgeTextValue(error);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body.message) ?? this.extractBridgeTextValue(body);
  }

  private extractOpenAiChatCompletionText(body: Record<string, unknown>): string | null {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    for (const choice of choices) {
      const choiceRecord = this.nestedBridgeRecord(choice);
      if (!choiceRecord) continue;
      const message = this.nestedBridgeRecord(choiceRecord.message);
      if (message) {
        const content = this.extractBridgeTextValue(message.content);
        if (content) return content;
      }
      const text = this.extractBridgeTextValue(choiceRecord.text);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body);
  }

  private async waitForBridgeSessionAgentReply(
    rec: AgentSandbox,
    sessionId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await this.fetchAgentApi(
        rec,
        `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`,
        {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.slice().reverse()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  private async waitForBridgeCentralChannelAgentReply(
    rec: AgentSandbox,
    channelId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await this.fetchAgentApi(
        rec,
        `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages?limit=30`,
        {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.slice().reverse()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  /**
   * Proxy an HTTP request to the agent's wallet API endpoint.
   * Used by the cloud backend to forward wallet/steward requests from the dashboard.
   *
   * @param agentId  - The sandbox record ID
   * @param orgId    - The organization ID (authorization)
   * @param walletPath - Path after `/api/wallet/`, e.g. "steward-policies"
   * @param method   - HTTP method ("GET" | "POST")
   * @param body     - Optional request body (for POST requests)
   * @param query    - Optional query string (e.g. "limit=20")
   * @returns The raw fetch Response, or null if the sandbox is not running
   */
  // Allowed wallet sub-paths for proxy (prevents path traversal)
  private static readonly ALLOWED_WALLET_PATHS = new Set([
    "addresses",
    "balances",
    "steward-status",
    "steward-policies",
    "steward-tx-records",
    "steward-pending-approvals",
    "steward-approve-tx",
    "steward-deny-tx",
  ]);

  // Allowed query parameters for wallet proxy
  private static readonly ALLOWED_QUERY_PARAMS = new Set([
    "limit",
    "offset",
    "cursor",
    "type",
    "status",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_PATHS = new Set([
    "observations",
    "merged-state",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS = new Set([
    "timezone",
    "scope",
    "refresh",
  ]);

  // Anchored regex: only the agent's known plugin-workflow surface is forwarded.
  // Source of truth: plugins/plugin-workflow/src/plugin-routes.ts.
  // Intentionally additive paths (executions/:id, :id/run) are forwarded too so
  // the cloud surface is ready when the plugin mounts them; until then the
  // agent will respond 404 and the cloud relays that 404 unchanged.
  private static readonly ALLOWED_WORKFLOW_PATH_PATTERNS: readonly RegExp[] = [
    /^workflows$/,
    /^workflows\/generate$/,
    /^workflows\/resolve-clarification$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/activate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/deactivate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/run$/,
    /^executions$/,
    /^executions\/[a-zA-Z0-9_-]{1,128}$/,
    /^status$/,
  ];

  private static readonly ALLOWED_WORKFLOW_QUERY_PARAMS = new Set([
    "limit",
    "cursor",
    "status",
    "workflowId",
  ]);

  async proxyWorkflowRequest(
    agentId: string,
    orgId: string,
    workflowPath: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_WORKFLOW_PATH_PATTERNS.some((re) => re.test(workflowPath))) {
      logger.warn("[agent-sandbox] Rejected workflow proxy: invalid path", {
        agentId,
        workflowPath,
      });
      return new Response(JSON.stringify({ error: "Invalid workflow endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_WORKFLOW_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Workflow proxy: sandbox not found or not running", {
        agentId,
        orgId,
        workflowPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Workflow proxy: no bridge_url", {
        agentId,
        status: rec.status,
        workflowPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/workflow/${workflowPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (method !== "GET" && method !== "DELETE") {
        headers["Content-Type"] = "application/json";
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if ((method === "POST" || method === "PUT") && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Workflow proxy request failed", {
        agentId,
        workflowPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyWalletRequest(
    agentId: string,
    orgId: string,
    walletPath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    // Validate wallet path against whitelist (prevents path traversal)
    if (!ElizaSandboxService.ALLOWED_WALLET_PATHS.has(walletPath)) {
      logger.warn("[agent-sandbox] Rejected wallet proxy: invalid path", {
        agentId,
        walletPath,
      });
      return new Response(JSON.stringify({ error: "Invalid wallet endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sanitize query parameters
    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Wallet proxy: sandbox not found or not running", {
        agentId,
        orgId,
        walletPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Wallet proxy: no bridge_url", {
        agentId,
        status: rec.status,
        walletPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/wallet/${walletPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Wallet proxy request failed", {
        agentId,
        walletPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyLifeOpsScheduleRequest(
    agentId: string,
    orgId: string,
    schedulePath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_PATHS.has(schedulePath)) {
      logger.warn("[agent-sandbox] Rejected schedule proxy: invalid path", {
        agentId,
        schedulePath,
      });
      return new Response(JSON.stringify({ error: "Invalid schedule endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Schedule proxy: sandbox not found or not running", {
        agentId,
        orgId,
        schedulePath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Schedule proxy: no bridge_url", {
        agentId,
        status: rec.status,
        schedulePath,
      });
      return null;
    }

    try {
      const fullPath = `/api/lifeops/schedule/${schedulePath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await this.fetchAgentApi(rec, fullPath, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Schedule proxy request failed", {
        agentId,
        schedulePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async bridgeStream(
    agentId: string,
    orgId: string,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<Response | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Bridge stream to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);

    if (rec.execution_tier === "shared") {
      const response = await this.bridgeSharedMessageStream(rec, rpc, executionCtx);
      return response ?? (fallbackText ? this.createBridgeSseTextResponse(fallbackText) : null);
    }

    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Bridge stream to running sandbox without bridge URL", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    try {
      const conversationId = await this.createBridgeConversation(rec, params);
      const res = await this.fetchAgentApi(
        rec,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
        {
          method: "POST",
          body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (res.ok) return this.normalizeBridgeSseResponse(res);
      if (res.status !== 404) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          status: res.status,
        });
      }
    } catch (error) {
      if (!(error instanceof BridgeRouteUnavailableError)) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          method: rpc.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      return await this.bridgeOpenAiChatCompletionSse(rec, params);
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream compatibility request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const centralResponse = await this.bridgeCentralChannelMessageSend(rec, rpc, params);
      if (this.bridgeResponseHasText(centralResponse)) {
        return this.createBridgeSseTextResponse(centralResponse.result!.text as string);
      }
      if (centralResponse.error) {
        return this.createBridgeSseErrorResponse(centralResponse.error.message);
      }
      if (fallbackText) {
        return this.createBridgeSseTextResponse(fallbackText);
      }
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream central-channel request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (fallbackText) {
      return this.createBridgeSseTextResponse(fallbackText);
    }

    return null;
  }

  private async bridgeOpenAiChatCompletionSse(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<Response | null> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      return this.createBridgeSseErrorResponse(
        this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
      );
    }

    const text = this.extractOpenAiChatCompletionText(body);
    if (!text) {
      return null;
    }
    return this.createBridgeSseTextResponse(text);
  }

  private createBridgeSseTextResponse(text: string): Response {
    const messageId = crypto.randomUUID();
    const chunk = {
      messageId,
      chunk: text,
      text,
      fullText: text,
      timestamp: Date.now(),
    };
    return new Response(
      chatSseFrame("chunk", chunk) + chatSseFrame("done", { messageId, text, fullText: text }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      },
    );
  }

  normalizeBridgeSseResponse(response: Response): Response {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    const messageId = crypto.randomUUID();
    // Accumulate across frames: a delta-v2 agent (client `streamProtocol` can
    // ride through the bridge to it) ships bare `{type:"token",text}` deltas and
    // resends `fullText` only on a periodic snapshot, so the downstream
    // `fullText`/done text must be rebuilt here, not read off each frame.
    let accumulated = "";
    let pending = "";
    const findEventBreak = (value: string) => {
      const lfBreak = value.indexOf("\n\n");
      const crlfBreak = value.indexOf("\r\n\r\n");
      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak ? { index: lfBreak, length: 2 } : { index: crlfBreak, length: 4 };
    };
    const emitFrame = (frame: string, controller: TransformStreamDefaultController<string>) => {
      if (!frame.trim()) return;
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) {
        controller.enqueue(`${frame}\n\n`);
        return;
      }
      try {
        const data = JSON.parse(dataLine.slice(5).trimStart());
        if (data?.type === "token") {
          const delta = typeof data.text === "string" ? data.text : "";
          accumulated = typeof data.fullText === "string" ? data.fullText : accumulated + delta;
          controller.enqueue(
            chatSseFrame("chunk", {
              messageId,
              chunk: delta,
              text: delta,
              fullText: accumulated,
              timestamp: Date.now(),
            }),
          );
          return;
        }
        if (data?.type === "done") {
          controller.enqueue(
            chatSseFrame(
              "done",
              normalizeChatSseDonePayload(data, {
                messageId,
                fullText: accumulated,
              }),
            ),
          );
          return;
        }
      } catch {
        // error-policy:J3 untrusted SSE frames are invalid for normalization and pass through unchanged.
      }
      controller.enqueue(`${frame}\n\n`);
    };
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (chunk, controller) => {
            pending += chunk;
            let eventBreak = findEventBreak(pending);
            while (eventBreak) {
              const frame = pending.slice(0, eventBreak.index);
              pending = pending.slice(eventBreak.index + eventBreak.length);
              emitFrame(frame, controller);
              eventBreak = findEventBreak(pending);
            }
          },
          flush: (controller) => {
            if (pending.trim()) emitFrame(pending, controller);
            pending = "";
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  }

  private createBridgeSseErrorResponse(message: string): Response {
    return new Response(chatSseFrame("error", { message }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  // Snapshots

  async snapshot(
    agentId: string,
    orgId: string,
    type: AgentBackupSnapshotType = "manual",
  ): Promise<SnapshotResult> {
    // Both repository seams read the tenant-scoped primary. This is only an
    // early snapshot for avoiding network work, never a lock or CAS: authority
    // is re-read under the lifecycle lock after capture and backup planning.
    const rec =
      (await agentSandboxesRepository.findRunningSandbox(agentId, orgId)) ??
      (await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId));
    if (!rec) return { success: false, error: "Sandbox is not running" };

    const initialAuthorityRejection = snapshotAuthorityRejection(rec);
    if (initialAuthorityRejection) {
      return { success: false, error: initialAuthorityRejection };
    }
    if (rec.status !== "running" || !rec.bridge_url) {
      return { success: false, error: "Sandbox is not running" };
    }

    let stateData: AgentBackupStateData;
    let sizeBytes: number;
    try {
      ({ stateData, sizeBytes } = await this.fetchSnapshotState(rec));
    } catch (error) {
      // A bridge that lacks /api/snapshot (V2 image) returns the sentinel; an
      // auto backup against it is a benign skip, so surface it as a result the
      // snapshot job recognizes instead of a thrown, retried failure. All other
      // errors (real fetch/transport failures) still propagate.
      const message = error instanceof Error ? error.message : String(error);
      if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
        return { success: false, error: SNAPSHOT_ENDPOINT_UNSUPPORTED };
      }
      if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
        return {
          success: false,
          error: SNAPSHOT_CAPTURE_TRANSIENT,
          retryable: true,
        };
      }
      throw error;
    }

    // Both labels gate a destructive follow-up — a rollback replays the
    // `pre-upgrade` point, and a relocation destroys the source container once
    // the `pre-move` capture is restored elsewhere. A partial capture would
    // survive either as silent data loss, so neither is accepted without a
    // full-agent manifest.
    if ((type === "pre-upgrade" || type === "pre-move") && !stateData.manifest) {
      return {
        success: false,
        error: `${type} snapshot did not include a full-agent manifest`,
      };
    }

    // Capture and incremental/full planning intentionally stay outside the
    // lifecycle transaction. No durable backup preparation or write begins
    // until the locked canonical row proves this exact capture still owns the
    // same running container generation.
    const plannedInput = await this.buildBackupInput(rec.id, type, stateData, sizeBytes);
    const persisted = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        return { success: false as const, error: SNAPSHOT_AUTHORITY_CHANGED };
      }

      const currentAuthorityRejection = snapshotAuthorityRejection(current);
      if (currentAuthorityRejection) {
        return { success: false as const, error: currentAuthorityRejection };
      }
      if (current.status !== "running") {
        return { success: false as const, error: "Sandbox is not running" };
      }
      if (!snapshotCaptureStillCanonical(current, rec)) {
        return { success: false as const, error: SNAPSHOT_AUTHORITY_CHANGED };
      }

      const storedBackup = await this.persistAuthorizedSnapshotWithinTransaction(
        tx,
        current,
        orgId,
        type,
        plannedInput,
      );
      return { success: true as const, storedBackup };
    });

    if (!persisted.success) return persisted;

    const backup = await hydrateAgentSandboxBackup(persisted.storedBackup);
    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS);
    logger.info("[agent-sandbox] Backup created", {
      agentId,
      type,
      kind: backup.backup_kind,
      bytes: backup.size_bytes,
    });
    return { success: true, backup };
  }

  /**
   * Carry an agent's durable state from the container it runs on today onto a
   * replacement container on another node.
   *
   * This exists because a blue/green replacement moves the CONTAINER, not the
   * state. Agent volumes are host bind-mounts (`/data/agents/<id>` mounted at
   * `/root/.eliza`), so the pglite data directory does not follow a container
   * to a new machine, and the `pre-upgrade` snapshot the upgrade path takes is
   * only a rollback point — it is never pushed into the new container. A
   * relocation built on the upgrade sequence alone would therefore start the
   * agent on an empty database and destroy the old one on cutover.
   *
   * The only cross-node transport is the application-level snapshot/restore
   * rail, which is node-agnostic by construction. This method is that rail,
   * with the ordering that makes it safe:
   *
   *   1. capture from the OLD container while it is still live and serving;
   *   2. reconstruct, so a backup that cannot be replayed is caught here;
   *   3. push onto the new container.
   *
   * It never reports success without a completed push, so the caller may only
   * retire the old placement once this resolves `transferred: true`. An image
   * that cannot snapshot is reported as `capture-unsupported` rather than as a
   * failure: such an agent is not relocatable, and the caller must leave it
   * where it is instead of moving it without its data.
   */
  async transferStateForRelocation(opts: {
    agentId: string;
    orgId: string;
    targetBridgeUrl: string;
    /** Carries the agent's API token so the restore is not rejected (#15261). */
    authRec: Pick<AgentSandbox, "id" | "environment_vars">;
  }): Promise<StateTransferOutcome> {
    const captured = await this.snapshot(opts.agentId, opts.orgId, "pre-move");
    if (!captured.success || !captured.backup) {
      const detail = captured.error ?? "unknown snapshot failure";
      return {
        transferred: false,
        reason: detail === SNAPSHOT_ENDPOINT_UNSUPPORTED ? "capture-unsupported" : "capture-failed",
        detail,
      };
    }

    const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
      captured.backup.id,
    );
    if (!restoreState) {
      return {
        transferred: false,
        reason: "reconstruct-failed",
        detail: `pre-move backup ${captured.backup.id} could not be reconstructed`,
      };
    }

    try {
      await this.pushState(opts.targetBridgeUrl, restoreState, {
        trusted: true,
        authRec: opts.authRec,
      });
    } catch (error) {
      // error-policy:J2 the caller decides what to do with a half-moved agent,
      // and it can only decide correctly if the reason survives.
      return {
        transferred: false,
        reason: "push-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      transferred: true,
      snapshotId: captured.backup.id,
      sizeBytes: captured.backup.size_bytes ?? 0,
    };
  }

  /**
   * Decide whether a new snapshot of `stateData` is stored as a full backup or
   * an incremental delta against the latest backup, and build the insert row.
   * Falls back to a full backup whenever there is no parent, the parent chain
   * can't be reconstructed, or the delta isn't worth it (see
   * `planIncrementalBackup`). Full-backup behaviour is byte-identical to the
   * pre-incremental path, so existing flows are unaffected.
   */
  private async buildBackupInput(
    sandboxRecordId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<NewAgentSandboxBackup> {
    const contentHash = computeStateHash(stateData);
    const latest = await agentSandboxesRepository.getLatestBackup(sandboxRecordId);
    if (latest) {
      try {
        const baseState = await agentSandboxesRepository.getReconstructedBackupState(latest.id);
        if (baseState) {
          const all = await agentSandboxesRepository.listBackups(sandboxRecordId, 1000);
          const nodes = all.map((b) => ({
            id: b.id,
            backupKind: b.backup_kind,
            parentBackupId: b.parent_backup_id,
            createdAtMs: b.created_at.getTime(),
            // Kept so the projected chain sum below needs no extra query.
            sizeBytes: b.size_bytes ?? null,
          }));
          const chainDepth = incrementalChainDepth(nodes, latest.id);
          const plan = planIncrementalBackup({ base: baseState, next: stateData, chainDepth });
          if (plan.kind === "incremental") {
            // retained-implies-restorable (#17172): reconstruction budgets the
            // SUM of the chain's stored inputs, so appending a delta that
            // pushes that sum past the ceiling would make this row canonical
            // AND unreconstructable in the same write — the invariant this PR
            // exists to hold. A full backup is always reconstructable, so it is
            // the correct fail-closed outcome, both when the projection
            // breaches and when it cannot be computed (an ancestor with an
            // unrecorded size_bytes).
            const deltaBytes = estimateDeltaBytes(plan.delta);
            const existingChainBytes = resolveBackupChainBytes(nodes, latest.id);
            if (
              existingChainBytes !== null &&
              existingChainBytes + deltaBytes <= MAX_RESTORABLE_AGENT_BACKUP_BYTES
            ) {
              return {
                sandbox_record_id: sandboxRecordId,
                snapshot_type: type,
                // The state_data jsonb holds a BackupDelta for incremental rows.
                state_data: plan.delta,
                size_bytes: deltaBytes,
                backup_kind: "incremental",
                parent_backup_id: latest.id,
                content_hash: contentHash,
              };
            }
            logger.info(
              "[agent-sandbox] Storing a full backup: an incremental would exceed the restorable chain budget",
              {
                sandboxRecordId,
                existingChainBytes,
                deltaBytes,
                limitBytes: MAX_RESTORABLE_AGENT_BACKUP_BYTES,
              },
            );
          }
        }
      } catch (error) {
        logger.warn("[agent-sandbox] Incremental planning failed; storing full backup", {
          sandboxRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      sandbox_record_id: sandboxRecordId,
      snapshot_type: type,
      state_data: stateData,
      size_bytes: sizeBytes,
      backup_kind: "full",
      content_hash: contentHash,
    };
  }

  async restore(agentId: string, orgId: string, backupId?: string): Promise<SnapshotResult> {
    // Selection comes from the tenant-scoped primary. It is only a capture for
    // doing backup hydration/reconstruction outside the lifecycle transaction;
    // live push authority is re-read under the advisory + row locks below.
    const rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };

    const initialAuthorityRejection = restoreAuthorityRejection(rec);
    if (initialAuthorityRejection) {
      return { success: false, error: initialAuthorityRejection };
    }

    const restoringRunningGeneration = rec.status === "running";
    if (restoringRunningGeneration && !rec.bridge_url) {
      return { success: false, error: "Running agent is missing its restore endpoint" };
    }
    if (restoringRunningGeneration && this.getReplacementCleanupLocator(rec)) {
      return {
        success: false,
        error: "Agent restore cannot start while replacement cleanup is pending",
      };
    }

    // Read the stored row before KMS/R2 hydration. A foreign explicit id is
    // intentionally indistinguishable from a missing id and never releases
    // another tenant's backup payload to the hydration path.
    const storedBackup = backupId
      ? await agentSandboxesRepository.getStoredBackupById(backupId)
      : await agentSandboxesRepository.getLatestStoredBackup(rec.id);
    if (!storedBackup || storedBackup.sandbox_record_id !== rec.id) {
      return { success: false, error: "No backup found" };
    }

    if (!restoringRunningGeneration && backupId) {
      const latestBackup = await agentSandboxesRepository.getLatestStoredBackup(rec.id);
      if (!latestBackup || storedBackup.id !== latestBackup.id) {
        return {
          success: false,
          error: "Stopped agents can only restore the latest backup",
        };
      }
    }

    if (!restoringRunningGeneration) {
      // Pin the restore point selected above. `from-backup` also makes
      // provision fail closed rather than silently degrading this explicit
      // restore to a fresh boot. Provision admission itself remains a separate
      // lifecycle operation with its own authority fence.
      const backup = await hydrateAgentSandboxBackup(storedBackup);
      const prov = await this.provision(agentId, orgId, {
        kind: "from-backup",
        backupId: storedBackup.id,
        requireRestoreEndpoint: true,
        expectedAdmission: {
          id: rec.id,
          organization_id: rec.organization_id,
          status: rec.status,
          lifecycle_job_id: rec.lifecycle_job_id,
          lifecycle_execution_generation: rec.lifecycle_execution_generation,
          execution_tier: rec.execution_tier,
          pool_status: rec.pool_status,
          deleted_at: rec.deleted_at,
          deletion_attempt_id: rec.deletion_attempt_id,
          lifecycle_revision: rec.lifecycle_revision,
        },
      });
      return prov.success ? { success: true, backup } : { success: false, error: prov.error };
    }

    // Capture the complete target->base chain from the primary before
    // reconstruction. The reconstruction repository performs its own primary
    // reads; a second identical capture below proves no row used by that work
    // disappeared, crossed authority, changed payload/locator, or left the
    // legacy-visible lane while bytes were being materialized.
    const storedRestoreChain = await captureStoredRestoreChain(storedBackup.id, rec.id);
    if (
      !storedRestoreChain ||
      !storedRestorePointStillCanonical(storedRestoreChain[0]!, storedBackup)
    ) {
      return { success: false, error: RESTORE_BACKUP_CHANGED };
    }

    const backup = await hydrateAgentSandboxBackup(storedBackup);
    const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
      storedBackup.id,
    );
    if (!restoreState) {
      return {
        success: false,
        error: `Backup ${storedBackup.id} could not be reconstructed`,
      };
    }
    const confirmedRestoreChain = await captureStoredRestoreChain(storedBackup.id, rec.id);
    if (
      !confirmedRestoreChain ||
      !storedRestoreChainStillCanonical(confirmedRestoreChain, storedRestoreChain)
    ) {
      return { success: false, error: RESTORE_BACKUP_CHANGED };
    }

    const authorized = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };

      const currentAuthorityRejection = restoreAuthorityRejection(current);
      if (currentAuthorityRejection) {
        return { success: false as const, error: currentAuthorityRejection };
      }
      if (current.status !== "running" || !current.bridge_url) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }
      if (this.getReplacementCleanupLocator(current)) {
        return {
          success: false as const,
          error: "Agent restore cannot start while replacement cleanup is pending",
        };
      }
      if (await this.hasActiveExclusiveLifecycleJobTx(tx, agentId, orgId)) {
        return {
          success: false as const,
          error: "Agent restore cannot start while an exclusive lifecycle job is active",
        };
      }
      if (!restoreCaptureStillCanonical(current, rec)) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }

      // Hold every row used by reconstruction through the push so prune and
      // catalogue work cannot retire or rewrite an ancestor after the payload
      // was materialized but before it is applied to the live runtime. Acquire
      // locks in UUID order so overlapping incremental chains cannot deadlock
      // by walking their parent links in opposite orders.
      const lockedRestoreChain = await tx
        .select()
        .from(agentSandboxBackups)
        .where(
          and(
            inArray(
              agentSandboxBackups.id,
              storedRestoreChain.map((row) => row.id),
            ),
            eq(agentSandboxBackups.sandbox_record_id, current.id),
            or(
              isNull(agentSandboxBackups.catalog_state),
              eq(agentSandboxBackups.catalog_state, "legacy_unmigrated"),
            ),
          ),
        )
        .orderBy(asc(agentSandboxBackups.id))
        .for("update")
        .execute();
      if (!storedRestoreChainStillCanonical(lockedRestoreChain, storedRestoreChain)) {
        return { success: false as const, error: RESTORE_BACKUP_CHANGED };
      }

      // Reserve a lifecycle generation BEFORE the irreversible runtime call.
      // This update remains invisible until commit and is rolled back if the
      // push fails, but trigger/CAS drift is detected before any runtime state
      // is changed. Network I/O under this bounded (120s) lock is the deliberate
      // availability tradeoff required to prevent two stale restores from
      // applying to one live generation.
      const [reserved] = await tx
        .update(agentSandboxes)
        .set({
          last_heartbeat_at: sql`
            CASE
              WHEN ${agentSandboxes.last_heartbeat_at} IS NULL
                THEN date_trunc('milliseconds', clock_timestamp())
              ELSE GREATEST(
                ${agentSandboxes.last_heartbeat_at} + INTERVAL '1 millisecond',
                date_trunc('milliseconds', clock_timestamp())
              )
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "running"),
            eq(agentSandboxes.lifecycle_revision, current.lifecycle_revision),
            sql`${agentSandboxes.execution_tier} IS NOT DISTINCT FROM ${current.execution_tier}`,
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.deleted_at} IS NULL`,
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
      if (!reserved) {
        return { success: false as const, error: RESTORE_AUTHORITY_CHANGED };
      }
      if (reserved.lifecycleRevision !== current.lifecycle_revision + 1) {
        // A returned row proves the CAS update ran. Committing it without the
        // lifecycle trigger would publish success metadata without fencing the
        // restored generation, so make trigger drift transaction-fatal.
        throw new Error("Restore lifecycle fence did not advance the generation");
      }

      await this.pushState(current, restoreState);

      // The reservation timestamp can age for the full push timeout. Stamp
      // completion only after the endpoint has answered, never moving a newer
      // concurrent heartbeat backwards. This second lifecycle write is
      // intentional: a successful live restore consumes one revision to
      // reserve the runtime mutation and one to publish its completion.
      const [completed] = await tx
        .update(agentSandboxes)
        .set({
          last_heartbeat_at: sql`
            CASE
              WHEN ${agentSandboxes.last_heartbeat_at} IS NULL
                THEN date_trunc('milliseconds', clock_timestamp())
              ELSE GREATEST(
                ${agentSandboxes.last_heartbeat_at} + INTERVAL '1 millisecond',
                date_trunc('milliseconds', clock_timestamp())
              )
            END
          `,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            eq(agentSandboxes.status, "running"),
            eq(agentSandboxes.lifecycle_revision, reserved.lifecycleRevision),
            sql`${agentSandboxes.execution_tier} IS NOT DISTINCT FROM ${current.execution_tier}`,
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.deleted_at} IS NULL`,
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
      if (!completed || completed.lifecycleRevision !== reserved.lifecycleRevision + 1) {
        // The runtime has already applied the state. Commit the pre-push
        // reservation rather than rolling it back and permitting a stale retry;
        // surface the incomplete completion stamp to the caller.
        return {
          success: false as const,
          error: "Restore completed but its durable completion stamp failed",
        };
      }

      // The runtime and PostgreSQL cannot commit atomically: a runtime that
      // applies the payload just before the response/PG commit fails cannot be
      // rolled back here. A durable restore receipt/idempotency protocol is a
      // separate cross-system follow-up; this fence prevents stale generation
      // pushes but does not claim to solve that residual.
      return { success: true as const };
    });

    return authorized.success ? { success: true, backup } : authorized;
  }

  async listBackups(
    agentId: string,
    orgId: string,
    limit?: number,
  ): Promise<AgentSandboxBackupMetadata[]> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    return rec ? agentSandboxesRepository.listBackupMetadata(rec.id, limit) : [];
  }

  // Heartbeat

  /**
   * A probe observes one running compute generation, then performs network I/O
   * without holding a database lock. Its writeback must therefore be fenced to
   * that exact generation and must lose to a durable delete intent.
   */
  private async updateObservedRunningGeneration(
    rec: AgentSandbox,
    data: Partial<NewAgentSandbox>,
  ): Promise<AgentSandbox | undefined> {
    return agentSandboxesRepository.update(rec.id, data, {
      organizationId: rec.organization_id,
      environmentRevision: rec.environment_revision,
      sandboxId: rec.sandbox_id,
      nodeId: rec.node_id,
      containerName: rec.container_name,
      lifecycleRevision: rec.lifecycle_revision,
    });
  }

  async heartbeat(agentId: string, orgId: string): Promise<boolean> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec || !isContainerBackedExecutionTier(rec.execution_tier) || !rec.bridge_url) {
      return false;
    }

    const probe = await this.probeBridgeHealthDetailed(rec);

    if (probe.kind === "terminal-db") {
      await this.handleTerminalDatabaseLivenessFailure(rec, probe.reason);
      return false;
    }

    if (!probe.ok) {
      // Hysteresis: one failed cycle is not enough to evict. last_heartbeat_at
      // is bumped only on success, so its age is how long the agent has been
      // continuously unreachable. Stay running inside the grace window (the next
      // cycle's retry re-warms the path); only disconnect once unreachable past
      // it.
      const lastOkMs = rec.last_heartbeat_at
        ? new Date(rec.last_heartbeat_at).getTime()
        : Date.now();
      const downForMs = Date.now() - lastOkMs;
      if (downForMs < HEARTBEAT_DISCONNECT_AFTER_MS) {
        logger.warn("[agent-sandbox] Heartbeat miss within grace window, keeping running", {
          agentId,
          downForMs,
          reason: probe.reason,
        });
        return false;
      }
      // Past-grace miss: before disconnecting (which reprovisions — destroying
      // and rebuilding the container), check whether the container is alive but
      // its stored tailnet IP went stale, and repair the columns in place. The
      // repair heals every consumer at once (this probe, the agent-router, the
      // public proxy) because they all read the same columns.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome === "repaired") {
        const updated = await this.updateObservedRunningGeneration(rec, {
          headscale_ip: reconcile.headscaleIp,
          bridge_url: reconcile.bridgeUrl,
          health_url: reconcile.healthUrl,
          last_heartbeat_at: new Date(),
          error_count: 0,
        });
        if (!updated) return false;
        logger.info(
          `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
        );
        return true;
      }
      if (reconcile.outcome === "ip-unresolvable") {
        // Docker reports the container healthy but the node cannot tell us its
        // current tailnet IP — indistinguishable from a transient SSH outage,
        // so disconnecting now could destroy a healthy paid container. Guard
        // error_count and only escalate once the cap of consecutive cycles is
        // hit, so an agent that stays unresolvable still reaches the
        // disconnect → reprovision self-heal instead of sitting unreachable
        // at "running" forever.
        const unresolvedCycles = (rec.error_count ?? 0) + 1;
        if (unresolvedCycles < IP_RECONCILE_MAX_UNRESOLVED_CYCLES) {
          await this.updateObservedRunningGeneration(rec, {
            error_count: unresolvedCycles,
          });
          logger.warn(
            "[agent-sandbox] Tailnet IP unresolvable for docker-healthy agent, deferring disconnect",
            { agentId, unresolvedCycles },
          );
          return false;
        }
      }
      logger.warn("[agent-sandbox] Heartbeat failed past grace window, marking disconnected", {
        agentId,
        downForMs,
        reason: probe.reason,
        reconcileOutcome: reconcile.outcome,
      });
      await this.updateObservedRunningGeneration(rec, {
        status: "disconnected",
      });
      return false;
    }
    const updated = await this.updateObservedRunningGeneration(rec, {
      last_heartbeat_at: new Date(),
      // Reset the unresolvable-cycle grace counter on any clean heartbeat so the
      // "escalate after 3 consecutive unresolvable cycles" window measures from
      // the last healthy beat, not a stale prior error_count from an old episode.
      error_count: 0,
    });
    return Boolean(updated);
  }

  /**
   * Probe the agent's bridge `/api/health` over the headscale tailnet with
   * retries. Shared by `heartbeat` (running agents) and `recoverDisconnected`
   * (disconnected always-on agents).
   *
   * The first attempt re-warms a cold tailnet path, so a single miss does not
   * mean the agent is down. Liveness MUST dial the BRIDGE port: the container
   * serves its full HTTP API there (and `/api/health` unauthed — the same
   * endpoint provisioning's health probe passes on); `web_ui_port` is a
   * host-only docker mapping NOT reachable over the tailnet. This exact form is
   * verified live in prod (a dedicated-always agent holds `running` and its
   * subdomain proxies 200/401).
   */
  private async probeBridgeHealth(
    rec: Pick<AgentSandbox, "id" | "environment_vars" | "bridge_url">,
  ): Promise<boolean> {
    return (await this.probeBridgeHealthDetailed(rec)).ok;
  }

  private async probeBridgeHealthDetailed(
    rec: Pick<AgentSandbox, "id" | "environment_vars" | "bridge_url">,
  ): Promise<BridgeHealthProbeResult> {
    if (!rec.bridge_url) {
      return { ok: false, kind: "unreachable", reason: "missing bridge_url" };
    }
    const endpoint = new URL("/api/health", rec.bridge_url).toString();
    let lastFailure: BridgeHealthProbeResult = {
      ok: false,
      kind: "unreachable",
      reason: "bridge health probe failed",
    };
    for (let attempt = 0; attempt < HEARTBEAT_PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_PROBE_RETRY_MS));
      }
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          headers: this.getAgentJsonHeaders(rec),
          signal: AbortSignal.timeout(10_000),
        });
        const classified = await this.classifyBridgeHealthResponse(res);
        if (classified.ok) return classified;
        lastFailure = classified;
        if (classified.kind === "terminal-db") return classified;
      } catch (error) {
        lastFailure = {
          ok: false,
          kind: "unreachable",
          reason: error instanceof Error ? error.message : String(error),
        };
        logger.debug("[agent-sandbox] Bridge health probe attempt failed, retrying", {
          agentId: rec.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return lastFailure;
  }

  private async classifyBridgeHealthResponse(res: Response): Promise<BridgeHealthProbeResult> {
    let payload: AgentRuntimeHealthPayload | null = null;
    try {
      payload = (await res.clone().json()) as AgentRuntimeHealthPayload;
    } catch {
      // error-policy:J3 malformed health JSON is an explicit unreachable probe result
      payload = null;
    }
    const databaseLiveness = payload?.databaseLiveness;
    const terminal =
      databaseLiveness?.terminal === true ||
      databaseLiveness?.status === "terminal_error" ||
      payload?.database === "terminal_error";
    if (terminal) {
      return {
        ok: false,
        kind: "terminal-db",
        reason:
          typeof databaseLiveness?.message === "string"
            ? databaseLiveness.message
            : "database liveness probe reported terminal failure",
      };
    }
    const transient =
      databaseLiveness?.status === "transient_error" || payload?.database === "transient_error";
    if (transient) {
      return {
        ok: false,
        kind: "transient",
        reason:
          typeof databaseLiveness?.message === "string"
            ? databaseLiveness.message
            : "database liveness probe reported transient failure",
      };
    }
    if (res.ok) return { ok: true, kind: "healthy" };
    return {
      ok: false,
      kind: "unreachable",
      reason: `/api/health returned ${res.status}`,
    };
  }

  private parseDatabaseLivenessRestartMarker(message: string | null): {
    count: number;
    at: number | null;
  } {
    if (!message?.includes(DB_LIVENESS_RESTART_MARKER)) {
      return { count: 0, at: null };
    }
    const countMatch = message.match(/count=(\d+)/);
    const atMatch = message.match(/at=([0-9TZ:.-]+)/);
    const parsedAt = atMatch ? Date.parse(atMatch[1]) : Number.NaN;
    return {
      count: countMatch ? Number(countMatch[1]) : 0,
      at: Number.isFinite(parsedAt) ? parsedAt : null,
    };
  }

  private async handleTerminalDatabaseLivenessFailure(
    rec: AgentSandbox,
    reason: string,
  ): Promise<void> {
    const marker = this.parseDatabaseLivenessRestartMarker(rec.error_message);
    const now = Date.now();
    // Keep this budget scoped to DB-liveness recovery. error_count is shared
    // with unrelated reconciliation paths and must not consume this budget.
    // An old DB-liveness episode also ages out so an agent is not permanently
    // barred from automatic recovery after three failures over its lifetime.
    const markerAge = marker.at === null ? null : now - marker.at;
    const markerActive =
      markerAge !== null && markerAge >= 0 && markerAge < DB_LIVENESS_RESTART_BUDGET_WINDOW_MS;
    const count = markerActive ? marker.count : 0;
    if (markerActive && markerAge !== null && markerAge < DB_LIVENESS_RESTART_COOLDOWN_MS) {
      logger.warn("[agent-sandbox] Terminal database liveness failure inside restart cooldown", {
        agentId: rec.id,
        count,
        reason,
      });
      return;
    }
    if (count >= DB_LIVENESS_RESTART_BUDGET) {
      const updated = await this.updateObservedRunningGeneration(rec, {
        status: "error",
        error_count: count,
        error_message: `${DB_LIVENESS_RESTART_MARKER} budget-exhausted count=${count} at=${new Date(now).toISOString()} reason=${reason}`,
      });
      logger.error("[agent-sandbox] Terminal database liveness restart budget exhausted", {
        agentId: rec.id,
        count,
        reason,
      });
      if (!updated) return;
      return;
    }

    const nextCount = count + 1;
    const updated = await this.updateObservedRunningGeneration(rec, {
      error_count: nextCount,
      error_message: `${DB_LIVENESS_RESTART_MARKER} count=${nextCount} at=${new Date(now).toISOString()} reason=${reason}`,
    });
    if (!updated) return;
    const { provisioningJobService } = await import("./provisioning-jobs");
    const result = await provisioningJobService.enqueueAgentRestartOnce({
      agentId: rec.id,
      organizationId: rec.organization_id,
      userId: rec.user_id,
    });
    logger.warn("[agent-sandbox] Enqueued restart for terminal database liveness failure", {
      agentId: rec.id,
      jobId: result.job.id,
      created: result.created,
      count: nextCount,
      reason,
    });
  }

  /**
   * SSH client for the docker node hosting the agent's container. Returns null
   * when the node cannot be located — the reconcile path treats that as "no
   * signal", never as evidence either way.
   */
  private async getNodeSshForAgent(
    rec: Pick<ReconcilableSandbox, "id" | "node_id">,
  ): Promise<DockerSSHClient | null> {
    if (!rec.node_id) return null;
    // error-policy:J4 best-effort node resolve — a DB/SSH-config failure here is
    // "cannot determine", not a heartbeat kill; the caller decides how to degrade.
    try {
      const node = await dockerNodesRepository.findByNodeId(rec.node_id);
      if (!node) return null;
      return DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user,
      );
    } catch (error) {
      logger.debug("[agent-sandbox] Failed to resolve docker node for reconcile", {
        agentId: rec.id,
        nodeId: rec.node_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Node-side docker health for the agent's container. This is the authority
   * that distinguishes a dead container (safe to disconnect → reprovision)
   * from a live one whose stored tailnet IP went stale (must be repaired, not
   * destroyed).
   */
  private async isContainerDockerHealthy(rec: ReconcilableSandbox): Promise<boolean> {
    if (!rec.container_name) return false;
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return false;
    // error-policy:J4 best-effort probe — an exec failure yields "not proven
    // healthy" (falls through to the existing disconnect self-heal), never a throw.
    try {
      const status = (
        await ssh.exec(
          `docker inspect --format '{{.State.Health.Status}}' ${shellQuote(rec.container_name)}`,
          RECONCILE_SSH_CMD_TIMEOUT_MS,
        )
      ).trim();
      return status === "healthy";
    } catch (error) {
      logger.debug("[agent-sandbox] Docker health inspect failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Resolve the container's CURRENT tailnet IP authoritatively from the node:
   * `tailscale --socket=/tmp/tailscaled.sock ip -4` inside the container is the same source the container
   * registered with, so it reflects the post-restart node key/IP — unlike the
   * stored headscale_ip, which is a provision-time snapshot.
   */
  private async resolveCurrentAgentTailnetIp(rec: ReconcilableSandbox): Promise<string | null> {
    if (!rec.container_name) return null;
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return null;
    // error-policy:J4 best-effort resolve — a failed resolve returns null (no
    // positive signal), never throws; the caller guards toward disconnect.
    try {
      const out = await ssh.exec(
        `docker exec ${shellQuote(rec.container_name)} tailscale --socket=/tmp/tailscaled.sock ip -4`,
        RECONCILE_SSH_CMD_TIMEOUT_MS,
      );
      // First 100.64.0.0/10-shaped line; the CLI can also print IPv6 lines.
      const ip = out
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("100."));
      return ip && isIP(ip) === 4 ? ip : null;
    } catch (error) {
      logger.debug("[agent-sandbox] Current tailnet IP resolve failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Attempt to reconcile a bridge-probe miss as a stale stored tailnet IP.
   * Containers do not persist tailscale node state, so a restart mints a fresh
   * node key and headscale assigns the next IP — leaving headscale_ip /
   * bridge_url / health_url pointing at a dead address that EVERY consumer reads (the
   * heartbeat probe, the agent-router's subdomain resolution, and therefore
   * the public dedicated-agent proxy). Repairing the columns heals them all;
   * anything unrepairable falls back to the existing disconnect → reprovision
   * self-heal. A repair is admitted only for the provider's canonical tailnet
   * pair (same old IP and internal HTTP port); it swaps the host while retaining
   * the health path and moves every trusted ingress column to one generation.
   */
  private async reconcileStaleTailnetIp(
    rec: ReconcilableSandbox,
  ): Promise<TailnetIpReconcileResult> {
    if (!(await this.isContainerDockerHealthy(rec))) return { outcome: "container-dead" };
    const currentIp = await this.resolveCurrentAgentTailnetIp(rec);
    if (!currentIp) return { outcome: "ip-unresolvable" };
    // Same IP as stored = nothing to repair: the miss is genuine
    // unreachability at the correct address, so the dead-agent path applies.
    if (
      !rec.bridge_url ||
      !rec.health_url ||
      !rec.headscale_ip ||
      isIP(rec.headscale_ip) !== 4 ||
      currentIp === rec.headscale_ip
    ) {
      return { outcome: "unrepairable" };
    }

    let bridgeUrl: string;
    let healthUrl: string;
    try {
      const repairedBridge = new URL(rec.bridge_url);
      const repairedHealth = new URL(rec.health_url);
      // Bind the repair to the exact old tailnet generation. A non-tailnet
      // Docker row stores the node hostname plus host-published ports; swapping
      // only that hostname to a tailnet IP would manufacture unreachable URLs.
      // Canonical headscale handles use one internal HTTP port for both ingress
      // URLs, so reject mixed/corrupt generations and let reprovision rebuild
      // the pair from provider metadata.
      if (
        repairedBridge.protocol !== "http:" ||
        repairedHealth.protocol !== "http:" ||
        repairedBridge.hostname !== rec.headscale_ip ||
        repairedHealth.hostname !== rec.headscale_ip ||
        repairedBridge.port !== repairedHealth.port
      ) {
        return { outcome: "unrepairable" };
      }
      repairedBridge.hostname = currentIp;
      bridgeUrl = repairedBridge.origin;
      repairedHealth.hostname = currentIp;
      healthUrl = repairedHealth.toString();
    } catch (error) {
      // error-policy:J4 malformed stored ingress cannot be repaired in place;
      // degrade to the existing disconnect → reprovision self-heal.
      logger.warn("[agent-sandbox] Stored ingress URL unparsable during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "unrepairable" };
    }

    // Only a live answer on the repaired address proves the new IP is the
    // container we think it is — never persist an unverified repair.
    const reachable = await this.probeBridgeHealth({ ...rec, bridge_url: bridgeUrl });
    if (!reachable) return { outcome: "unrepairable" };
    return { outcome: "repaired", headscaleIp: currentIp, bridgeUrl, healthUrl };
  }

  private async verifyReplacementRuntimeHealth(args: {
    agent: Pick<AgentSandbox, "id" | "environment_vars">;
    bridgeUrl: string;
  }): Promise<{ success: true } | { success: false; error: string }> {
    let statusEndpoint: string;
    let healthEndpoint: string;
    try {
      statusEndpoint = new URL("/api/status", args.bridgeUrl).toString();
      healthEndpoint = new URL("/api/health", args.bridgeUrl).toString();
    } catch (error) {
      return {
        success: false,
        error: `invalid bridge URL: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const headers = this.getAgentJsonHeaders(args.agent);
    if (!headers.Authorization) {
      return {
        success: false,
        error: "agent API token is unavailable for authenticated /api/status",
      };
    }

    const fetchRuntimeJson = async (
      endpoint: string,
      route: "/api/status" | "/api/health",
    ): Promise<
      { success: true; body: Record<string, unknown> } | { success: false; error: string }
    > => {
      try {
        const res = await withTimeout(
          fetch(endpoint, {
            method: "GET",
            headers: {
              ...headers,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS),
          }),
          UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS + 1_000,
          `blue runtime ${route === "/api/status" ? "status" : "health"} gate`,
        );
        if (!res.ok) {
          return {
            success: false,
            error: `${route} returned HTTP ${res.status}`,
          };
        }

        let body: unknown;
        try {
          body = await res.json();
        } catch {
          // error-policy:J3 A malformed readiness document is an explicit
          // failed signal; it must never become an empty healthy object.
          return {
            success: false,
            error: `${route} returned malformed JSON`,
          };
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return {
            success: false,
            error: `${route} returned a non-object payload`,
          };
        }
        return {
          success: true,
          body: body as Record<string, unknown>,
        };
      } catch (error) {
        // error-policy:J1 The image-replacement boundary converts transport
        // failure into a fail-closed readiness result before traffic moves.
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const appendStartupFailures = (
      failures: string[],
      startup: AgentRuntimeStartupPayload | null | undefined,
    ): void => {
      if (!startup || typeof startup !== "object" || Array.isArray(startup)) {
        failures.push("startup=missing");
        return;
      }
      if (startup.phase !== "running") {
        failures.push(`startup.phase=${String(startup.phase)}`);
      }
      if (
        typeof startup.attempt !== "number" ||
        !Number.isInteger(startup.attempt) ||
        startup.attempt < 0
      ) {
        failures.push(`startup.attempt=${String(startup.attempt)}`);
      }
      if (startup.lastError !== undefined && typeof startup.lastError !== "string") {
        failures.push(`startup.lastError=${String(startup.lastError)}`);
      } else if (typeof startup.lastError === "string" && startup.lastError.trim()) {
        failures.push(`startup.lastError=${startup.lastError.trim()}`);
      }
    };

    const statusResponse = await fetchRuntimeJson(statusEndpoint, "/api/status");
    if (!statusResponse.success) return statusResponse;
    const status = statusResponse.body as AgentRuntimeStatusPayload;
    const statusFailures: string[] = [];
    if (status.state !== "running") {
      statusFailures.push(`state=${String(status.state)}`);
    }
    if (status.canRespond !== true) {
      statusFailures.push(`canRespond=${String(status.canRespond)}`);
    }
    appendStartupFailures(statusFailures, status.startup);
    if (statusFailures.length > 0) {
      return {
        success: false,
        error: `/api/status not ready (${statusFailures.join(", ")})`,
      };
    }

    const healthResponse = await fetchRuntimeJson(healthEndpoint, "/api/health");
    if (!healthResponse.success) return healthResponse;
    const health = healthResponse.body as AgentRuntimeHealthPayload;
    const failures: string[] = [];
    if (health.ready !== true) {
      failures.push(`ready=${String(health.ready)}`);
    }
    if (health.canRespond !== true) {
      failures.push(`canRespond=${String(health.canRespond)}`);
    }
    if (health.runtime !== "ok") {
      failures.push(`runtime=${String(health.runtime)}`);
    }
    if (health.database !== "ok") {
      failures.push(`database=${String(health.database)}`);
    }

    if (!health.plugins || typeof health.plugins !== "object" || Array.isArray(health.plugins)) {
      failures.push("plugins=missing");
    } else {
      const loadedPlugins = health.plugins.loaded;
      if (
        typeof loadedPlugins !== "number" ||
        !Number.isInteger(loadedPlugins) ||
        loadedPlugins <= 0
      ) {
        failures.push(`plugins.loaded=${String(loadedPlugins)}`);
      }
      const failedPlugins = health.plugins.failed;
      if (
        typeof failedPlugins !== "number" ||
        !Number.isInteger(failedPlugins) ||
        failedPlugins < 0
      ) {
        failures.push(`plugins.failed=${String(failedPlugins)}`);
      } else if (failedPlugins > 0) {
        failures.push(`plugins.failed=${failedPlugins}`);
      }
    }

    appendStartupFailures(failures, health.startup);
    if (failures.length > 0) {
      return {
        success: false,
        error: `/api/health not ready (${failures.join(", ")})`,
      };
    }
    return { success: true };
  }

  /**
   * Reconcile a recoverable always-on (paid) agent back to health. A
   * `dedicated-always` agent is contractually meant to stay up, so the recovery
   * cycle calls this to self-heal a transient drop: re-probe the bridge and, if
   * the container answers, flip it straight back to `running` (the agent-router
   * only routes `running`, so this also restores its subdomain). Blue/green
   * swaps can also leave a healthy bridge behind a stale `error` row; treat that
   * the same as `disconnected`, but only after the live bridge answers. If it
   * stays unreachable the caller re-provisions it. The guarded compare-and-set
   * write (not a blind update-by-id) makes this safe to run concurrently with
   * the heartbeat cycle AND with shutdown/delete/provision: the read -> probe ->
   * write window spans seconds, so we only flip a row that is STILL in the
   * probed recoverable status at write time.
   */
  async recoverDisconnected(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unreachable" | "gone"> {
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (
      !rec ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      (rec.status !== "disconnected" && rec.status !== "error")
    ) {
      return "gone";
    }
    const reachable = await this.probeBridgeHealth(rec);
    if (!reachable) {
      // The stored bridge_url may simply be stale (container restart → new
      // tailnet IP) rather than the container being down. Repair-and-reprobe
      // before declaring it unreachable, so recovery does not reprovision —
      // destroy and rebuild — a healthy container that only needs its ingress
      // columns fixed. Anything unrepairable stays "unreachable" and
      // reprovisions exactly as before.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome !== "repaired") return "unreachable";
      // Same guarded CAS as the plain recovery flip below: only revive a row
      // that is STILL in the probed recoverable status, then persist the
      // repaired ingress columns on the now-running row.
      const revived = await agentSandboxesRepository.markReconnectedFromDisconnected(rec, {
        headscaleIp: reconcile.headscaleIp,
        bridgeUrl: reconcile.bridgeUrl,
        healthUrl: reconcile.healthUrl,
        errorCount: 0,
      });
      if (!revived) return "gone";
      logger.info(
        `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
      );
      return "recovered";
    }
    // Guarded CAS: the row can move to deletion_pending / stopped (which nulls
    // bridge_url) / provisioning during the multi-second probe. Only flip it if
    // it is STILL disconnected with a live bridge — otherwise we'd resurrect a
    // being-deleted agent or wedge a stopped one at `running` with a dead bridge.
    const restored = await agentSandboxesRepository.markReconnectedFromDisconnected(rec);
    if (!restored) return "gone";
    logger.info("[agent-sandbox] Recovered agent back to running", {
      agentId,
    });
    return "recovered";
  }

  /**
   * Reconcile a row WEDGED in `provisioning` whose container may actually be
   * healthy — the readiness-probe false-negative split-brain (#15310 #6). The
   * Worker-side cleanup cron can only mark such rows `error` (no SSH); THIS runs
   * on the daemon, which can re-probe the container node-side and, when it is
   * genuinely healthy, flip the row straight to `running` instead of failing a
   * live agent.
   *
   * Outcomes:
   *   - `recovered` — the container re-probed healthy and the row was CAS-flipped
   *     to `running`.
   *   - `unresolved` — the probe still could not confirm health (transport
   *     unresolved or genuinely not-ready). Left untouched for the next pass
   *     (or, eventually, the Worker cron's error mark). NEVER destroys the
   *     container: a wrong teardown here re-creates the very bug.
   *   - `gone` — the row moved on (no longer `provisioning`, deleted, or lost
   *     its container) during the multi-second probe; nothing to do.
   */
  async reconcileStuckProvisioning(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unresolved" | "gone"> {
    let rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (
      !rec ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      rec.status !== "provisioning" ||
      !rec.sandbox_id
    ) {
      return "gone";
    }
    if (rec.claimed_at && rec.warm_claim_credential_state !== "ready") {
      await this.recoverPendingWarmClaimInferenceKey(agentId, orgId);
      return "recovered";
    }

    // Provider health is read-only, but it still must not be dialled for a row
    // that became container-free after the first snapshot. This primary read
    // is deliberately adjacent to the probe; the final state mutation remains
    // a tier-qualified lifecycle CAS. Cross-system atomicity would require a
    // durable probe lease and is outside this bounded service/CAS fix.
    const probeSource = await this.getAgentForWrite(agentId, orgId);
    if (
      !probeSource ||
      !isContainerBackedExecutionTier(probeSource.execution_tier) ||
      !probeSource.sandbox_id ||
      probeSource.status !== rec.status ||
      probeSource.sandbox_id !== rec.sandbox_id ||
      probeSource.node_id !== rec.node_id ||
      probeSource.container_name !== rec.container_name ||
      probeSource.environment_revision !== rec.environment_revision ||
      probeSource.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return "gone";
    }
    rec = probeSource;

    const provider = await this.getProvider();
    const handle: SandboxHandle = {
      sandboxId: probeSource.sandbox_id,
      bridgeUrl: rec.bridge_url ?? "",
      healthUrl: rec.health_url ?? "",
      metadata: rec.headscale_ip ? { headscaleIp: rec.headscale_ip } : undefined,
    };

    let healthy = false;
    try {
      healthy = provider.checkHealthDetailed
        ? (await provider.checkHealthDetailed(handle)).ready
        : await provider.checkHealth(handle);
    } catch (error) {
      // A probe that throws is "no signal" — leave the row for the next pass,
      // never condemn or resurrect on an errored probe.
      logger.debug("[agent-sandbox] Stuck-provisioning re-probe threw; leaving row", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unresolved";
    }

    if (!healthy) return "unresolved";

    // Guarded CAS: only flip if still `provisioning` with a live container and
    // no active provision job racing it (see markRunningFromProvisioning).
    const flipped = await agentSandboxesRepository.markRunningFromProvisioning(rec);
    if (!flipped) return "gone";
    logger.info(
      "[agent-sandbox] Reconciled wedged provisioning row to running (container re-probed healthy)",
      { agentId },
    );
    return "recovered";
  }

  // Shutdown

  /**
   * Stops the agent's container and flips the row to `stopped`, capturing a
   * pre-stop snapshot first. Fail-closed by default: a capture failure leaves
   * the agent running and returns an explicit refusal. The sole sanctioned
   * bypass is `options.stateLossAcknowledged` (#18228) — an operator's
   * explicit acceptance that state since the last durable backup is discarded
   * — which proceeds to stop without a capture, loudly, and reports
   * `stateLossAcknowledged: true` in the result. It is never implied.
   */
  async shutdown(
    agentId: string,
    orgId: string,
    options?: { readonly stateLossAcknowledged?: boolean },
  ): Promise<{
    success: boolean;
    error?: string;
    retryable?: boolean;
    stateLossAcknowledged?: boolean;
  }> {
    let snapshotAgentId: string | null = null;
    let captureUnsupported = false;
    let captureWaivedByOperator = false;
    let preShutdownSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;
    // Exact authority for every remote capture attempt, including the two
    // explicit no-capture outcomes (unsupported image and operator waiver).
    // A response from generation A must never authorize persisting or stopping
    // a replacement generation B that happens to reuse the same bridge URL.
    let shutdownCaptureAuthority: SnapshotAuthorityCapture | null = null;

    const snapshotSource = await this.getAgentForWrite(agentId, orgId);
    if (snapshotSource) {
      const tierRejection = containerBackedServiceRejection(snapshotSource, "shutdown");
      if (tierRejection) return { success: false, error: tierRejection };
    }
    if (snapshotSource?.status === "running" && snapshotSource.bridge_url) {
      shutdownCaptureAuthority = snapshotSource;
      try {
        preShutdownSnapshot = await this.fetchSnapshotState(snapshotSource);
      } catch (error) {
        // error-policy:J1 the shutdown command boundary translates capture
        // failures into an explicit refusal while leaving the agent running.
        const message = error instanceof Error ? error.message : String(error);
        if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
          // The deployed image cannot snapshot by construction; requiring a
          // capture it can never produce would make this agent unstoppable.
          captureUnsupported = true;
          logger.warn(
            "[agent-sandbox] Shutdown proceeding without capture: image has no snapshot endpoint",
            { agentId },
          );
        } else if (options?.stateLossAcknowledged) {
          // Sanctioned operator override (#18228): a persistent capture or
          // transfer-hop failure otherwise makes the agent unstoppable through
          // every safe path. The operator explicitly acknowledged the state
          // loss, so proceed to stop WITHOUT a capture — never silently: the
          // waiver is logged here and reported in the result.
          captureWaivedByOperator = true;
          logger.error(
            "[agent-sandbox] Shutdown proceeding WITHOUT pre-stop capture: operator acknowledged state loss",
            { agentId, captureError: message },
          );
        } else if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
          // TRANSIENT (PGlite closing race): do NOT weaken the fail-closed
          // guarantee — still refuse to stop — but mark the failure RETRYABLE so
          // the restart/shutdown job re-attempts instead of treating a healthy
          // agent as permanently un-capturable. On the next attempt PGlite is no
          // longer mid-close and the capture succeeds (2026-08-11 fleet
          // incident: opaque 500 here wedged healthy agents indefinitely).
          logger.warn(
            "[agent-sandbox] Shutdown deferred: pre-stop capture transiently unavailable, will retry",
            { agentId },
          );
          return {
            success: false,
            retryable: true,
            error: `Refusing to stop without a current backup: ${message}`,
          };
        } else {
          // Fail CLOSED: stopping the container without a current capture
          // silently discards everything since the last backup. A shutdown
          // that cannot prove a capture leaves the agent running and says so.
          logger.error("[agent-sandbox] Shutdown refused: pre-stop capture failed", {
            agentId,
            error: message,
          });
          return {
            success: false,
            error: `Refusing to stop without a current backup: ${message}`,
          };
        }
      }
    }

    const result = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;
      const tierRejection = containerBackedServiceRejection(rec, "shutdown");
      if (tierRejection) return { success: false, error: tierRejection } as const;
      if (rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
        return { success: false, error: "Agent not found" } as const;
      }
      if (this.getReplacementCleanupLocator(rec)) {
        return { success: false, error: "Agent replacement cleanup is still pending" } as const;
      }

      if (
        shutdownCaptureAuthority &&
        !snapshotCaptureStillCanonical(rec, shutdownCaptureAuthority)
      ) {
        return {
          success: false,
          error:
            "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
        } as const;
      }

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      const recoveringWarmCredentialFence =
        rec.status === "provisioning" &&
        rec.claimed_at !== null &&
        (rec.warm_claim_credential_state === "pending" ||
          rec.warm_claim_credential_state === "attested");
      const hasCompleteWarmRecoveryLocator =
        rec.sandbox_id !== null && rec.node_id !== null && rec.container_name !== null;
      const hasNoWarmRecoveryLocator =
        rec.sandbox_id === null && rec.node_id === null && rec.container_name === null;
      if (
        recoveringWarmCredentialFence &&
        !hasCompleteWarmRecoveryLocator &&
        !hasNoWarmRecoveryLocator
      ) {
        return {
          success: false,
          error: "Warm-claim recovery locator is incomplete",
        } as const;
      }
      const recoveringWarmCredential =
        recoveringWarmCredentialFence &&
        (hasCompleteWarmRecoveryLocator || hasNoWarmRecoveryLocator);
      if ((rec.status === "provisioning" && !recoveringWarmCredential) || hasActiveProvisionJob) {
        return {
          success: false,
          error: "Agent provisioning is in progress",
        } as const;
      }

      if (
        rec.status === "running" &&
        rec.bridge_url &&
        !captureUnsupported &&
        !captureWaivedByOperator
      ) {
        // The exact capture authority was checked above. Keep the returned URL
        // assertion as an additional response-integrity check: a helper must
        // never return bytes attributed to a different bridge than it dialled.
        if (!preShutdownSnapshot || rec.bridge_url !== preShutdownSnapshot.bridgeUrl) {
          return {
            success: false,
            error:
              "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
          } as const;
        }
        await this.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-shutdown",
          preShutdownSnapshot.stateData,
          preShutdownSnapshot.sizeBytes,
        );
      }

      if (rec.sandbox_id) {
        const stop = await this.runBoundedSandboxStopForReplacement(rec.sandbox_id);
        if (stop) {
          const error = stop.error instanceof Error ? stop.error.message : String(stop.error);
          logger.warn("[agent-sandbox] Stop failed during shutdown", {
            sandboxId: rec.sandbox_id,
            status: rec.status,
            error,
          });
          return {
            success: false,
            error: "Failed to prove the previous sandbox stopped",
          } as const;
        }
      }

      // `getAgentForLifecycleMutation()` holds this exact row FOR UPDATE through
      // the provider absence proof and write. The locked tier guard above
      // therefore makes the allowlist predicate stable; it is a final SQL
      // backstop, not an unchecked optimistic CAS that can silently lose a tier
      // race after the container has stopped.
      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          updated_at = NOW()
        WHERE id = ${rec.id}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
      `);

      snapshotAgentId = rec.id;
      if (captureWaivedByOperator) {
        return { success: true, stateLossAcknowledged: true } as const;
      }
      return { success: true } as const;
    });

    if (result.success && snapshotAgentId) {
      await agentSandboxesRepository.pruneBackups(snapshotAgentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after shutdown", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("[agent-sandbox] Shutdown complete", {
        agentId,
        stateLossAcknowledged: captureWaivedByOperator || undefined,
      });
    }

    return result;
  }

  /**
   * Backup gate run before `executeSuspend` stops a data-bearing container
   * (#20726 item 6: every destructive lifecycle / billing freeze proves a
   * restorable backup first). The provider stop drops the container from its
   * node, so container-local state that never reached a durable backup would
   * be lost silently. Mirrors the sleep gate exactly: a live capture when the
   * bridge is reachable, a transient capture signal deferring to the job
   * retry loop, and any other capture failure — including an image with no
   * snapshot endpoint — falling through to a proven-restorable existing
   * backup via the wake integrity gate. Suspend keeps state for a later
   * resume, so unlike delete there is no state-loss waiver: an uncapturable
   * container with no durable backup refuses rather than discarding the only
   * copy. A refusal leaves the container running; a
   * billing-request suspend surfaces through the stop-intent retry /
   * terminal-attention machinery instead of destroying state.
   */
  private async prepareSuspendBackupGate(rec: AgentSandbox): Promise<
    | { outcome: "skip" }
    | {
        outcome: "proceed";
        backupId?: string;
        capturedFresh: boolean;
        pendingSnapshot?: { stateData: AgentBackupStateData; sizeBytes: number };
      }
    | { outcome: "refuse"; error: string }
  > {
    if (
      !rec.sandbox_id ||
      !isContainerBackedExecutionTier(rec.execution_tier) ||
      (rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed")
    ) {
      return { outcome: "skip" };
    }
    if (rec.bridge_url) {
      try {
        const { stateData, sizeBytes } = await this.fetchSnapshotState(rec);
        // Network capture is intentionally outside the write transaction. The
        // backup row itself is inserted only after the authoritative locked
        // tier/generation revalidation in executeSuspend.
        return {
          outcome: "proceed",
          capturedFresh: true,
          pendingSnapshot: { stateData, sizeBytes },
        };
      } catch (error) {
        // error-policy:J1 the suspend command boundary translates capture
        // failures into an explicit disposition: a transient signal defers to
        // the job retry loop, and anything else — including an image with no
        // snapshot endpoint — falls through to the proven-existing-backup
        // gate below (retrying an unsupported capture can never succeed, and
        // an unbacked-up container must not be dropped).
        const message = error instanceof Error ? error.message : String(error);
        if (message === SNAPSHOT_CAPTURE_TRANSIENT) {
          logger.warn("[agent-sandbox] Suspend deferred: capture transiently unavailable", {
            agentId: rec.id,
          });
          return {
            outcome: "refuse",
            error: `Refusing to stop without a current backup: ${message}`,
          };
        }
        logger.warn(
          "[agent-sandbox] Suspend snapshot fetch failed; checking latest durable backup",
          { agentId: rec.id, error: message },
        );
      }
    }
    const gate = await runWakeRestoreIntegrityGate({
      sandboxRecordId: rec.id,
      agentName: rec.agent_name,
    });
    if (!gate.ok) {
      logger.error("[agent-sandbox] Suspend refused: no restorable backup proven", {
        agentId: rec.id,
        failure: gate.failure.kind,
      });
      return {
        outcome: "refuse",
        error: `Refusing to stop on an unproven backup; agent was left running. ${formatWakeRestoreIntegrityError(gate.failure)}`,
      };
    }
    if (gate.backupId) {
      return { outcome: "proceed", backupId: gate.backupId, capturedFresh: false };
    }
    if (gate.verification === "disabled") {
      const existing = await agentSandboxesRepository.getLatestBackup(rec.id);
      if (existing) return { outcome: "proceed", backupId: existing.id, capturedFresh: false };
    }
    return {
      outcome: "refuse",
      error: "Unable to create or find a durable backup before stopping; agent was left running.",
    };
  }

  /**
   * Daemon-side handler for the `agent_suspend` job. Proves a durable backup
   * (see `prepareSuspendBackupGate`), calls the provider's absence-proof
   * replacement stop, flips the DB row to `stopped`, and clears bridge/health
   * URLs — but keeps `sandbox_id` and the per-tenant managed DB so a
   * subsequent `agent_resume` re-provisions against the retained state.
   * Replaces the Worker-callable `shutdown()` path which cannot reach SSH.
   */
  async executeSuspend(
    agentId: string,
    orgId: string,
    jobId: string,
    authorization: "user_request" | "billing_request" = "user_request",
    expectedLifecycleRevision?: number,
  ): Promise<AgentSuspendExecutionResult> {
    // Modern jobs carry their exact intent generation. Check it before the
    // backup gate so a lifecycle-stale queued request is a terminal no-op and
    // cannot touch either the snapshot bridge or the compute provider.
    if (expectedLifecycleRevision !== undefined) {
      const preflight = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, agentId, orgId);
        const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!rec || rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent not found",
          } as const;
        }
        const [intent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.agent_id, agentId),
              eq(agentComputeStopIntents.organization_id, orgId),
              eq(agentComputeStopIntents.job_id, jobId),
            ),
          )
          .for("update")
          .limit(1);
        if (!intent) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent stop intent is missing or bound to a different job",
          } as const;
        }
        if (intent.lifecycle_revision !== expectedLifecycleRevision) {
          return {
            success: false,
            containerStopped: false,
            error: "Agent suspend job and stop intent lifecycle revisions do not match",
          } as const;
        }
        if (intent.status === "provider_confirmed") {
          return { success: true, containerStopped: true } as const;
        }
        if (intent.status === "superseded") {
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason:
              intent.last_error === "lifecycle_changed" || intent.last_error === "billing_recovered"
                ? intent.last_error
                : "stop_intent_superseded",
          } as const;
        }
        if (rec.lifecycle_revision !== intent.lifecycle_revision) {
          const supersededAt = new Date();
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "lifecycle_changed",
              superseded_at: supersededAt,
              updated_at: supersededAt,
            })
            .where(eq(agentComputeStopIntents.id, intent.id));
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason: "lifecycle_changed",
          } as const;
        }
        return undefined;
      });
      if (preflight) return preflight;
    }

    // The backup is captured without holding the lifecycle lock (an HTTP
    // round-trip must not pin a write transaction); the lifecycle generation
    // is revalidated under the lock before the stop.
    let snapshotSource = await this.getAgentForWrite(agentId, orgId);
    if (!snapshotSource) {
      return { success: false, containerStopped: false, error: "Agent not found" };
    }
    const initialTierRejection = containerBackedServiceRejection(snapshotSource, "suspend");
    if (initialTierRejection) {
      return { success: false, containerStopped: false, error: initialTierRejection };
    }
    if (snapshotSource.deletion_attempt_id || this.isAwaitingDeletion(snapshotSource.status)) {
      return { success: false, containerStopped: false, error: "Agent not found" };
    }
    let suspendBackupId: string | undefined;
    let backupCapturedFresh = false;
    let pendingSuspendSnapshot: { stateData: AgentBackupStateData; sizeBytes: number } | undefined;
    if (snapshotSource.status !== "stopped") {
      const revalidated = await this.revalidateContainerBackedLifecycleGeneration(
        snapshotSource,
        "suspend",
      );
      if (!revalidated) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        };
      }
      snapshotSource = revalidated;
      const gateResult = await this.prepareSuspendBackupGate(snapshotSource);
      if (gateResult.outcome === "refuse") {
        return { success: false, containerStopped: false, error: gateResult.error };
      }
      if (gateResult.outcome === "proceed") {
        suspendBackupId = gateResult.backupId;
        pendingSuspendSnapshot = gateResult.pendingSnapshot;
      }
    }
    const result = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec)
        return {
          success: false,
          containerStopped: false,
          error: "Agent not found",
        } as const;
      const tierRejection = containerBackedServiceRejection(rec, "suspend");
      if (tierRejection) {
        return {
          success: false,
          containerStopped: false,
          error: tierRejection,
        } as const;
      }
      if (rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent not found",
        } as const;
      }
      if (this.getReplacementCleanupLocator(rec)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent replacement cleanup is still pending",
        } as const;
      }

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent provisioning is in progress",
        } as const;
      }
      const requiresBoundIntent =
        expectedLifecycleRevision !== undefined || authorization === "billing_request";
      const [stopIntent] = requiresBoundIntent
        ? await tx
            .select()
            .from(agentComputeStopIntents)
            .where(
              and(
                eq(agentComputeStopIntents.agent_id, agentId),
                eq(agentComputeStopIntents.organization_id, orgId),
                eq(agentComputeStopIntents.job_id, jobId),
              ),
            )
            .for("update")
            .limit(1)
        : [undefined];
      if (requiresBoundIntent && !stopIntent) {
        return {
          success: false,
          containerStopped: false,
          error:
            authorization === "billing_request"
              ? "Agent billing stop intent is missing or bound to a different job"
              : "Agent stop intent is missing or bound to a different job",
        } as const;
      }
      if (
        stopIntent &&
        expectedLifecycleRevision !== undefined &&
        stopIntent.lifecycle_revision !== expectedLifecycleRevision
      ) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent suspend job and stop intent lifecycle revisions do not match",
        } as const;
      }
      const effectiveAuthorization = stopIntent?.authorization ?? authorization;
      if (stopIntent?.status === "provider_confirmed") {
        return { success: true, containerStopped: true } as const;
      }
      if (stopIntent?.status === "superseded") {
        return {
          success: true,
          containerStopped: false,
          skipped: true,
          reason:
            stopIntent.last_error === "lifecycle_changed" ||
            stopIntent.last_error === "billing_recovered"
              ? stopIntent.last_error
              : "stop_intent_superseded",
        } as const;
      }
      if (stopIntent && stopIntent.lifecycle_revision !== rec.lifecycle_revision) {
        const supersededAt = new Date();
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "superseded",
            last_error: "lifecycle_changed",
            superseded_at: supersededAt,
            updated_at: supersededAt,
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
        return {
          success: true,
          containerStopped: false,
          skipped: true,
          reason: "lifecycle_changed",
        } as const;
      }
      if (effectiveAuthorization === "billing_request") {
        const fundedAt = new Date();
        const settlement =
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            orgId,
            fundedAt,
          );
        if (settlement.status !== "insufficient_credits") {
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "superseded",
              last_error: "billing_recovered",
              superseded_at: fundedAt,
              updated_at: fundedAt,
            })
            .where(eq(agentComputeStopIntents.id, stopIntent!.id));
          await tx
            .update(agentSandboxes)
            .set({
              billing_status: "active",
              shutdown_warning_sent_at: null,
              scheduled_shutdown_at: null,
              updated_at: fundedAt,
            })
            .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
          return {
            success: true,
            containerStopped: false,
            skipped: true,
            reason: "billing_recovered",
          } as const;
        }
      }

      // A stopped sandbox with a durable backup remains billable storage. A
      // billing stop queued before a top-up must therefore settle and observe
      // the restored funding above before this physical-state fast path can
      // suspend billing permanently. Explicit user stops remain unconditional.
      if (rec.status === "stopped") {
        const confirmedAt = new Date();
        if (effectiveAuthorization === "user_request") {
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            orgId,
            confirmedAt,
          );
        }
        const retainedBackupBilling = rec.last_backup_at !== null;
        await tx
          .update(agentSandboxes)
          .set({
            billing_status: retainedBackupBilling ? "active" : "suspended",
            scheduled_shutdown_at: null,
            shutdown_warning_sent_at: null,
            bridge_url: null,
            health_url: null,
            updated_at: confirmedAt,
          })
          .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)));
        if (stopIntent) {
          await tx
            .update(agentComputeStopIntents)
            .set({
              status: "provider_confirmed",
              provider_confirmed_at: confirmedAt,
              retained_backup_billing: retainedBackupBilling,
              retained_backup_rate_per_hour: retainedBackupBilling
                ? String(AGENT_PRICING.IDLE_HOURLY_RATE)
                : null,
              updated_at: confirmedAt,
            })
            .where(eq(agentComputeStopIntents.id, stopIntent.id));
        }
        return { success: true, containerStopped: true } as const;
      }

      // The gate captured against snapshotSource's generation; a moved
      // lifecycle means the backup may not cover the container being stopped.
      if (!snapshotCaptureStillCanonical(rec, snapshotSource)) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        } as const;
      }

      if (pendingSuspendSnapshot) {
        const persisted = await this.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-shutdown",
          pendingSuspendSnapshot.stateData,
          pendingSuspendSnapshot.sizeBytes,
        );
        suspendBackupId = persisted.backupId;
        backupCapturedFresh = true;
      }

      let containerStopped = false;
      const attempt = (stopIntent?.attempts ?? 0) + 1;
      if (stopIntent) {
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "dispatching",
            attempts: attempt,
            provider_started_at: new Date(),
            last_error: null,
            updated_at: new Date(),
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
      }
      if (rec.sandbox_id) {
        const stop = await this.runBoundedSandboxStopForReplacement(rec.sandbox_id);
        if (stop) {
          if (stopIntent) {
            const failedAt = new Date();
            await tx
              .update(agentComputeStopIntents)
              .set({
                status: attempt >= 3 ? "terminal_attention" : "retry",
                last_error: stop.error instanceof Error ? stop.error.message : String(stop.error),
                next_attempt_at: new Date(failedAt.getTime() + 5 * 60 * 1000),
                updated_at: failedAt,
              })
              .where(eq(agentComputeStopIntents.id, stopIntent.id));
          }
          return {
            success: false,
            containerStopped: false,
            error: stop.error instanceof Error ? stop.error.message : String(stop.error),
          } as const;
        }
        containerStopped = true;
      } else {
        containerStopped = true;
      }

      const confirmedAt = new Date();
      if (effectiveAuthorization === "user_request") {
        await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
          tx,
          agentId,
          orgId,
          confirmedAt,
        );
      }
      const retainedBackupBilling = backupCapturedFresh || rec.last_backup_at !== null;
      // The lifecycle row remains FOR UPDATE from the locked tier check through
      // provider stop and persistence, so this final allowlist cannot become a
      // zero-row tier race. It mirrors the guard in SQL as defense in depth.
      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET status = 'stopped',
            billing_status = ${retainedBackupBilling ? "active" : "suspended"},
            scheduled_shutdown_at = NULL, shutdown_warning_sent_at = NULL,
            bridge_url = NULL, health_url = NULL, updated_at = NOW()
            ${backupCapturedFresh ? sql`, last_backup_at = NOW()` : sql``}
        WHERE id = ${rec.id}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
      `);
      if (stopIntent) {
        await tx
          .update(agentComputeStopIntents)
          .set({
            status: "provider_confirmed",
            provider_confirmed_at: confirmedAt,
            retained_backup_billing: retainedBackupBilling,
            retained_backup_rate_per_hour: retainedBackupBilling
              ? String(AGENT_PRICING.IDLE_HOURLY_RATE)
              : null,
            updated_at: confirmedAt,
          })
          .where(eq(agentComputeStopIntents.id, stopIntent.id));
      }
      return { success: true, containerStopped, backupId: suspendBackupId } as const;
    });
    if (result.success && backupCapturedFresh) {
      // error-policy:J6 pruning is retention housekeeping after the suspend
      // committed; its failure is logged, never surfaced as a suspend failure.
      await agentSandboxesRepository.pruneBackups(agentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after suspend", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return result;
  }

  /**
   * A row in `deletion_pending` / `deletion_failed` is logically gone — an
   * agent_delete job owns it. Bringing it back up (resume / wake / restart)
   * would resurrect a container we are tearing down, so these states are
   * treated exactly like a missing row: the daemon handler maps "Agent not
   * found" to a terminal no-op instead of resurrecting the agent.
   */
  private isAwaitingDeletion(status: AgentSandboxStatus): boolean {
    return status === "deletion_pending" || status === "deletion_failed";
  }

  /**
   * Daemon-side handler for the `agent_resume` job. Delegates to
   * `provision()` which restores `bridge_url` / `health_url` from the
   * provider's sandbox handle and reuses the existing shared DB
   * (`sandbox_id` is retained across suspend). `provision()` acquires
   * its own advisory lock, so two concurrent resume jobs serialize.
   *
   * A future fast path will `docker start` the existing container (~5s)
   * when the provider exposes a standalone `start()` method that
   * returns a fresh handle — today the only way to get `bridgeUrl` /
   * `healthUrl` back is via the create-or-restart flow inside
   * `provision()`, so we always pay that path.
   */
  async executeResume(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerStarted: boolean;
    reprovisioned: boolean;
    error?: string;
  }> {
    // Read from the PRIMARY: a replica-lagged "Agent not found" / stale status
    // here would turn a legitimate resume into a terminal no-op (the daemon
    // maps "Agent not found" to completed), silently dropping the request. The
    // existence + deletion-state check must be authoritative.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec || rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status))
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Agent not found",
      };
    const tierRejection = rejectNonContainerBackedProvision(rec);
    if (tierRejection) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: tierRejection.error,
      };
    }

    if (rec.status === "running")
      return { success: true, containerStarted: true, reprovisioned: false };

    const fundingAuthority = await this.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before resume billing settlement",
      };
    }

    const funding = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      agentId,
      orgId,
      new Date(),
    );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }

    const provisionResult = await this.provision(agentId, orgId);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: true,
        error: provisionResult.error,
      };
    }
    return { success: true, containerStarted: true, reprovisioned: true };
  }

  /**
   * Daemon-side handler for the `agent_sleep` job — deep, cold suspend.
   *
   * Both suspend and sleep drop the container + free the node slot; unlike
   * `agent_suspend` (which keeps the row's `sandbox_id` + managed DB for an
   * in-place resume), sleep frees the compute identity entirely:
   *   1. Capture a durable backup. A live `/api/snapshot` pull when the agent
   *      is reachable, otherwise the latest existing backup. If neither exists,
   *      sleep fails and leaves compute running so missing state is observable.
   *   2. Stop + drop the container (the provider `stop` removes it from the
   *      node).
   *   3. Clear the compute identity (`sandbox_id`, `node_id`, `container_name`,
   *      ports, bridge/health URLs) so the slot is freed; the node autoscaler
   *      reclaims a now-empty Hetzner box on its next pass. The shared DB,
   *      `environment_vars`, and `docker_image` are retained for wake.
   *   4. Flip status to `sleeping`. No compute cost accrues while sleeping.
   *
   * The inverse is `executeWake`.
   */
  async executeSleep(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerRemoved: boolean;
    backupId?: string;
    error?: string;
  }> {
    // Primary read: replica lag must not turn a real sleep into a no-op.
    let rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec) return { success: false, containerRemoved: false, error: "Agent not found" };
    const initialTierRejection = containerBackedServiceRejection(rec, "sleep");
    if (initialTierRejection) {
      return { success: false, containerRemoved: false, error: initialTierRejection };
    }
    if (rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
      return { success: false, containerRemoved: false, error: "Agent not found" };
    }
    if (this.getReplacementCleanupLocator(rec)) {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent replacement cleanup is still pending",
      };
    }
    if (rec.status === "sleeping") return { success: true, containerRemoved: true };
    if (rec.status === "provisioning") {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent provisioning is in progress",
      };
    }

    const revalidated = await this.revalidateContainerBackedLifecycleGeneration(rec, "sleep");
    if (!revalidated) {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      };
    }
    rec = revalidated;

    // 1. Durable backup before compute is freed.
    let backupId: string | undefined;
    let pendingSleepSnapshot: { stateData: AgentBackupStateData; sizeBytes: number } | undefined;
    if (rec.status === "running" && rec.bridge_url) {
      try {
        const { stateData, sizeBytes } = await this.fetchSnapshotState(rec);
        pendingSleepSnapshot = { stateData, sizeBytes };
      } catch (error) {
        logger.warn("[agent-sandbox] Sleep snapshot fetch failed; checking latest durable backup", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!backupId && !pendingSleepSnapshot) {
      // The fallback destroys newer compute state in favor of whatever this
      // resolves to, so "a backup row exists" is not enough: it must be PROVEN
      // restorable (fresh verified stamp, or a live decrypt+chain+hash
      // verification right now) before the container is stopped. The wake gate
      // already implements exactly that proof, alternative scan included.
      const gate = await runWakeRestoreIntegrityGate({
        sandboxRecordId: rec.id,
        agentName: rec.agent_name,
      });
      if (!gate.ok) {
        logger.error("[agent-sandbox] Sleep aborted: no restorable backup proven", {
          agentId,
          sandboxRecordId: rec.id,
          failure: gate.failure.kind,
        });
        return {
          success: false,
          containerRemoved: false,
          error: `Refusing to deactivate on an unproven backup; agent was left running. ${formatWakeRestoreIntegrityError(gate.failure)}`,
        };
      }
      if (gate.backupId) {
        backupId = gate.backupId;
      } else if (gate.verification === "disabled") {
        // Kill switch: with the gate off, keep the pre-gate behavior of
        // accepting the latest backup rather than inventing a third mode.
        const existing = await agentSandboxesRepository.getLatestBackup(rec.id);
        if (existing) backupId = existing.id;
      }
      if (!backupId) {
        logger.error("[agent-sandbox] Sleep aborted: no durable backup available", {
          agentId,
          sandboxRecordId: rec.id,
        });
        return {
          success: false,
          containerRemoved: false,
          error:
            "Unable to create or find a durable backup before deactivation; agent was left running.",
        };
      }
    }

    // The backup is intentionally captured without holding a database lock.
    // Revalidate the database-owned generation under the advisory/row locks,
    // then keep those locks through absence proof and the locator clear.
    const sleepCommit = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Agent not found",
        };
      }
      const tierRejection = containerBackedServiceRejection(current, "sleep");
      if (tierRejection) {
        return {
          success: false as const,
          containerRemoved: false,
          error: tierRejection,
        };
      }
      if (current.deletion_attempt_id || this.isAwaitingDeletion(current.status)) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Agent not found",
        };
      }
      if (this.getReplacementCleanupLocator(current)) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Agent replacement cleanup is still pending",
        };
      }
      if (
        current.status === "provisioning" ||
        (await this.hasActiveReplacementJobTx(tx, agentId, orgId))
      ) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Agent provisioning is in progress",
        };
      }

      if (!snapshotCaptureStillCanonical(current, rec)) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Agent lifecycle changed while sleep was prepared",
        };
      }
      let commitLifecycleRevision = current.lifecycle_revision;
      if (pendingSleepSnapshot) {
        const persisted = await this.persistSnapshotWithinTransaction(
          tx,
          current.id,
          current.organization_id,
          "pre-shutdown",
          pendingSleepSnapshot.stateData,
          pendingSleepSnapshot.sizeBytes,
        );
        backupId = persisted.backupId;
        commitLifecycleRevision = persisted.lifecycleRevision;
      }
      if (!current.sandbox_id && (current.node_id || current.container_name)) {
        return {
          success: false as const,
          containerRemoved: false,
          error: "Sandbox locator is incomplete; compute was left unchanged",
        };
      }

      if (current.sandbox_id) {
        const stop = await this.runBoundedSandboxStopForReplacement(current.sandbox_id);
        if (stop) {
          return {
            success: false as const,
            containerRemoved: false,
            error: stop.error instanceof Error ? stop.error.message : String(stop.error),
          };
        }
      }

      const cleared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'sleeping',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          node_id = NULL,
          container_name = NULL,
          headscale_ip = NULL,
          bridge_port = NULL,
          web_ui_port = NULL,
          last_backup_at = NOW(),
          updated_at = NOW()
        WHERE id = ${current.id}
          AND organization_id = ${orgId}
          AND status = ${current.status}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND sandbox_id IS NOT DISTINCT FROM ${current.sandbox_id}
          AND node_id IS NOT DISTINCT FROM ${current.node_id}
          AND container_name IS NOT DISTINCT FROM ${current.container_name}
          AND environment_revision = ${current.environment_revision}
          AND lifecycle_revision = ${commitLifecycleRevision}
        RETURNING id
      `);
      if (cleared.rows.length !== 1) {
        throw new Error("Sleep lost its lifecycle generation CAS");
      }
      return {
        success: true as const,
        containerRemoved: true,
      };
    });
    if (!sleepCommit.success) return sleepCommit;

    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS).catch((error) => {
      logger.warn("[agent-sandbox] Backup pruning failed after sleep", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info("[agent-sandbox] Sleep complete", {
      agentId,
      backupId,
      containerRemoved: sleepCommit.containerRemoved,
    });
    return { success: true, containerRemoved: sleepCommit.containerRemoved, backupId };
  }

  /**
   * Daemon-side handler for the `agent_wake` job — the inverse of sleep.
   *
   * The backup being restored IS the sleeping agent's entire durable state
   * (sleep already discarded the compute identity), so before provisioning
   * anything the wake runs the restore-integrity gate (#15603 B6): the backup
   * the restore will apply must decrypt, chain-replay, and hash-verify. A
   * failed gate fails the wake with a typed, user-legible error and leaves
   * the sandbox `sleeping` — never a silent fresh boot. The explicit escape
   * hatches are `opts.restoreBackupId` (wake from an older validated backup)
   * and `opts.forceFreshBoot` (boot empty, accepting the data loss); both are
   * opt-ins surfaced on the wake route, never defaults.
   *
   * On a clean gate, provisions a fresh container (claiming a warm-pool slot
   * when available) and restores the validated backup. Idempotent: waking an
   * already-running agent is a no-op.
   */
  async executeWake(
    agentId: string,
    orgId: string,
    opts?: { restoreBackupId?: string; forceFreshBoot?: boolean },
  ): Promise<{
    success: boolean;
    reprovisioned: boolean;
    restoredBackupId?: string;
    /** True when the wake deliberately booted empty via `forceFreshBoot`. */
    freshBoot?: boolean;
    /** Structured gate failure; set exactly when the wake was blocked by the integrity gate. */
    integrityFailure?: WakeRestoreIntegrityFailure;
    error?: string;
  }> {
    // Primary read: a replica-lagged "Agent not found" must not no-op a wake.
    let rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec) return { success: false, reprovisioned: false, error: "Agent not found" };
    const tierRejection = containerBackedServiceRejection(rec, "wake");
    if (tierRejection) {
      return { success: false, reprovisioned: false, error: tierRejection };
    }
    if (rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
      return { success: false, reprovisioned: false, error: "Agent not found" };
    }
    if (rec.status === "running" && rec.bridge_url) {
      return { success: true, reprovisioned: false };
    }
    if (opts?.restoreBackupId && opts?.forceFreshBoot) {
      // The route rejects this combination; enforced here too so a hand-crafted
      // job row cannot smuggle an ambiguous instruction past the gate.
      return {
        success: false,
        reprovisioned: false,
        error: "restoreBackupId and forceFreshBoot are mutually exclusive",
      };
    }
    const fundingAuthority = await this.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before wake billing settlement",
      };
    }
    rec = fundingAuthority;
    const funding = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      agentId,
      orgId,
      new Date(),
    );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }

    const gateSource = await this.getAgentForWrite(agentId, orgId);
    if (!gateSource || !isContainerBackedExecutionTier(gateSource.execution_tier)) {
      return {
        success: false,
        reprovisioned: false,
        error: gateSource ? containerBackedServiceRejection(gateSource, "wake") : "Agent not found",
      };
    }
    const gateAuthority = await this.revalidateContainerBackedLifecycleGeneration(
      gateSource,
      "wake",
    );
    if (!gateAuthority) {
      return {
        success: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before wake restore validation",
      };
    }
    rec = gateAuthority;

    if (opts?.forceFreshBoot) {
      logger.warn("[agent-sandbox] Wake with explicit forceFreshBoot: restore skipped by user", {
        agentId,
      });
      const provisionResult = await this.provision(agentId, orgId, { kind: "fresh-boot" });
      if (!provisionResult.success) {
        return { success: false, reprovisioned: true, error: provisionResult.error };
      }
      logger.info("[agent-sandbox] Wake complete (explicit fresh boot)", { agentId });
      return { success: true, reprovisioned: true, freshBoot: true };
    }

    // Gate BEFORE any compute side effect: on failure nothing has been
    // provisioned or torn down, so the row simply stays `sleeping`.
    const gate = await runWakeRestoreIntegrityGate({
      sandboxRecordId: rec.id,
      agentName: rec.agent_name,
      requestedBackupId: opts?.restoreBackupId,
    });
    if (!gate.ok) {
      return {
        success: false,
        reprovisioned: false,
        error: formatWakeRestoreIntegrityError(gate.failure),
        integrityFailure: gate.failure,
      };
    }

    // Restore through provision's explicit from-backup path whenever the gate
    // validated a concrete backup — including the default (latest) wake. The
    // override disables provision's unrecoverable-snapshot degrade, so a
    // restore failure FAILS the provision (retryable, chain preserved) instead
    // of booting empty and pruning every backup. That degrade is designed for
    // a running agent losing volatile session state; on a wake the backup IS
    // the agent, and the fresh-stamp gate path never touches the stored bytes,
    // so provision's restore is the first real read. `gate.backupId` is null
    // only when there is nothing to restore (no-backup) or the kill switch
    // reverted the wake to the ungated legacy latest-backup behavior.
    const restoreOverride: ProvisionRestoreOverride | undefined = gate.backupId
      ? { kind: "from-backup", backupId: gate.backupId }
      : undefined;
    // Kill-switch wakes keep the pre-gate report shape: provision auto-restores
    // the latest backup, so name its id (metadata read only — no eager decrypt
    // of a possibly-corrupt envelope on the deliberately-ungated path).
    const restoredBackupId =
      gate.verification === "disabled" && !gate.backupId
        ? (await agentSandboxesRepository.getLatestStoredBackup(rec.id))?.id
        : (gate.backupId ?? undefined);

    const provisionResult = await this.provision(agentId, orgId, restoreOverride);
    if (!provisionResult.success) {
      return { success: false, reprovisioned: true, error: provisionResult.error };
    }

    logger.info("[agent-sandbox] Wake complete", {
      agentId,
      restoredBackupId,
      verification: gate.verification,
    });
    return { success: true, reprovisioned: true, restoredBackupId };
  }

  /**
   * Daemon-side handler for the `agent_restart` job. Runs `shutdown()`
   * (SSH stop + DB to stopped) and then `provision()` (recreate
   * container + restore URLs). Replaces the Worker-side sequence which
   * silently no-op'd the SSH stop and left the old container running
   * alongside the new one.
   *
   * A replacement is created only after the provider positively proves the old
   * workload stopped. Treating an unreachable node as gone can revive two live
   * agents when that node returns, so shutdown failure keeps the row fenced and
   * fails this restart for the durable job retry.
   */
  async executeRestart(
    agentId: string,
    orgId: string,
    options?: { readonly stateLossAcknowledged?: boolean },
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    containerStarted: boolean;
    bridgeUrl?: string;
    healthUrl?: string;
    error?: string;
    retryable?: boolean;
  }> {
    // Bail before shutdown()+provision() if the row is being deleted — restart
    // would otherwise flip a deletion_pending row to `stopped` and rebuild a
    // container the agent_delete job is tearing down. Reported as not-found so
    // the daemon handler completes the job as a terminal no-op. Read from the
    // PRIMARY so a replica-lagged status doesn't bail a legitimate restart (or
    // miss an in-flight deletion) on stale data.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent not found",
      };
    }
    const tierRejection = containerBackedServiceRejection(rec, "restart");
    if (tierRejection) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: tierRejection,
      };
    }
    if (rec.deletion_attempt_id || this.isAwaitingDeletion(rec.status)) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent not found",
      };
    }
    const fundingAuthority = await this.getAgentForWrite(agentId, orgId);
    if (
      !fundingAuthority ||
      !isContainerBackedExecutionTier(fundingAuthority.execution_tier) ||
      fundingAuthority.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent lifecycle changed before restart billing settlement",
      };
    }
    const funding = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      agentId,
      orgId,
      new Date(),
    );
    if (funding.status === "insufficient_credits") {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      };
    }
    if (rec.claimed_at && rec.warm_claim_credential_state === null) {
      await this.prepareLegacyWarmClaimCredentialRecovery(agentId, orgId);
    }

    const shutdownResult = await this.shutdown(agentId, orgId, {
      stateLossAcknowledged: options?.stateLossAcknowledged,
    });
    if (!shutdownResult.success) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        // Propagate retryability: a transient pre-stop capture failure (PGlite
        // closing race) must re-queue the restart, not permanently wedge a
        // healthy agent (2026-08-11 fleet incident).
        retryable: shutdownResult.retryable,
        error: shutdownResult.error ?? "Failed to stop sandbox before restart",
      };
    }

    const provisionResult = await this.provision(agentId, orgId);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStopped: shutdownResult.success,
        containerStarted: false,
        error: provisionResult.error,
      };
    }

    if (rec.claimed_at && rec.warm_claim_credential_state !== "ready") {
      try {
        await this.recoverPendingWarmClaimInferenceKey(agentId, orgId);
      } catch (error) {
        // error-policy:J1 restart boundary translation — credential recovery
        // failure is returned explicitly instead of claiming the restart succeeded.
        return {
          success: false,
          containerStopped: shutdownResult.success,
          containerStarted: true,
          error: `${WARM_CLAIM_RECOVERY_FAILURE_PREFIX} ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    return {
      success: true,
      containerStopped: shutdownResult.success,
      containerStarted: true,
      bridgeUrl: provisionResult.bridgeUrl,
      healthUrl: provisionResult.healthUrl,
    };
  }

  /** Runs the ordinary same-repository fleet blue/green upgrade policy. */
  async executeUpgrade(
    agentId: string,
    orgId: string,
    toDigest: string,
    dockerImage: string,
    fromDigest: string | null,
  ): Promise<ImageSwapResult> {
    return await this.executeUpgradeWithPolicy(agentId, orgId, toDigest, dockerImage, fromDigest);
  }

  /**
   * Executes the dedicated cross-repository canary policy. Callers must have
   * already created an audited admin-canary job; the ordinary fleet method
   * remains same-repository-only.
   */
  async executeAdminCanaryUpgrade(params: {
    agentId: string;
    organizationId: string;
    targetOwnerUserId: string;
    sourceImage: string;
    sourceDigest: string;
    targetImage: string;
    targetDigest: string;
    onCutoverInTx: AdminCanaryImageExecutionPolicy["onCutoverInTx"];
    onConvergedInTx: AdminCanaryImageExecutionPolicy["onConvergedInTx"];
  }): Promise<ImageSwapResult> {
    assertSha256Digest(params.sourceDigest, "sourceDigest");
    assertAdminCanaryCanonicalOrDemoPair(params.sourceImage, params.sourceDigest, "sourceImage");
    const target = parseAdminCanaryDemoImage(params.targetImage);
    if (target.digest !== params.targetDigest) {
      return { success: false, error: "Canary target image and digest do not match" };
    }
    return await this.executeUpgradeWithPolicy(
      params.agentId,
      params.organizationId,
      params.targetDigest,
      params.targetImage,
      params.sourceDigest,
      {
        operation: "upgrade",
        targetOwnerUserId: params.targetOwnerUserId,
        sourceImage: params.sourceImage,
        sourceDigest: params.sourceDigest,
        targetImage: params.targetImage,
        targetDigest: params.targetDigest,
        onCutoverInTx: params.onCutoverInTx,
        onConvergedInTx: params.onConvergedInTx,
      },
    );
  }

  /**
   * Daemon-side handler for the `agent_upgrade` job: blue/green swap an
   * agent onto the currently-deployed image.
   *
   * Flow:
   *   1. Snapshot the agent's current node + container info.
   *   2. Provision a fresh container (blue) on a *different* node — the
   *      provider's container name is deterministic (`agent-${id}`), so the
   *      blue must land on a different docker daemon. The provider's
   *      `excludeNodeId` makes this guarantee.
   *   3. Health-check blue, then gate on its `/api/health` runtime readiness:
   *      ready runtime, DB ok, and zero failed plugins. Plugin/database
   *      migrations run during blue startup, so this is the migration verify
   *      gate before any traffic cutover.
   *   4. Capture a pre-upgrade snapshot from the still-live old container.
   *   5. Atomic UPDATE: swap the row's bridge_url / node_id / container_name
   *      / image_digest. New HTTP requests hit blue from this point on.
   *   6. Atomically transfer the durable cleanup locator from blue to the old
   *      container, then prove the old container and VPN node absent before
   *      reporting full convergence.
   */
  private async executeUpgradeWithPolicy(
    agentId: string,
    orgId: string,
    toDigest: string,
    dockerImage: string,
    fromDigest: string | null,
    adminCanary?: AdminCanaryImageExecutionPolicy,
  ): Promise<ImageSwapResult> {
    let agent = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!agent) return { success: false, error: "Agent not found" };
    let tierRejection = containerBackedServiceRejection(agent, "upgrade");
    if (tierRejection) {
      return { success: false, rolledBack: true, error: tierRejection };
    }
    if (this.getReplacementCleanupLocator(agent)) {
      try {
        await this.retirePersistedReplacementCleanup(agentId, orgId);
      } catch (error) {
        // error-policy:J1 image-swap boundary translation — pending cleanup keeps
        // rollback ownership and returns an explicit non-success result.
        return {
          success: false,
          rolledBack: true,
          cleanupPending: true,
          error: `Replacement cleanup is still pending: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      agent = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
      if (!agent) return { success: false, error: "Agent not found" };
      tierRejection = containerBackedServiceRejection(agent, "upgrade");
      if (tierRejection) {
        return { success: false, rolledBack: true, error: tierRejection };
      }
    }
    if (!hasReadyWarmClaimCredential(agent)) {
      return {
        success: false,
        rolledBack: true,
        error: "Warm-claim credential handoff is not ready",
      };
    }
    if (agent.status !== "running") {
      // Genuinely-dead: the old container is not serving (status is not
      // running), so the terminal error writeback is correct here.
      return {
        success: false,
        rolledBack: false,
        error: `Agent not running (status: ${agent.status})`,
      };
    }
    if (!agent.sandbox_id || !agent.node_id || !agent.container_name) {
      // Shared-runtime / web-only row: nothing was torn down. The old serving
      // path is untouched. (These are already excluded by the reconciler.)
      return {
        success: false,
        rolledBack: true,
        error: "Agent has no sandbox_id, node_id, or container_name to upgrade from",
      };
    }
    const sourceEnvironmentRevision = agent.environment_revision;
    // Refuse a fleet upgrade only for a genuinely CUSTOM image (a different
    // repo than the fleet-managed default), NOT for a stale default-family
    // image pinned to an older tag. Comparing the full ref (`docker_image !==
    // dockerImage`) refused every agent on an older `ghcr.io/elizaos/eliza:sha-*`
    // tag, so sha-pinned default agents never received fleet upgrades (#15101).
    // The reconciler already selects them by digest drift; the blue/green swap
    // re-provisions on the target image+digest, so moving a fleet-managed agent
    // to the current default is safe regardless of its current tag.
    if (
      adminCanary &&
      (adminCanary.operation !== "upgrade" ||
        agent.user_id !== adminCanary.targetOwnerUserId ||
        adminCanary.targetImage !== dockerImage ||
        adminCanary.targetDigest !== toDigest ||
        adminCanary.sourceDigest !== fromDigest ||
        agent.docker_image !== adminCanary.sourceImage ||
        agent.image_digest !== adminCanary.sourceDigest)
    ) {
      return {
        success: false,
        rolledBack: true,
        error: "Agent does not match the audited canary source image pair",
      };
    }
    if (
      !adminCanary &&
      agent.docker_image &&
      imageRepo(agent.docker_image) !== imageRepo(dockerImage)
    ) {
      // Refusal before any container work: old container is untouched and live.
      return {
        success: false,
        rolledBack: true,
        error: "Agent uses a custom docker image; refusing fleet upgrade",
      };
    }

    const oldNodeId = agent.node_id;
    const oldContainerName = agent.container_name;
    const oldSandboxId = agent.sandbox_id;
    const oldNode = await dockerNodesRepository.findByNodeId(oldNodeId);
    if (!oldNode) {
      // We could not resolve the old node to do a blue provision, but we did NOT
      // touch the old container — it is still running wherever it was. Treat as
      // rollback-safe: the agent keeps serving on the old container.
      return {
        success: false,
        rolledBack: true,
        error: `Old node ${oldNodeId} not registered in docker_nodes`,
      };
    }
    if (!Number.isInteger(oldNode.allocated_count) || oldNode.allocated_count < 1) {
      return {
        success: false,
        rolledBack: true,
        error: `Old node ${oldNodeId} has no durable capacity ownership`,
      };
    }

    const provider = await this.getProvider();
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    if (!(provider instanceof DockerSandboxProvider)) {
      // No container work happened; old container is untouched and live.
      return {
        success: false,
        rolledBack: true,
        error: "Fleet upgrade only supported on docker provider",
      };
    }

    // Materialize at-rest-encrypted BYO secrets before container create (#11332).
    const upgradeEnv = await decryptAgentEnvVars(
      (agent.environment_vars as Record<string, string>) ?? {},
    );
    const config = {
      agentId,
      agentName: agent.agent_name ?? "",
      organizationId: orgId,
      executionTier: agent.execution_tier,
      // Re-apply the cloud-managed inference defaults on top of the stored env so
      // an agent provisioned BEFORE the embedding-dimension / model pins landed
      // heals on upgrade instead of freezing a stale config (e.g. 1536-d cloud
      // vectors written into a dim_384 column → dropped memory + ~30s/turn). This
      // backfills ONLY the 5 inference keys if missing and preserves everything
      // else verbatim (DATABASE_URL, ELIZA_API_TOKEN, ELIZAOS_CLOUD_API_KEY,
      // ELIZA_AGENT_LOCAL_STATE, PGLITE_DATA_DIR, ELIZA_PLUGIN_SET, ...) — the
      // narrow helper deliberately avoids the full provision merge, which would
      // mint a new API key / strip DATABASE_URL / flip local-state on upgrade (#8434).
      environmentVars: applyRemoteDockerRuntimeMode({
        ...upgradeEnv,
        ...applyManagedAgentInferenceEnvDefaults(upgradeEnv),
      }),
      dockerImage: digestPinnedImageRef(dockerImage, toDigest),
      excludeNodeId: oldNodeId,
      // Preserve the LIVE Headscale node during the overlap (#16565): the
      // provider records its id as metadata.previousVpnNodeId; it is deleted
      // by id below only after the atomic swap succeeds.
      reclaimStaleVpnNode: false,
      ...this.replacementCleanupCallbacks(agentId, orgId, {
        status: "running",
        environmentRevision: sourceEnvironmentRevision,
        sandboxId: oldSandboxId,
        nodeId: oldNodeId,
        containerName: oldContainerName,
      }),
    };

    let blueHandle: Awaited<ReturnType<typeof provider.create>>;
    try {
      blueHandle = await provider.create(config);
    } catch (err) {
      if (err instanceof SandboxReplacementCleanupUnresolvedError) {
        await this.persistUnresolvedReplacementCleanupFence(agentId, orgId, err);
      }
      return {
        success: false,
        rolledBack: true,
        cleanupPending: err instanceof SandboxReplacementCleanupUnresolvedError,
        oldNodeId,
        oldContainerName,
        error: `Blue provision failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const failBeforeUpgradeCutover = async (error: string): Promise<ImageSwapResult> => {
      try {
        await this.retirePersistedReplacementCleanup(agentId, orgId);
      } catch (cleanupError) {
        // error-policy:J1 pre-cutover boundary translation — unresolved retirement
        // is reported with cleanupPending while traffic remains on the old placement.
        return {
          success: false,
          rolledBack: true,
          cleanupPending: true,
          oldNodeId,
          oldContainerName,
          error: `${error}; replacement cleanup remains pending: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        };
      }
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error,
      };
    };

    if (!(await provider.checkHealth(blueHandle))) {
      return await failBeforeUpgradeCutover(
        "Blue health check failed; kept agent on old container",
      );
    }

    const blueMeta = isDockerSandboxMetadata(blueHandle.metadata) ? blueHandle.metadata : undefined;
    if (!blueMeta) {
      return await failBeforeUpgradeCutover("Blue provisioner returned non-docker metadata");
    }
    if (
      (adminCanary && !blueMeta.imageDigest) ||
      (blueMeta.imageDigest && blueMeta.imageDigest !== toDigest)
    ) {
      return await failBeforeUpgradeCutover(
        `Blue image digest mismatch: expected ${toDigest}, got ${blueMeta.imageDigest ?? "missing"}`,
      );
    }

    const runtimeHealth = await this.verifyReplacementRuntimeHealth({
      agent,
      bridgeUrl: blueHandle.bridgeUrl,
    });
    if (!runtimeHealth.success) {
      return await failBeforeUpgradeCutover(
        `Blue runtime readiness gate failed: ${runtimeHealth.error}`,
      );
    }

    // Capture a restore point on the OLD (still-live) container before the
    // cutover. This is the snapshot `executeDowngrade` replays when rolling
    // back. A missing/partial snapshot blocks the upgrade: swapping images
    // without a verified full-agent restore point is the data-loss class this
    // path is designed to prevent.
    const preUpgradeSnapshot = await this.snapshot(agentId, orgId, "pre-upgrade").catch((err) => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!preUpgradeSnapshot.success) {
      return await failBeforeUpgradeCutover(
        `Pre-upgrade snapshot failed: ${preUpgradeSnapshot.error ?? "unknown error"}`,
      );
    }

    try {
      const swapped = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, agentId, orgId);
        const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        const cleanupLocator = this.getReplacementCleanupLocator(current);
        if (
          containerBackedServiceRejection(current, "upgrade") ||
          current.status !== "running" ||
          current.node_id !== oldNodeId ||
          current.container_name !== oldContainerName ||
          current.sandbox_id !== oldSandboxId ||
          current.image_digest !== fromDigest ||
          current.environment_revision !== sourceEnvironmentRevision ||
          !hasReadyWarmClaimCredential(current) ||
          !cleanupLocator ||
          !this.replacementCleanupMatchesHandle(cleanupLocator, blueHandle) ||
          // The docker_image leg of this CAS exists to catch one concurrent
          // COMPETING change: the agent being repointed at a custom image (a
          // DIFFERENT repo) while the blue provisioned — adopting the blue
          // would clobber that user choice. It must NOT demand textual ref
          // equality: selection admits any tag/digest/empty pin of the fleet
          // repo (#15101 repo-match), so an exact-string compare abandoned
          // every selected sha-pinned or empty-pinned row AFTER the full blue
          // provision + snapshot, exhausted the job's retries, and the
          // exhaustion marker then froze the agent out of all future upgrades
          // (#15358). Mirror the selection/pre-provision semantics — abandon
          // only on a real repo change; the digest/node/container/sandbox legs
          // above still detect every other concurrent mutation.
          (adminCanary
            ? current.user_id !== adminCanary.targetOwnerUserId ||
              current.docker_image !== adminCanary.sourceImage
            : current.docker_image && imageRepo(current.docker_image) !== imageRepo(dockerImage))
        ) {
          return false;
        }
        const exactAdminCanaryWhere = adminCanary
          ? sql`
              AND user_id = ${adminCanary.targetOwnerUserId}
              AND docker_image = ${adminCanary.sourceImage}
              AND image_digest = ${adminCanary.sourceDigest}
            `
          : sql``;
        const result = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            sandbox_id = ${blueHandle.sandboxId},
            bridge_url = ${blueHandle.bridgeUrl},
            health_url = ${blueHandle.healthUrl},
            node_id = ${blueMeta.nodeId},
            container_name = ${blueMeta.containerName},
            bridge_port = ${blueMeta.bridgePort},
            web_ui_port = ${blueMeta.webUiPort},
            headscale_ip = ${blueMeta.headscaleIp ?? null},
            docker_image = ${
              // A digest-pinned ref is re-pinned to the digest the row now
              // actually runs, so docker_image and image_digest never become a
              // mismatched pair (#18030). Tag/bare refs carry no digest text
              // and are kept verbatim.
              adminCanary
                ? adminCanary.targetImage
                : current.docker_image && repinImageDigest(current.docker_image, toDigest)
            },
            image_digest = ${toDigest},
            previous_image_digest = ${fromDigest},
            previous_docker_image = ${
              adminCanary ? adminCanary.sourceImage : current.docker_image || dockerImage
            },
            replacement_cleanup_sandbox_id = ${oldSandboxId},
            replacement_cleanup_node_id = ${oldNodeId},
            replacement_cleanup_container_name = ${oldContainerName},
            replacement_cleanup_attempt_id = NULL,
            replacement_cleanup_container_id = NULL,
            replacement_cleanup_vpn_node_id = ${blueMeta.previousVpnNodeId ?? null},
            replacement_cleanup_vpn_node_name = NULL,
            replacement_cleanup_preserved_vpn_node_id = NULL,
            replacement_cleanup_vpn_registration_started_at = NULL,
            replacement_cleanup_allocation_counted = TRUE,
            replacement_cleanup_created_at = date_trunc('milliseconds', NOW()),
            error_message = NULL,
            last_heartbeat_at = NOW(),
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND status = 'running'
            AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
            AND environment_revision = ${sourceEnvironmentRevision}
            AND lifecycle_revision = ${current.lifecycle_revision}
            AND replacement_cleanup_sandbox_id = ${blueHandle.sandboxId}
            AND replacement_cleanup_node_id = ${blueMeta.nodeId}
            AND replacement_cleanup_container_name = ${blueMeta.containerName}
            AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${cleanupLocator.replacementAttemptId}
            AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${cleanupLocator.containerId}
            AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${cleanupLocator.vpnNodeId}
            AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${cleanupLocator.vpnNodeName}
            AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${cleanupLocator.previousVpnNodeId}
            AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${cleanupLocator.vpnRegistrationStartedAt}
            AND replacement_cleanup_allocation_counted = ${cleanupLocator.allocationCounted}
            AND ${this.replacementCleanupCreatedAtMatches(cleanupLocator.createdAt)}
            AND deletion_attempt_id IS NULL
            AND (
              claimed_at IS NULL
              OR (
                warm_claim_credential_state = 'ready'
                AND warm_claim_attested_at IS NOT NULL
                AND warm_claim_source_pool_id IS NULL
                AND warm_claim_key_fingerprint IS NOT NULL
                AND warm_claim_attested_environment_revision IS NOT NULL
              )
            )
            ${exactAdminCanaryWhere}
          RETURNING id
        `);
        if (result.rows.length !== 1) return false;
        if (adminCanary) {
          await adminCanary.onCutoverInTx(tx, {
            oldNodeId,
            oldContainerName,
            newNodeId: blueMeta.nodeId,
            newContainerName: blueMeta.containerName,
            newDigest: toDigest,
          });
        }
        return true;
      });
      if (!swapped) {
        throw new Error("Agent changed during upgrade; abandoned stale swap");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("[agent-sandbox] Atomic swap UPDATE failed; tearing down orphaned blue", {
        agentId,
        err: errMsg,
      });
      return await failBeforeUpgradeCutover(`Atomic swap UPDATE failed: ${errMsg}`);
    }

    try {
      await this.retirePersistedReplacementCleanup(
        agentId,
        orgId,
        adminCanary
          ? {
              targetOwnerUserId: adminCanary.targetOwnerUserId,
              targetImage: adminCanary.targetImage,
              targetDigest: adminCanary.targetDigest,
              newNodeId: blueMeta.nodeId,
              newContainerName: blueMeta.containerName,
              oldNodeId,
              oldContainerName,
            }
          : undefined,
        adminCanary?.onConvergedInTx,
      );
    } catch (err) {
      logger.warn("[agent-sandbox] Old container cleanup remains pending after upgrade cutover", {
        agentId,
        oldNodeId,
        oldContainerName,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        success: true,
        cleanupPending: true,
        oldNodeId,
        oldContainerName,
        newNodeId: blueMeta.nodeId,
        newContainerName: blueMeta.containerName,
        newDigest: toDigest,
        error: `Cutover committed; replacement cleanup remains pending: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    logger.info("[agent-sandbox] Fleet upgrade completed", {
      agentId,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
      requestedDigest: toDigest,
    });

    return {
      success: true,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    };
  }

  /** Runs the ordinary same-repository operator rollback policy. */
  async executeDowngrade(
    agentId: string,
    orgId: string,
    dockerImage: string,
    fromDigest: string,
  ): Promise<ImageSwapResult> {
    return await this.executeDowngradeWithPolicy(agentId, orgId, dockerImage, fromDigest);
  }

  /**
   * Reverts one completed admin canary using the exact prior pair recorded by
   * its durable job. The pair is rechecked against primary state before any
   * blue container is created and again in the atomic cutover CAS.
   */
  async executeAdminCanaryRollback(params: {
    agentId: string;
    organizationId: string;
    targetOwnerUserId: string;
    sourceImage: string;
    sourceDigest: string;
    targetImage: string;
    targetDigest: string;
    onCutoverInTx: AdminCanaryImageExecutionPolicy["onCutoverInTx"];
    onConvergedInTx: AdminCanaryImageExecutionPolicy["onConvergedInTx"];
  }): Promise<ImageSwapResult> {
    assertDemoSourceImage(params.sourceImage, "sourceImage");
    const source = parseAdminCanaryDemoImage(params.sourceImage, "sourceImage");
    if (source.digest !== params.sourceDigest) {
      return { success: false, error: "Canary rollback source image and digest do not match" };
    }
    assertSha256Digest(params.targetDigest, "targetDigest");
    assertAdminCanaryCanonicalOrDemoPair(params.targetImage, params.targetDigest, "targetImage");
    return await this.executeDowngradeWithPolicy(
      params.agentId,
      params.organizationId,
      params.sourceImage,
      params.sourceDigest,
      {
        operation: "rollback",
        targetOwnerUserId: params.targetOwnerUserId,
        sourceImage: params.sourceImage,
        sourceDigest: params.sourceDigest,
        targetImage: params.targetImage,
        targetDigest: params.targetDigest,
        onCutoverInTx: params.onCutoverInTx,
        onConvergedInTx: params.onConvergedInTx,
      },
    );
  }

  /**
   * Operator-gated rollback of the most recent fleet upgrade. Symmetric to
   * `executeUpgrade`: a blue/green swap back onto `previous_image_digest`, the
   * digest captured at the last upgrade's swap.
   *
   * Flow:
   *   1. Resolve the rollback target from `previous_image_digest` /
   *      `previous_docker_image`. If there is none, there is nothing to roll
   *      back to — bail without touching the live agent.
   *   2. Provision a fresh container (blue) on the prior image, on a different
   *      node, and health-check it (same guarantees as upgrade).
   *   3. Restore the `pre-upgrade` snapshot onto blue BEFORE cutover so the
   *      rolled-back agent comes up with the state it had before the upgrade.
   *      The bridge push is guarded and mandatory: an image without
   *      `/api/restore` fails the rollback before traffic moves.
   *   4. Atomic CAS swap: point the row at blue, set `image_digest` to the
   *      prior digest, and clear the previous-image columns (the upgrade we
   *      just undid is no longer the rollback target).
   *   5. Atomically transfer the durable cleanup locator from blue to the old
   *      container, then prove old container and VPN absence before reporting
   *      full convergence.
   *
   * This is invoked only behind an explicit operator action — it never runs
   * automatically (image-rollout-status reports `rollback` as a gated,
   * operator-approved action, not an automatic one).
   */
  private async executeDowngradeWithPolicy(
    agentId: string,
    orgId: string,
    dockerImage: string,
    fromDigest: string,
    adminCanary?: AdminCanaryImageExecutionPolicy,
  ): Promise<ImageSwapResult> {
    let agent = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!agent) return { success: false, error: "Agent not found" };
    let tierRejection = containerBackedServiceRejection(agent, "downgrade");
    if (tierRejection) {
      return { success: false, rolledBack: true, error: tierRejection };
    }
    if (this.getReplacementCleanupLocator(agent)) {
      try {
        await this.retirePersistedReplacementCleanup(agentId, orgId);
      } catch (error) {
        // error-policy:J1 rollback boundary translation — pending cleanup remains
        // explicit and prevents a second replacement from starting.
        return {
          success: false,
          cleanupPending: true,
          error: `Replacement cleanup is still pending: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      agent = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
      if (!agent) return { success: false, error: "Agent not found" };
      tierRejection = containerBackedServiceRejection(agent, "downgrade");
      if (tierRejection) {
        return { success: false, rolledBack: true, error: tierRejection };
      }
    }
    if (!hasReadyWarmClaimCredential(agent)) {
      return {
        success: false,
        error: "Warm-claim credential handoff is not ready",
      };
    }
    if (agent.status !== "running") {
      return {
        success: false,
        error: `Agent not running (status: ${agent.status})`,
      };
    }
    if (!agent.sandbox_id || !agent.node_id || !agent.container_name) {
      return {
        success: false,
        error: "Agent has no sandbox_id, node_id, or container_name to roll back from",
      };
    }
    const sourceEnvironmentRevision = agent.environment_revision;
    // Same fleet-managed-vs-custom distinction as the upgrade path (#15101):
    // a rollback of a default-family agent must not be refused just because its
    // tag differs from the target.
    if (
      adminCanary &&
      (adminCanary.operation !== "rollback" ||
        agent.user_id !== adminCanary.targetOwnerUserId ||
        adminCanary.sourceImage !== dockerImage ||
        adminCanary.sourceDigest !== fromDigest ||
        agent.docker_image !== adminCanary.sourceImage ||
        agent.image_digest !== adminCanary.sourceDigest ||
        agent.previous_docker_image !== adminCanary.targetImage ||
        agent.previous_image_digest !== adminCanary.targetDigest)
    ) {
      return {
        success: false,
        error: "Agent does not match the audited canary rollback image pairs",
      };
    }
    if (
      !adminCanary &&
      agent.docker_image &&
      imageRepo(agent.docker_image) !== imageRepo(dockerImage)
    ) {
      return {
        success: false,
        error: "Agent uses a custom docker image; refusing fleet rollback",
      };
    }
    const toDigest = adminCanary?.targetDigest ?? agent.previous_image_digest;
    if (!toDigest) {
      return {
        success: false,
        error: "No previous image digest persisted; nothing to roll back to",
      };
    }
    if (agent.image_digest !== fromDigest) {
      return {
        success: false,
        error: `Agent is not on the expected post-upgrade digest (expected ${fromDigest}, found ${agent.image_digest})`,
      };
    }

    const oldNodeId = agent.node_id;
    const oldContainerName = agent.container_name;
    const oldSandboxId = agent.sandbox_id;
    const oldNode = await dockerNodesRepository.findByNodeId(oldNodeId);
    if (!oldNode) {
      return {
        success: false,
        error: `Old node ${oldNodeId} not registered in docker_nodes`,
      };
    }
    if (!Number.isInteger(oldNode.allocated_count) || oldNode.allocated_count < 1) {
      return {
        success: false,
        error: `Old node ${oldNodeId} has no durable capacity ownership`,
      };
    }

    const provider = await this.getProvider();
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    if (!(provider instanceof DockerSandboxProvider)) {
      return {
        success: false,
        error: "Fleet rollback only supported on docker provider",
      };
    }

    const rollbackImage = adminCanary
      ? adminCanary.targetImage
      : agent.previous_docker_image || dockerImage;
    // Materialize at-rest-encrypted BYO secrets before container create (#11332).
    const rollbackEnv = await decryptAgentEnvVars(
      (agent.environment_vars as Record<string, string>) ?? {},
    );
    const config = {
      agentId,
      agentName: agent.agent_name ?? "",
      organizationId: orgId,
      executionTier: agent.execution_tier,
      environmentVars: applyRemoteDockerRuntimeMode({
        ...rollbackEnv,
        ...applyManagedAgentInferenceEnvDefaults(rollbackEnv),
      }),
      dockerImage: digestPinnedImageRef(rollbackImage, toDigest),
      excludeNodeId: oldNodeId,
      // Preserve the LIVE Headscale node during the overlap (#16565): the
      // provider records its id as metadata.previousVpnNodeId; it is deleted
      // by id below only after the atomic swap succeeds.
      reclaimStaleVpnNode: false,
      ...this.replacementCleanupCallbacks(agentId, orgId, {
        status: "running",
        environmentRevision: sourceEnvironmentRevision,
        sandboxId: oldSandboxId,
        nodeId: oldNodeId,
        containerName: oldContainerName,
      }),
    };

    let blueHandle: Awaited<ReturnType<typeof provider.create>>;
    try {
      blueHandle = await provider.create(config);
    } catch (err) {
      if (err instanceof SandboxReplacementCleanupUnresolvedError) {
        await this.persistUnresolvedReplacementCleanupFence(agentId, orgId, err);
      }
      return {
        success: false,
        cleanupPending: err instanceof SandboxReplacementCleanupUnresolvedError,
        oldNodeId,
        oldContainerName,
        error: `Blue provision failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const failBeforeRollbackCutover = async (error: string): Promise<ImageSwapResult> => {
      try {
        await this.retirePersistedReplacementCleanup(agentId, orgId);
      } catch (cleanupError) {
        // error-policy:J1 pre-cutover boundary translation — unresolved retirement
        // is returned with cleanupPending while the current placement stays live.
        return {
          success: false,
          cleanupPending: true,
          oldNodeId,
          oldContainerName,
          error: `${error}; replacement cleanup remains pending: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        };
      }
      return { success: false, oldNodeId, oldContainerName, error };
    };

    if (!(await provider.checkHealth(blueHandle))) {
      return await failBeforeRollbackCutover(
        "Blue health check failed; kept agent on current image",
      );
    }

    const blueMeta = isDockerSandboxMetadata(blueHandle.metadata) ? blueHandle.metadata : undefined;
    if (!blueMeta) {
      return await failBeforeRollbackCutover("Blue provisioner returned non-docker metadata");
    }
    if (
      (adminCanary && !blueMeta.imageDigest) ||
      (blueMeta.imageDigest && blueMeta.imageDigest !== toDigest)
    ) {
      return await failBeforeRollbackCutover(
        `Blue image digest mismatch: expected ${toDigest}, got ${blueMeta.imageDigest ?? "missing"}`,
      );
    }

    const preRestoreRuntimeHealth = await this.verifyReplacementRuntimeHealth({
      agent,
      bridgeUrl: blueHandle.bridgeUrl,
    });
    if (!preRestoreRuntimeHealth.success) {
      return await failBeforeRollbackCutover(
        `Blue runtime readiness gate failed before state restore: ${preRestoreRuntimeHealth.error}`,
      );
    }

    // Restore the pre-upgrade state onto blue BEFORE cutover. A rollback that
    // cannot replay the verified restore point is not a rollback, so fail
    // loudly and leave the current image serving traffic.
    const preUpgradeBackup = await agentSandboxesRepository.getLatestBackupByType(
      agent.id,
      "pre-upgrade",
    );
    if (preUpgradeBackup) {
      const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
        preUpgradeBackup.id,
      );
      if (restoreState) {
        try {
          await this.pushState(blueHandle.bridgeUrl, restoreState, {
            trusted: true,
            authRec: agent,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return await failBeforeRollbackCutover(`Pre-upgrade state restore failed: ${message}`);
        }
      } else {
        return await failBeforeRollbackCutover(
          `Pre-upgrade backup ${preUpgradeBackup.id} could not be reconstructed`,
        );
      }
    } else {
      return await failBeforeRollbackCutover(
        "No pre-upgrade snapshot found; refusing rollback without restore point",
      );
    }

    const runtimeHealth = await this.verifyReplacementRuntimeHealth({
      agent,
      bridgeUrl: blueHandle.bridgeUrl,
    });
    if (!runtimeHealth.success) {
      return await failBeforeRollbackCutover(
        `Blue runtime readiness gate failed after state restore: ${runtimeHealth.error}`,
      );
    }

    try {
      const swapped = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, agentId, orgId);
        const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        const cleanupLocator = this.getReplacementCleanupLocator(current);
        if (
          containerBackedServiceRejection(current, "downgrade") ||
          current.status !== "running" ||
          current.node_id !== oldNodeId ||
          current.container_name !== oldContainerName ||
          current.sandbox_id !== oldSandboxId ||
          current.image_digest !== fromDigest ||
          current.environment_revision !== sourceEnvironmentRevision ||
          !hasReadyWarmClaimCredential(current) ||
          !cleanupLocator ||
          !this.replacementCleanupMatchesHandle(cleanupLocator, blueHandle) ||
          // Same repo-match semantics as the upgrade swap's CAS above: this
          // leg detects a concurrent repoint at a DIFFERENT repo, not textual
          // pin drift within the fleet repo (an empty or tag/digest-pinned
          // docker_image on the same repo is still the fleet image — #15101,
          // #15358). `dockerImage` here is the recorded rollback ref.
          (adminCanary
            ? current.user_id !== adminCanary.targetOwnerUserId ||
              current.docker_image !== adminCanary.sourceImage ||
              current.previous_docker_image !== adminCanary.targetImage ||
              current.previous_image_digest !== adminCanary.targetDigest
            : current.docker_image && imageRepo(current.docker_image) !== imageRepo(dockerImage))
        ) {
          return false;
        }
        const exactAdminCanaryWhere = adminCanary
          ? sql`
              AND user_id = ${adminCanary.targetOwnerUserId}
              AND docker_image = ${adminCanary.sourceImage}
              AND image_digest = ${adminCanary.sourceDigest}
              AND previous_docker_image = ${adminCanary.targetImage}
              AND previous_image_digest = ${adminCanary.targetDigest}
            `
          : sql``;
        const result = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            sandbox_id = ${blueHandle.sandboxId},
            bridge_url = ${blueHandle.bridgeUrl},
            health_url = ${blueHandle.healthUrl},
            node_id = ${blueMeta.nodeId},
            container_name = ${blueMeta.containerName},
            bridge_port = ${blueMeta.bridgePort},
            web_ui_port = ${blueMeta.webUiPort},
            headscale_ip = ${blueMeta.headscaleIp ?? null},
            docker_image = ${
              // Downgrade-writeback pairing (#18030): re-pin a digest-pinned
              // ref onto the digest being rolled back to; otherwise the row
              // would advertise the abandoned digest in docker_image while
              // image_digest records the rolled-back one.
              adminCanary
                ? adminCanary.targetImage
                : current.docker_image && repinImageDigest(current.docker_image, toDigest)
            },
            image_digest = ${toDigest},
            previous_image_digest = NULL,
            previous_docker_image = NULL,
            replacement_cleanup_sandbox_id = ${oldSandboxId},
            replacement_cleanup_node_id = ${oldNodeId},
            replacement_cleanup_container_name = ${oldContainerName},
            replacement_cleanup_attempt_id = NULL,
            replacement_cleanup_container_id = NULL,
            replacement_cleanup_vpn_node_id = ${blueMeta.previousVpnNodeId ?? null},
            replacement_cleanup_vpn_node_name = NULL,
            replacement_cleanup_preserved_vpn_node_id = NULL,
            replacement_cleanup_vpn_registration_started_at = NULL,
            replacement_cleanup_allocation_counted = TRUE,
            replacement_cleanup_created_at = date_trunc('milliseconds', NOW()),
            last_heartbeat_at = NOW(),
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND status = 'running'
            AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
            AND environment_revision = ${sourceEnvironmentRevision}
            AND lifecycle_revision = ${current.lifecycle_revision}
            AND replacement_cleanup_sandbox_id = ${blueHandle.sandboxId}
            AND replacement_cleanup_node_id = ${blueMeta.nodeId}
            AND replacement_cleanup_container_name = ${blueMeta.containerName}
            AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${cleanupLocator.replacementAttemptId}
            AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${cleanupLocator.containerId}
            AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${cleanupLocator.vpnNodeId}
            AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${cleanupLocator.vpnNodeName}
            AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${cleanupLocator.previousVpnNodeId}
            AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${cleanupLocator.vpnRegistrationStartedAt}
            AND replacement_cleanup_allocation_counted = ${cleanupLocator.allocationCounted}
            AND ${this.replacementCleanupCreatedAtMatches(cleanupLocator.createdAt)}
            AND deletion_attempt_id IS NULL
            AND (
              claimed_at IS NULL
              OR (
                warm_claim_credential_state = 'ready'
                AND warm_claim_attested_at IS NOT NULL
                AND warm_claim_source_pool_id IS NULL
                AND warm_claim_key_fingerprint IS NOT NULL
                AND warm_claim_attested_environment_revision IS NOT NULL
              )
            )
            ${exactAdminCanaryWhere}
          RETURNING id
        `);
        if (result.rows.length !== 1) return false;
        if (adminCanary) {
          await adminCanary.onCutoverInTx(tx, {
            oldNodeId,
            oldContainerName,
            newNodeId: blueMeta.nodeId,
            newContainerName: blueMeta.containerName,
            newDigest: toDigest,
          });
        }
        return true;
      });
      if (!swapped) {
        throw new Error("Agent changed during rollback; abandoned stale swap");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        "[agent-sandbox] Rollback atomic swap UPDATE failed; tearing down orphaned blue",
        {
          agentId,
          err: errMsg,
        },
      );
      return await failBeforeRollbackCutover(`Rollback atomic swap UPDATE failed: ${errMsg}`);
    }

    try {
      await this.retirePersistedReplacementCleanup(
        agentId,
        orgId,
        adminCanary
          ? {
              targetOwnerUserId: adminCanary.targetOwnerUserId,
              targetImage: adminCanary.targetImage,
              targetDigest: adminCanary.targetDigest,
              newNodeId: blueMeta.nodeId,
              newContainerName: blueMeta.containerName,
              oldNodeId,
              oldContainerName,
            }
          : undefined,
        adminCanary?.onConvergedInTx,
      );
    } catch (err) {
      logger.warn("[agent-sandbox] Old container cleanup remains pending after rollback cutover", {
        agentId,
        oldNodeId,
        oldContainerName,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        success: true,
        cleanupPending: true,
        oldNodeId,
        oldContainerName,
        newNodeId: blueMeta.nodeId,
        newContainerName: blueMeta.containerName,
        newDigest: toDigest,
        error: `Cutover committed; replacement cleanup remains pending: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    logger.info("[agent-sandbox] Fleet rollback completed", {
      agentId,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    });

    return {
      success: true,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    };
  }

  /**
   * Daemon-side handler for the `agent_logs` job. SSH `docker logs
   * --tail N <container>` on the assigned core via the provider. The
   * daemon path works for stopped/crashed agents (the legacy Worker
   * path hits the bridge HTTP `/logs` endpoint which is gone when the
   * agent isn't running).
   */
  async executeLogs(
    agentId: string,
    orgId: string,
    tail: number,
  ): Promise<{
    success: boolean;
    status: string;
    logs?: string;
    message?: string;
    error?: string;
  }> {
    let rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!rec) {
      return { success: false, status: "missing", error: "Agent not found" };
    }
    const tierRejection = containerBackedServiceRejection(rec, "logs");
    if (tierRejection) {
      return { success: false, status: rec.status, error: tierRejection };
    }
    if (!rec.sandbox_id) {
      return {
        success: true,
        status: rec.status,
        message: `Agent is ${rec.status} — no container assigned yet.`,
      };
    }

    const provider = await this.getProvider();
    if (typeof provider.fetchLogs !== "function") {
      return {
        success: true,
        status: rec.status,
        message: "Logs unavailable: sandbox provider does not implement fetchLogs.",
      };
    }

    // Logs are a provider read, not a durable mutation. Re-read from primary
    // immediately before that read so a stale canonical snapshot cannot dial a
    // forged Shared/unknown row. A final SQL CAS is inapplicable because this
    // operation intentionally writes no state.
    const logSource = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (
      !logSource ||
      !isContainerBackedExecutionTier(logSource.execution_tier) ||
      !logSource.sandbox_id ||
      logSource.status !== rec.status ||
      logSource.sandbox_id !== rec.sandbox_id ||
      logSource.node_id !== rec.node_id ||
      logSource.container_name !== rec.container_name ||
      logSource.environment_revision !== rec.environment_revision ||
      logSource.lifecycle_revision !== rec.lifecycle_revision
    ) {
      return {
        success: false,
        status: logSource?.status ?? "missing",
        error: logSource
          ? containerBackedServiceRejection(logSource, "logs") ||
            "Agent lifecycle changed before logs were fetched"
          : "Agent not found",
      };
    }
    rec = logSource;

    try {
      const logs = await provider.fetchLogs(logSource.sandbox_id, tail);
      return { success: true, status: rec.status, logs };
    } catch (e) {
      return {
        success: false,
        status: rec.status,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Daemon-side handler for the `agent_snapshot` job. Same operation
   * as the Worker-side `snapshot()` path, but invoked from the daemon
   * so outbound traffic to the agent bridge uses the same network
   * identity as every other cores-bound call. Returns the
   * `agent_sandbox_backups` row that was persisted.
   */
  async executeSnapshot(
    agentId: string,
    orgId: string,
    snapshotType: "manual" | "auto" = "manual",
  ): Promise<SnapshotResult> {
    return await this.snapshot(agentId, orgId, snapshotType);
  }

  // Private helpers

  private replacementCleanupCallbacks(
    agentId: string,
    orgId: string,
    expected: ReplacementCleanupExpectation,
  ) {
    return {
      onReplacementCreateIntent: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "intent");
      },
      onReplacementCreated: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "created");
      },
      onReplacementVpnRegistered: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "vpn");
      },
    };
  }

  private getReplacementCleanupLocator(
    rec: Pick<
      AgentSandbox,
      | "replacement_cleanup_sandbox_id"
      | "replacement_cleanup_node_id"
      | "replacement_cleanup_container_name"
      | "replacement_cleanup_attempt_id"
      | "replacement_cleanup_container_id"
      | "replacement_cleanup_vpn_node_id"
      | "replacement_cleanup_vpn_node_name"
      | "replacement_cleanup_preserved_vpn_node_id"
      | "replacement_cleanup_vpn_registration_started_at"
      | "replacement_cleanup_allocation_counted"
      | "replacement_cleanup_created_at"
    >,
  ): ReplacementCleanupLocator | null {
    const core = [
      rec.replacement_cleanup_sandbox_id,
      rec.replacement_cleanup_node_id,
      rec.replacement_cleanup_container_name,
      rec.replacement_cleanup_allocation_counted,
      rec.replacement_cleanup_created_at,
    ];
    const optional = [
      rec.replacement_cleanup_attempt_id,
      rec.replacement_cleanup_container_id,
      rec.replacement_cleanup_vpn_node_id,
      rec.replacement_cleanup_vpn_node_name,
      rec.replacement_cleanup_preserved_vpn_node_id,
      rec.replacement_cleanup_vpn_registration_started_at,
    ];
    if (core.every((value) => value === null)) {
      if (optional.some((value) => value !== null)) {
        throw new Error("Replacement cleanup locator contains unowned identity fields");
      }
      return null;
    }
    if (core.some((value) => value === null)) {
      throw new Error("Replacement cleanup locator is incomplete");
    }
    if (
      (rec.replacement_cleanup_vpn_node_name === null) !==
      (rec.replacement_cleanup_vpn_registration_started_at === null)
    ) {
      throw new Error("Replacement cleanup VPN correlation is incomplete");
    }
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      rec.replacement_cleanup_vpn_registration_started_at,
    );
    const createdAt = this.parseReplacementCreatedAt(rec.replacement_cleanup_created_at);
    return {
      sandboxId: rec.replacement_cleanup_sandbox_id!,
      nodeId: rec.replacement_cleanup_node_id!,
      containerName: rec.replacement_cleanup_container_name!,
      replacementAttemptId: rec.replacement_cleanup_attempt_id,
      containerId: rec.replacement_cleanup_container_id,
      vpnNodeId: rec.replacement_cleanup_vpn_node_id,
      vpnNodeName: rec.replacement_cleanup_vpn_node_name,
      previousVpnNodeId: rec.replacement_cleanup_preserved_vpn_node_id,
      vpnRegistrationStartedAt,
      allocationCounted: rec.replacement_cleanup_allocation_counted!,
      createdAt,
    };
  }

  private parseReplacementVpnStartedAt(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Replacement cleanup VPN registration timestamp is invalid");
    }
    return parsed;
  }

  private parseReplacementCreatedAt(value: Date | string | null | undefined): Date {
    if (!value) {
      throw new Error("Replacement cleanup creation timestamp is missing");
    }
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Replacement cleanup creation timestamp is invalid");
    }
    return parsed;
  }

  /**
   * PostgreSQL retains microseconds that JavaScript Date cannot round-trip.
   * The durable placement fields fence identity; this one-millisecond window
   * preserves the timestamp generation check without making valid CAS writes
   * miss solely because the database carried sub-millisecond precision.
   */
  private replacementCleanupCreatedAtMatches(createdAt: Date) {
    const nextMillisecond = new Date(createdAt.getTime() + 1);
    return sql`${agentSandboxes.replacement_cleanup_created_at} >= ${createdAt}
      AND ${agentSandboxes.replacement_cleanup_created_at} < ${nextMillisecond}`;
  }

  private replacementLocatorFromHandle(
    handle: SandboxHandle,
  ): Omit<ReplacementCleanupLocator, "createdAt"> {
    const metadata = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;
    if (
      !metadata?.nodeId ||
      !metadata.containerName ||
      !metadata.replacementAttemptId ||
      typeof metadata.allocationCounted !== "boolean"
    ) {
      throw new Error(
        `Replacement sandbox ${handle.sandboxId} has no durable Docker placement metadata`,
      );
    }
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      metadata.vpnRegistrationStartedAt,
    );
    const vpnNodeName = metadata.vpnNodeName ?? null;
    if ((vpnNodeName === null) !== (vpnRegistrationStartedAt === null)) {
      throw new Error("Replacement sandbox has incomplete VPN correlation metadata");
    }
    return {
      sandboxId: handle.sandboxId,
      nodeId: metadata.nodeId,
      containerName: metadata.containerName,
      replacementAttemptId: metadata.replacementAttemptId,
      containerId: metadata.containerId ?? null,
      vpnNodeId: metadata.vpnNodeId ?? null,
      vpnNodeName,
      previousVpnNodeId: metadata.previousVpnNodeId ?? null,
      vpnRegistrationStartedAt,
      allocationCounted: metadata.allocationCounted,
    };
  }

  private replacementLocatorFromCleanupError(
    cleanupError: SandboxReplacementCleanupUnresolvedError,
  ): Omit<ReplacementCleanupLocator, "createdAt"> {
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      cleanupError.vpnRegistrationStartedAt,
    );
    if ((cleanupError.vpnNodeName === null) !== (vpnRegistrationStartedAt === null)) {
      throw new Error("Unresolved replacement has incomplete VPN correlation metadata");
    }
    if (!cleanupError.replacementAttemptId) {
      throw new Error("Unresolved replacement has no durable attempt identity");
    }
    if (cleanupError.allocationCounted === null) {
      throw new Error("Unresolved replacement has no capacity ownership marker");
    }
    return {
      sandboxId: cleanupError.sandboxId,
      nodeId: cleanupError.nodeId,
      containerName: cleanupError.containerName,
      replacementAttemptId: cleanupError.replacementAttemptId,
      containerId: cleanupError.containerId,
      vpnNodeId: cleanupError.vpnNodeId,
      vpnNodeName: cleanupError.vpnNodeName,
      previousVpnNodeId: cleanupError.previousVpnNodeId,
      vpnRegistrationStartedAt,
      allocationCounted: cleanupError.allocationCounted,
    };
  }

  private assertSameReplacementIdentity(
    existing: ReplacementCleanupLocator,
    incoming: Omit<ReplacementCleanupLocator, "createdAt">,
  ): void {
    const same =
      existing.sandboxId === incoming.sandboxId &&
      existing.nodeId === incoming.nodeId &&
      existing.containerName === incoming.containerName &&
      existing.replacementAttemptId === incoming.replacementAttemptId &&
      existing.vpnNodeName === incoming.vpnNodeName &&
      existing.previousVpnNodeId === incoming.previousVpnNodeId &&
      existing.vpnRegistrationStartedAt?.getTime() ===
        incoming.vpnRegistrationStartedAt?.getTime() &&
      existing.allocationCounted === incoming.allocationCounted;
    if (!same) {
      throw new Error(
        `Agent already owns a different unresolved replacement ${existing.sandboxId} on ${existing.nodeId}`,
      );
    }
    if (
      existing.containerId !== null &&
      incoming.containerId !== null &&
      existing.containerId !== incoming.containerId
    ) {
      throw new Error("Replacement Docker identity changed during enrichment");
    }
    if (
      existing.vpnNodeId !== null &&
      incoming.vpnNodeId !== null &&
      existing.vpnNodeId !== incoming.vpnNodeId
    ) {
      throw new Error("Replacement VPN identity changed during enrichment");
    }
  }

  private replacementCleanupMatchesHandle(
    existing: ReplacementCleanupLocator,
    handle: SandboxHandle,
  ): boolean {
    try {
      const incoming = this.replacementLocatorFromHandle(handle);
      this.assertSameReplacementIdentity(existing, incoming);
      return (
        existing.containerId === incoming.containerId && existing.vpnNodeId === incoming.vpnNodeId
      );
    } catch {
      // error-policy:J3 replacement identity validation — a mismatch is the
      // explicit invalid signal consumed by the lifecycle CAS.
      return false;
    }
  }

  private replacementCleanupLocatorsEqual(
    left: ReplacementCleanupLocator,
    right: ReplacementCleanupLocator,
  ): boolean {
    try {
      this.assertSameReplacementIdentity(left, right);
      return (
        left.containerId === right.containerId &&
        left.vpnNodeId === right.vpnNodeId &&
        left.createdAt.getTime() === right.createdAt.getTime()
      );
    } catch {
      // error-policy:J3 replacement identity validation — unequal or malformed
      // locators fail closed as an explicit false comparison.
      return false;
    }
  }

  private async persistReplacementCleanupStage(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expected: ReplacementCleanupExpectation,
    stage: "intent" | "created" | "vpn",
  ): Promise<void> {
    const incoming = this.replacementLocatorFromHandle(handle);
    if (stage === "intent" && (incoming.containerId !== null || incoming.vpnNodeId !== null)) {
      throw new Error("Replacement intent already contains a committed remote identity");
    }
    if (stage === "created" && incoming.containerId === null) {
      throw new Error("Replacement Docker enrichment is missing the container id");
    }
    if (stage === "vpn" && incoming.vpnNodeId === null) {
      throw new Error("Replacement VPN enrichment is missing the node id");
    }
    if (expected.status === "running" && !incoming.allocationCounted) {
      throw new Error("Blue/green replacement requires durable node capacity ownership");
    }
    await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) throw new Error("Agent disappeared before replacement ownership");
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.deletion_attempt_id !== null ||
        current.status === "deletion_pending" ||
        current.status === "deletion_failed"
      ) {
        throw new Error("Agent deletion owns the lifecycle before replacement ownership");
      }
      const existing = this.getReplacementCleanupLocator(current);
      if (existing) {
        this.assertSameReplacementIdentity(existing, incoming);
        const containerId = existing.containerId ?? incoming.containerId;
        const vpnNodeId = existing.vpnNodeId ?? incoming.vpnNodeId;
        if (containerId === existing.containerId && vpnNodeId === existing.vpnNodeId) return;
        const enriched = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            replacement_cleanup_container_id = ${containerId},
            replacement_cleanup_vpn_node_id = ${vpnNodeId},
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
            AND replacement_cleanup_sandbox_id = ${existing.sandboxId}
            AND replacement_cleanup_node_id = ${existing.nodeId}
            AND replacement_cleanup_container_name = ${existing.containerName}
            AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${existing.replacementAttemptId}
            AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${existing.containerId}
            AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${existing.vpnNodeId}
            AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${existing.vpnNodeName}
            AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${existing.previousVpnNodeId}
            AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${existing.vpnRegistrationStartedAt}
            AND replacement_cleanup_allocation_counted = ${existing.allocationCounted}
            AND ${this.replacementCleanupCreatedAtMatches(existing.createdAt)}
            AND lifecycle_revision = ${current.lifecycle_revision}
          RETURNING id
        `);
        if (enriched.rows.length !== 1) {
          throw new Error("Replacement cleanup enrichment CAS failed");
        }
        return;
      }
      if (stage !== "intent") {
        throw new Error("Replacement enrichment arrived before durable intent ownership");
      }
      if (
        current.status !== expected.status ||
        current.environment_revision !== expected.environmentRevision ||
        current.sandbox_id !== expected.sandboxId ||
        current.node_id !== expected.nodeId ||
        current.container_name !== expected.containerName
      ) {
        throw new Error("Agent generation changed before replacement ownership");
      }
      if (incoming.allocationCounted) {
        const reserved = await tx.execute<{ node_id: string }>(sql`
          UPDATE ${dockerNodes}
          SET
            allocated_count = allocated_count + 1,
            updated_at = NOW()
          WHERE node_id = ${incoming.nodeId}
            AND enabled = TRUE
            AND placement_state = 'open'
            AND status = 'healthy'
            AND allocated_count < capacity
          RETURNING node_id
        `);
        if (reserved.rows.length !== 1) {
          throw new Error(`Replacement node ${incoming.nodeId} has no reservable capacity`);
        }
      }
      const persisted = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_sandbox_id = ${incoming.sandboxId},
          replacement_cleanup_node_id = ${incoming.nodeId},
          replacement_cleanup_container_name = ${incoming.containerName},
          replacement_cleanup_attempt_id = ${incoming.replacementAttemptId},
          replacement_cleanup_container_id = ${incoming.containerId},
          replacement_cleanup_vpn_node_id = ${incoming.vpnNodeId},
          replacement_cleanup_vpn_node_name = ${incoming.vpnNodeName},
          replacement_cleanup_preserved_vpn_node_id = ${incoming.previousVpnNodeId},
          replacement_cleanup_vpn_registration_started_at = ${incoming.vpnRegistrationStartedAt},
          replacement_cleanup_allocation_counted = ${incoming.allocationCounted},
          replacement_cleanup_created_at = date_trunc('milliseconds', NOW()),
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND status = ${expected.status}
          AND environment_revision = ${expected.environmentRevision}
          AND sandbox_id IS NOT DISTINCT FROM ${expected.sandboxId}
          AND node_id IS NOT DISTINCT FROM ${expected.nodeId}
          AND container_name IS NOT DISTINCT FROM ${expected.containerName}
          AND deletion_attempt_id IS NULL
          AND replacement_cleanup_sandbox_id IS NULL
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (persisted.rows.length !== 1) {
        throw new Error("Replacement cleanup ownership CAS failed");
      }
    });
  }

  private async persistUnresolvedReplacementCleanupFence(
    agentId: string,
    orgId: string,
    cleanupError: SandboxReplacementCleanupUnresolvedError,
  ): Promise<void> {
    const incoming = this.replacementLocatorFromCleanupError(cleanupError);
    await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        throw new Error("Agent disappeared before unresolved replacement could be fenced");
      }
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const existing = this.getReplacementCleanupLocator(current);
      if (!existing) {
        throw new Error("Unresolved replacement escaped without durable intent ownership");
      }
      this.assertSameReplacementIdentity(existing, incoming);
      const containerId = existing.containerId ?? incoming.containerId;
      const vpnNodeId = existing.vpnNodeId ?? incoming.vpnNodeId;
      if (containerId === existing.containerId && vpnNodeId === existing.vpnNodeId) return;
      const persisted = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_container_id = ${containerId},
          replacement_cleanup_vpn_node_id = ${vpnNodeId},
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND replacement_cleanup_sandbox_id = ${existing.sandboxId}
          AND replacement_cleanup_node_id = ${existing.nodeId}
          AND replacement_cleanup_container_name = ${existing.containerName}
          AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${existing.replacementAttemptId}
          AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${existing.containerId}
          AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${existing.vpnNodeId}
          AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${existing.vpnNodeName}
          AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${existing.previousVpnNodeId}
          AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${existing.vpnRegistrationStartedAt}
          AND replacement_cleanup_allocation_counted = ${existing.allocationCounted}
          AND ${this.replacementCleanupCreatedAtMatches(existing.createdAt)}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (persisted.rows.length !== 1) {
        throw new Error("Unresolved replacement cleanup enrichment CAS failed");
      }
    });
  }

  private async transferReplacementToPrimary(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expectedEnvironmentRevision: number,
    updateData: Partial<NewAgentSandbox>,
  ): Promise<AgentSandbox> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) throw new Error("Agent disappeared before replacement adoption");
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.status !== "provisioning" ||
        current.environment_revision !== expectedEnvironmentRevision
      ) {
        throw new Error("Agent generation changed before replacement adoption");
      }

      const locator = this.getReplacementCleanupLocator(current);
      if (locator) {
        // A preserved retry handle has no replacement metadata because its
        // identity already lives on the primary row. Construct the replacement
        // locator only when a durable replacement fence exists to compare it to.
        const incoming = this.replacementLocatorFromHandle(handle);
        this.assertSameReplacementIdentity(locator, incoming);
        if (
          locator.containerId !== incoming.containerId ||
          locator.vpnNodeId !== incoming.vpnNodeId
        ) {
          throw new Error("Replacement cleanup ownership changed before adoption");
        }
      } else if (isDockerBackedMetadata(handle.metadata)) {
        const dockerMeta = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;
        if (
          !dockerMeta?.nodeId ||
          !dockerMeta.containerName ||
          current.sandbox_id !== handle.sandboxId ||
          current.node_id !== dockerMeta.nodeId ||
          current.container_name !== dockerMeta.containerName
        ) {
          throw new Error("Docker replacement has no durable cleanup ownership");
        }
      }

      const [adopted] = await tx
        .update(agentSandboxes)
        .set({
          ...updateData,
          replacement_cleanup_sandbox_id: null,
          replacement_cleanup_node_id: null,
          replacement_cleanup_container_name: null,
          replacement_cleanup_attempt_id: null,
          replacement_cleanup_container_id: null,
          replacement_cleanup_vpn_node_id: null,
          replacement_cleanup_vpn_node_name: null,
          replacement_cleanup_preserved_vpn_node_id: null,
          replacement_cleanup_vpn_registration_started_at: null,
          replacement_cleanup_allocation_counted: null,
          replacement_cleanup_created_at: null,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
            eq(agentSandboxes.status, "provisioning"),
            eq(agentSandboxes.environment_revision, expectedEnvironmentRevision),
            eq(agentSandboxes.lifecycle_revision, current.lifecycle_revision),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning();
      if (!adopted) throw new Error("Replacement adoption CAS failed");
      return adopted;
    });
  }

  /**
   * Snapshot the cleanup identity, prove the exact remote resources absent
   * without holding a database transaction open, then re-lock and atomically
   * release its node allocation and fence. A changed identity invalidates the
   * remote proof, so retries cannot decrement another live agent's slot.
   */
  private assertAdminCanaryCleanupExpectation(
    current: AgentSandbox,
    locator: ReplacementCleanupLocator | null,
    expectation: AdminCanaryCleanupExpectation,
  ): void {
    if (
      current.status !== "running" ||
      current.deleted_at !== null ||
      current.user_id !== expectation.targetOwnerUserId ||
      current.docker_image !== expectation.targetImage ||
      current.image_digest !== expectation.targetDigest ||
      current.node_id !== expectation.newNodeId ||
      current.container_name !== expectation.newContainerName
    ) {
      throw new AdminCanaryCleanupExpectationError(
        "Admin canary serving generation changed before cleanup convergence",
      );
    }
    if (
      locator &&
      (locator.nodeId !== expectation.oldNodeId ||
        locator.containerName !== expectation.oldContainerName)
    ) {
      throw new AdminCanaryCleanupExpectationError(
        "Admin canary cleanup locator does not match the committed audit",
      );
    }
  }

  private async retirePersistedReplacementCleanup(
    agentId: string,
    orgId: string,
    expectation?: AdminCanaryCleanupExpectation,
    onConvergedInTx?: (tx: DbTransaction) => Promise<void>,
    source: "lifecycle" | "background-reconcile" | "admin-converge" = "lifecycle",
  ): Promise<"missing" | "clean" | "deferred" | "retired"> {
    const startedAt = Date.now();
    logger.info("[agent-sandbox] Replacement cleanup started", {
      agentId,
      organizationId: orgId,
      source,
    });
    const snapshot = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) return { state: "missing" as const };
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const locator = this.getReplacementCleanupLocator(current);
      if (expectation) {
        this.assertAdminCanaryCleanupExpectation(current, locator, expectation);
      }
      if (
        source === "background-reconcile" &&
        (await this.hasActiveExclusiveLifecycleJobTx(tx, agentId, orgId))
      ) {
        return { state: "deferred" as const };
      }
      if (
        source === "background-reconcile" &&
        locator?.replacementAttemptId !== null &&
        !(await this.isReplacementCleanupSweepEligibleTx(tx, agentId, orgId))
      ) {
        return { state: "deferred" as const };
      }
      if (locator) return { state: "pending" as const, locator };
      if (onConvergedInTx) await onConvergedInTx(tx);
      return { state: "clean" as const };
    });
    if (snapshot.state !== "pending") return snapshot.state;

    const provider = await this.getProvider();
    if (!provider.stopOnSpecificNodeForReplacement) {
      throw new Error("Sandbox provider cannot prove a persisted replacement absent");
    }
    const stopOnSpecificNodeForReplacement =
      provider.stopOnSpecificNodeForReplacement.bind(provider);
    const { locator } = snapshot;
    logger.info("[agent-sandbox] Replacement cleanup remote retirement started", {
      agentId,
      organizationId: orgId,
      source,
      nodeId: locator.nodeId,
      containerName: locator.containerName,
      preCutover: locator.replacementAttemptId !== null,
      elapsedMs: Date.now() - startedAt,
    });

    await stopOnSpecificNodeForReplacement(
      locator.nodeId,
      locator.containerName,
      locator.vpnNodeId,
      {
        replacementAttemptId: locator.replacementAttemptId,
        containerId: locator.containerId,
        vpnNodeName: locator.vpnNodeName,
        previousVpnNodeId: locator.previousVpnNodeId,
        vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt?.toISOString() ?? null,
        allocationCounted: locator.allocationCounted,
      },
    );
    logger.info("[agent-sandbox] Replacement cleanup remote absence proven", {
      agentId,
      organizationId: orgId,
      source,
      elapsedMs: Date.now() - startedAt,
    });

    const outcome = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        throw expectation
          ? new AdminCanaryCleanupExpectationError(
              "Admin canary serving generation disappeared after cleanup proof",
            )
          : new Error("Agent disappeared after replacement cleanup proof");
      }
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const currentLocator = this.getReplacementCleanupLocator(current);
      if (expectation) {
        this.assertAdminCanaryCleanupExpectation(current, currentLocator, expectation);
      }
      if (!currentLocator || !this.replacementCleanupLocatorsEqual(currentLocator, locator)) {
        throw new Error("Replacement cleanup fence changed after remote absence proof");
      }
      const cleared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_sandbox_id = NULL,
          replacement_cleanup_node_id = NULL,
          replacement_cleanup_container_name = NULL,
          replacement_cleanup_attempt_id = NULL,
          replacement_cleanup_container_id = NULL,
          replacement_cleanup_vpn_node_id = NULL,
          replacement_cleanup_vpn_node_name = NULL,
          replacement_cleanup_preserved_vpn_node_id = NULL,
          replacement_cleanup_vpn_registration_started_at = NULL,
          replacement_cleanup_allocation_counted = NULL,
          replacement_cleanup_created_at = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND replacement_cleanup_sandbox_id = ${locator.sandboxId}
          AND replacement_cleanup_node_id = ${locator.nodeId}
          AND replacement_cleanup_container_name = ${locator.containerName}
          AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${locator.replacementAttemptId}
          AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${locator.containerId}
          AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${locator.vpnNodeId}
          AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${locator.vpnNodeName}
          AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${locator.previousVpnNodeId}
          AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${locator.vpnRegistrationStartedAt}
          AND replacement_cleanup_allocation_counted = ${locator.allocationCounted}
          AND ${this.replacementCleanupCreatedAtMatches(locator.createdAt)}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (cleared.rows.length !== 1) {
        throw new Error("Replacement cleanup fence changed before durable release");
      }
      if (locator.allocationCounted) {
        const released = await tx.execute<{ node_id: string }>(sql`
          UPDATE ${dockerNodes}
          SET
            allocated_count = allocated_count - 1,
            updated_at = NOW()
          WHERE node_id = ${locator.nodeId}
            AND allocated_count > 0
          RETURNING node_id
        `);
        if (released.rows.length !== 1) {
          throw new Error(`Replacement cleanup node ${locator.nodeId} disappeared before release`);
        }
      }
      if (onConvergedInTx) await onConvergedInTx(tx);
      return "retired" as const;
    });
    logger.info("[agent-sandbox] Replacement cleanup fence retired", {
      agentId,
      organizationId: orgId,
      source,
      elapsedMs: Date.now() - startedAt,
    });
    return outcome;
  }

  /**
   * Low-cadence daemon backstop for cleanup interrupted after a process crash or
   * an unreachable node. Each row is independently fenced; failures remain
   * durable for the next sweep and cannot authorize another replacement.
   */
  async reconcileReplacementCleanupFences(limit = 25): Promise<{
    total: number;
    retired: number;
    failed: number;
  }> {
    const pending = await dbWrite.execute<{ id: string; organization_id: string }>(sql`
      SELECT id, organization_id
      FROM ${agentSandboxes}
      WHERE replacement_cleanup_sandbox_id IS NOT NULL
        AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
        AND (
          replacement_cleanup_attempt_id IS NULL
          OR replacement_cleanup_created_at <=
            NOW() - (${PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES} * INTERVAL '1 minute')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${jobs}
          WHERE ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND ${jobs.status} IN ('pending', 'in_progress')
            AND ${inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES)}
        )
      ORDER BY replacement_cleanup_created_at ASC
      LIMIT ${limit}
    `);
    let retired = 0;
    let failed = 0;
    for (const row of pending.rows) {
      try {
        if (
          (await this.retirePersistedReplacementCleanup(
            row.id,
            row.organization_id,
            undefined,
            undefined,
            "background-reconcile",
          )) === "retired"
        ) {
          retired += 1;
        }
      } catch (error) {
        // error-policy:J7 reconciliation must not kill the sweep — the durable
        // fence remains for retry and the per-row failure is counted and logged.
        failed += 1;
        logger.warn("[agent-sandbox] Replacement cleanup remains pending", {
          agentId: row.id,
          organizationId: row.organization_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { total: pending.rows.length, retired, failed };
  }

  /**
   * Completes the durable retirement owned by one agent. Admin canary jobs use
   * this after a cutover audit was committed but the old placement could not be
   * proven absent during the original worker execution.
   */
  async convergeReplacementCleanupFence(
    agentId: string,
    orgId: string,
    expectation?: AdminCanaryCleanupExpectation,
    onConvergedInTx?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const outcome = await this.retirePersistedReplacementCleanup(
      agentId,
      orgId,
      expectation,
      onConvergedInTx,
      "admin-converge",
    );
    if (outcome === "missing") {
      throw expectation
        ? new AdminCanaryCleanupExpectationError(
            "Admin canary serving generation is missing during cleanup convergence",
          )
        : new Error("Agent not found while converging replacement cleanup");
    }
  }

  private async lockLifecycle(tx: LifecycleTx, agentId: string, orgId: string): Promise<void> {
    await configureElizaLifecycleTransaction(tx);
    await tx.execute(elizaProvisionAdvisoryLockSql(orgId, agentId));
  }

  /**
   * Short authoritative checkpoint before an unlocked backup/probe read. It
   * does not pretend to make PostgreSQL and a remote provider atomic; durable
   * writes still repeat the allowlist under their final lifecycle row lock.
   */
  private async revalidateContainerBackedLifecycleGeneration(
    expected: AgentSandbox,
    action: ContainerBackedServiceAction,
  ): Promise<AgentSandbox | undefined> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, expected.id, expected.organization_id);
      const current = await this.getAgentForLifecycleMutation(
        tx,
        expected.id,
        expected.organization_id,
      );
      if (!current) return undefined;
      if (containerBackedServiceRejection(current, action)) return undefined;
      return current.execution_tier === expected.execution_tier &&
        current.status === expected.status &&
        current.sandbox_id === expected.sandbox_id &&
        current.node_id === expected.node_id &&
        current.container_name === expected.container_name &&
        current.bridge_url === expected.bridge_url &&
        current.health_url === expected.health_url &&
        current.environment_revision === expected.environment_revision &&
        current.lifecycle_revision === expected.lifecycle_revision
        ? current
        : undefined;
    });
  }

  private async isReplacementCleanupSweepEligibleTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ eligible: boolean }>(sql`
      SELECT (
        replacement_cleanup_attempt_id IS NULL
        OR replacement_cleanup_created_at <=
          NOW() - (${PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES} * INTERVAL '1 minute')
      ) AS eligible
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
      LIMIT 1
    `);
    return result.rows[0]?.eligible === true;
  }

  private async hasActiveExclusiveLifecycleJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE ${jobs.organization_id} = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND ${jobs.status} IN ('pending', 'in_progress')
        AND ${inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES)}
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async getAgentForLifecycleMutation(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<AgentSandbox | undefined> {
    // The typed builder maps timestamp columns to Dates before lifecycle code
    // consumes them; the row lock and lifecycle_revision provide ownership.
    const [row] = await tx
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, agentId), eq(agentSandboxes.organization_id, orgId)))
      .for("update")
      .limit(1);
    return row;
  }

  private async hasActiveProvisionJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type = ${JOB_TYPES.AGENT_PROVISION}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status IN ('pending', 'in_progress')
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * Sleep must not interleave with a queued operation that can install a new
   * compute generation after the sleep snapshot but before its strict stop.
   * The sleep job itself is deliberately absent from this set.
   */
  private async hasActiveReplacementJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type IN (
        'agent_provision',
        'agent_resume',
        'agent_wake',
        'agent_restart',
        'agent_upgrade',
        'agent_downgrade',
        'agent_admin_canary_image'
      )
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status IN ('pending', 'in_progress')
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async fetchSnapshotState(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "environment_vars"
    >,
  ): Promise<{
    stateData: AgentBackupStateData;
    sizeBytes: number;
    bridgeUrl: string;
  }> {
    if (!rec.bridge_url) {
      throw new Error("Sandbox is not running");
    }

    const res = await this.fetchAgentApi(rec, "/api/snapshot", {
      method: "POST",
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The deployed agent image does not expose POST /api/snapshot (only the
      // cloud-agent template image does). Surface a recognizable sentinel so an
      // auto snapshot is skipped, not hard-failed-and-retried.
      throw new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED);
    }
    if (res.status === 503) {
      let payload: { code?: unknown } | null = null;
      try {
        payload = (await res.clone().json()) as { code?: unknown };
      } catch {
        // error-policy:J3 an invalid upstream error body is not the structured
        // transient signal and therefore follows the ordinary HTTP failure.
        payload = null;
      }
      if (payload?.code === AGENT_SNAPSHOT_CAPTURE_TRANSIENT_CODE) {
        // TRANSIENT: only the agent's structured PGlite-closing code defers a
        // state-preserving restart. Unrelated runtime/proxy 503 responses keep
        // the ordinary failure path and bounded attempt policy.
        throw new Error(SNAPSHOT_CAPTURE_TRANSIENT);
      }
    }
    if (!res.ok) {
      // #18228: the snapshot transfer failed somewhere between the agent's HTTP
      // handler and this fetch — an agent-side 500 carries a diagnostic body
      // (the thrown message), while a bridge/proxy hop 500 carries a proxy
      // error page or an empty body. The Worker log previously reported only
      // the status code and discarded the body, making the two indistinguishable.
      // Read a bounded excerpt of the body and include it after the canonical
      // `Snapshot fetch failed: HTTP <status>` prefix so the existing
      // SNAPSHOT_HTTP_ERROR_SHAPE regex (anchored at the status) still classifies
      // it, while the operator sees where the hop failed.
      const excerpt = await readErrorBodyExcerpt(res);
      throw new Error(`Snapshot fetch failed: HTTP ${res.status}${excerpt ? ` ${excerpt}` : ""}`);
    }

    // Bounded hydration (#16639): stream and count — bytes past the raw
    // budget are never retained (fail-closed, no partial restore), and the
    // measured size comes from the counted stream instead of a re-stringify
    // that used to double peak memory.
    const raw = await readBodyWithinBudget(res, SNAPSHOT_MAX_RAW_BYTES);
    let stateData: AgentBackupStateData;
    try {
      stateData = JSON.parse(raw) as AgentBackupStateData;
    } catch {
      throw new Error("Snapshot payload is not valid JSON — refusing partial restore");
    }
    assertSnapshotExpandedBudgets(stateData);
    const sizeBytes = Buffer.byteLength(raw, "utf-8");

    return {
      stateData,
      sizeBytes,
      bridgeUrl: rec.bridge_url,
    };
  }

  private async persistAuthorizedSnapshotWithinTransaction(
    tx: LifecycleTx,
    rec: SnapshotAuthorityCapture,
    organizationId: string,
    type: AgentBackupSnapshotType,
    plannedInput: NewAgentSandboxBackup,
  ): Promise<StoredAgentSandboxBackup> {
    const [sandbox] = await tx
      .update(agentSandboxes)
      .set({ last_backup_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, rec.id),
          eq(agentSandboxes.organization_id, organizationId),
          eq(agentSandboxes.status, "running"),
          eq(agentSandboxes.execution_tier, rec.execution_tier),
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
          sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          sql`${agentSandboxes.sandbox_id} IS NOT DISTINCT FROM ${rec.sandbox_id}`,
          sql`${agentSandboxes.node_id} IS NOT DISTINCT FROM ${rec.node_id}`,
          sql`${agentSandboxes.container_name} IS NOT DISTINCT FROM ${rec.container_name}`,
          sql`${agentSandboxes.bridge_url} IS NOT DISTINCT FROM ${rec.bridge_url}`,
          sql`${agentSandboxes.health_url} IS NOT DISTINCT FROM ${rec.health_url}`,
          sql`${agentSandboxes.bridge_port} IS NOT DISTINCT FROM ${rec.bridge_port}`,
          sql`${agentSandboxes.web_ui_port} IS NOT DISTINCT FROM ${rec.web_ui_port}`,
          sql`${agentSandboxes.headscale_ip} IS NOT DISTINCT FROM ${rec.headscale_ip}`,
          eq(agentSandboxes.environment_revision, rec.environment_revision),
          eq(agentSandboxes.lifecycle_revision, rec.lifecycle_revision),
        ),
      )
      .returning({ id: agentSandboxes.id });
    if (!sandbox) {
      throw new ElizaError("Backup metadata update lost its sandbox row", {
        code: "AGENT_BACKUP_SANDBOX_MISSING",
        context: { sandboxRecordId: rec.id, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }

    // Preparation is deliberately after the locked metadata CAS so lost
    // authority cannot reach encryption or object storage. A provider PUT
    // cannot be rolled back if the later SQL insert/commit fails; that remains
    // the existing object-GC residual, not cross-system atomicity.
    const insertData = await prepareAgentBackupInsertData(plannedInput, organizationId);
    const [backup] = await tx.insert(agentSandboxBackups).values(insertData).returning();
    if (!backup) {
      throw new ElizaError("Backup insert did not return the persisted row", {
        code: "AGENT_BACKUP_INSERT_MISSING",
        context: { sandboxRecordId: rec.id, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }
    return backup;
  }

  private async persistSnapshotWithinTransaction(
    tx: LifecycleTx,
    sandboxRecordId: string,
    organizationId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<{ backupId: string; lifecycleRevision: number }> {
    const [backup] = await tx
      .insert(agentSandboxBackups)
      .values(
        await prepareAgentBackupInsertData(
          {
            sandbox_record_id: sandboxRecordId,
            snapshot_type: type,
            state_data: stateData,
            size_bytes: sizeBytes,
          },
          organizationId,
        ),
      )
      .returning();

    if (!backup) {
      throw new ElizaError("Backup insert did not return the persisted row", {
        code: "AGENT_BACKUP_INSERT_MISSING",
        context: { sandboxRecordId, organizationId, snapshotType: type },
        severity: "fatal",
      });
    }
    const [sandbox] = await tx
      .update(agentSandboxes)
      .set({ last_backup_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, sandboxRecordId),
          eq(agentSandboxes.organization_id, organizationId),
          inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
        ),
      )
      .returning({ lifecycleRevision: agentSandboxes.lifecycle_revision });
    if (!sandbox) {
      throw new ElizaError("Backup metadata update lost its sandbox row", {
        code: "AGENT_BACKUP_SANDBOX_MISSING",
        context: { sandboxRecordId, organizationId, snapshotType: type, backupId: backup.id },
        severity: "fatal",
      });
    }

    logger.info("[agent-sandbox] Backup created", {
      agentId: sandboxRecordId,
      type,
      bytes: backup.size_bytes ?? sizeBytes,
    });
    return { backupId: backup.id, lifecycleRevision: sandbox.lifecycleRevision };
  }

  /**
   * The single degrade path for a snapshot `isUnrecoverableSnapshotError`
   * cannot restore on THIS provision (#15210): log it loudly, then boot fresh
   * instead of bricking the agent. Never throws — the caller continues to a
   * fresh boot, which must not be derailed by cleanup.
   *
   * Pruning the backup chain is gated on `isPermanentlyLostSnapshot` (#15274):
   * only drop it when the snapshot can NEVER be restored (crypto corruption /
   * gone-key, or HTTP 404/410). For a RECOVERABLE auth failure (401/403) we
   * still boot fresh but PRESERVE the chain, so a later token-corrected resume
   * (#15263) can restore it — pruning a recoverable snapshot on a transient 401
   * is silent, permanent data loss (`pruneBackups(agentId, 0)` deletes the
   * whole chain and there is no undo).
   */
  private async degradeUnrecoverableSnapshot(
    agentId: string,
    backupId: string | undefined,
    error: unknown,
  ): Promise<void> {
    const permanentlyLost = isPermanentlyLostSnapshot(error);
    logger.error("[agent-sandbox] Unrecoverable snapshot, booting fresh", {
      agentId,
      backupId,
      permanentlyLost,
      // A recoverable auth failure keeps the chain for the next authenticated
      // resume; a permanent loss drops it so the next resume boots clean.
      backupChain: permanentlyLost ? "pruned" : "preserved",
      error: error instanceof Error ? error.message : String(error),
    });
    // Preserve the chain on a recoverable failure (auth 401/403): a
    // token-corrected resume can still restore it, so pruning here would be
    // silent, permanent data loss (#15274).
    if (!permanentlyLost) return;
    // error-policy:J6 best-effort — a failed prune only means we warn + degrade
    // again next boot, never that we fail to boot fresh, so it must not throw
    // out of the provision.
    await agentSandboxesRepository.pruneBackups(agentId, 0).catch((pruneErr) => {
      logger.warn("[agent-sandbox] Failed to drop orphaned snapshot after degrade", {
        agentId,
        error: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    });
  }

  private async markError(rec: AgentSandbox, msg: string) {
    await agentSandboxesRepository.update(rec.id, {
      status: "error",
      error_message: msg,
      error_count: (rec.error_count ?? 0) + 1,
    });
  }

  /**
   * Resume a prior transport-unresolved provision attempt before creating a new
   * deterministic Docker container. The provider's container name is
   * `agent-${id}`; calling create again while the preserved container still
   * exists turns Docker's "already in use" into a cleanup path that removes the
   * very container the retry was meant to save.
   */
  private buildProvisioningRetryHandle(rec: AgentSandbox): SandboxHandle | null {
    if (!rec.sandbox_id || !rec.bridge_url || !rec.health_url) return null;
    const hasDockerFleetColumns = Boolean(
      rec.node_id || rec.container_name || rec.bridge_port || rec.web_ui_port,
    );
    return {
      sandboxId: rec.sandbox_id,
      bridgeUrl: rec.bridge_url,
      healthUrl: rec.health_url,
      metadata: hasDockerFleetColumns
        ? {
            provider: "docker",
            nodeId: rec.node_id ?? "",
            hostname: rec.node_id ?? "",
            containerName: rec.container_name ?? "",
            bridgePort: rec.bridge_port ?? undefined,
            webUiPort: rec.web_ui_port ?? undefined,
            headscaleIp: rec.headscale_ip ?? undefined,
          }
        : rec.headscale_ip
          ? { headscaleIp: rec.headscale_ip }
          : undefined,
    };
  }

  /**
   * Persist a freshly-created container's handle onto the sandbox row while
   * KEEPING `status: "provisioning"`. Used when the post-create readiness probe
   * came back `transport_unresolved` (the probe never reached the container, so
   * it is likely healthy): writing `sandbox_id` + ingress/metadata columns is
   * what lets the daemon stuck-provisioning reconciler FIND the row (it filters
   * on `sandbox_id IS NOT NULL`) and re-probe it, and what lets a provision-job
   * retry adopt the existing container instead of colliding on its
   * deterministic name. Deliberately does NOT flip to `running` — only a
   * confirmed-healthy re-probe may do that. The same write transfers ownership
   * from the temporary cleanup fence to the primary row; if it fails, the
   * durable fence remains and the cleanup reconciler retires the candidate.
   */
  private async persistContainerHandleForRetry(
    agentId: string,
    organizationId: string,
    environmentRevision: number,
    handle: SandboxHandle,
    dockerMeta: DockerSandboxMetadata | undefined,
  ): Promise<void> {
    if (isDockerBackedMetadata(handle.metadata) && !dockerMeta?.nodeId) {
      logger.error(
        "[agent-sandbox] Refusing to persist retry handle: docker-backed handle has no durable node_id",
        {
          agentId,
          sandboxId: handle.sandboxId,
          hasDockerMeta: Boolean(dockerMeta),
        },
      );
      throw new Error(
        `${PROVISION_ATTRIBUTION_GUARD_PREFIX} docker-backed sandbox ${handle.sandboxId} produced no durable node_id during transport-unresolved retry; refusing to preserve an unattributable container handle`,
      );
    }

    const updateData: Partial<NewAgentSandbox> = {
      sandbox_id: handle.sandboxId,
      bridge_url: handle.bridgeUrl,
      health_url: handle.healthUrl,
    };
    if (dockerMeta) {
      if (dockerMeta.nodeId) updateData.node_id = dockerMeta.nodeId;
      if (dockerMeta.containerName) updateData.container_name = dockerMeta.containerName;
      if (dockerMeta.bridgePort) updateData.bridge_port = dockerMeta.bridgePort;
      if (dockerMeta.webUiPort) updateData.web_ui_port = dockerMeta.webUiPort;
      if (dockerMeta.headscaleIp) updateData.headscale_ip = dockerMeta.headscaleIp;
      if (dockerMeta.dockerImage) updateData.docker_image = dockerMeta.dockerImage;
      updateData.image_digest = dockerMeta.imageDigest;
    }
    await this.transferReplacementToPrimary(
      agentId,
      organizationId,
      handle,
      environmentRevision,
      updateData,
    );
  }

  private async provisionAgentDatabase(
    rec: AgentSandbox,
  ): Promise<{ success: boolean; connectionUri?: string; error?: string }> {
    // Use the shared Railway cloud database instead of per-agent databases.
    // ElizaOS plugin-sql tables scope all data by agent UUID, so multiple agents
    // safely coexist in one database.
    const sharedDbUrl = process.env.DATABASE_URL;
    if (!sharedDbUrl) {
      return {
        success: false,
        error: "DATABASE_URL not configured in cloud environment",
      };
    }

    await agentSandboxesRepository.update(rec.id, {
      database_uri: sharedDbUrl,
      database_status: "ready",
      database_error: null,
    });

    return { success: true, connectionUri: sharedDbUrl };
  }

  private isIgnorableSandboxStopError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("already gone") ||
      normalized.includes("no longer exists") ||
      normalized.includes("404") ||
      // docker-sandbox-provider's hydrateContainerFromDb throws this when the
      // sandbox row points at a node purged from docker_nodes (decommissioned
      // node). For stop/delete teardown the container's host no longer exists,
      // so there is nothing left to stop — without this the delete escalates,
      // exhausts retries, and wedges the agent in deletion_failed forever.
      normalized.includes("missing persisted docker node metadata")
    );
  }

  private async pushState(
    sandboxOrBridgeUrl:
      | Pick<
          AgentSandbox,
          | "id"
          | "bridge_url"
          | "health_url"
          | "node_id"
          | "bridge_port"
          | "web_ui_port"
          | "headscale_ip"
          | "sandbox_id"
          | "environment_vars"
        >
      | string,
    state: AgentBackupStateData,
    options?: {
      trusted?: boolean;
      // Bridge-URL callers pass a bare string, so `pushState` cannot derive the
      // agent's ELIZA_API_TOKEN from it and the trusted branch used to send no
      // auth header. That worked while `/api/restore` exempted trusted-bridge
      // requests, but the cloud agent image now requires the token even over the
      // tailnet (server-helpers-auth `isCloudProvisionedContainer()` disables the
      // local-trust exemption) — so an unauthenticated restore deterministically
      // 401s (#15261). Pass the sandbox record here to attach the token.
      authRec?: Pick<AgentSandbox, "id" | "environment_vars">;
    },
  ) {
    // Measure the assembled payload ONCE, before it leaves the worker (#17172).
    // `/api/restore` caps its request body at the same canonical limit, so an
    // oversized push is a guaranteed far-end rejection — and this runs on the
    // blue/green ROLLBACK path, where discovering that after the request is a
    // failed rollback rather than a clean refusal. Stringifying into a local
    // also avoids building the payload twice.
    const body = JSON.stringify(state);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > MAX_RESTORABLE_AGENT_BACKUP_BYTES) {
      throw new SnapshotPayloadTooLargeError(bodyBytes, MAX_RESTORABLE_AGENT_BACKUP_BYTES);
    }
    const requestInit: RequestInit = {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SNAPSHOT_RESTORE_TIMEOUT_MS),
    };
    const res =
      typeof sandboxOrBridgeUrl === "string"
        ? await fetch(
            await this.getSafeBridgeEndpoint(sandboxOrBridgeUrl, "/api/restore", options),
            {
              ...requestInit,
              headers: options?.authRec
                ? this.getAgentJsonHeaders(options.authRec)
                : { "Content-Type": "application/json" },
            },
          )
        : await this.fetchAgentApi(sandboxOrBridgeUrl, "/api/restore", requestInit);
    if (!res.ok) {
      // error-policy:J6 best-effort read of the restore error body to enrich
      // the error we throw next; a failed body read must not mask the status.
      const text = await res.text().catch((error) => {
        logger.warn("[agent-sandbox] Failed to read restore error body", {
          status: res.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return "";
      });
      throw new Error(
        `State restore failed: HTTP ${res.status} ${truncateWellFormed(toWellFormedUnicode(text), 200)}`,
      );
    }
  }
}

export const elizaSandboxService = new ElizaSandboxService();

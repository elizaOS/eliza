/** Owns sandbox provision operations while preserving the host’s lifecycle transactions, provider instance, and backup authority. */
import { ElizaError } from "@elizaos/core";
import { SnapshotPayloadTooLargeError } from "@elizaos/core/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import { agentBillingRepository } from "../../../../db/repositories/agent-billing";
import {
  type AgentSandbox,
  type AgentSandboxStatus,
  agentSandboxesRepository,
} from "../../../../db/repositories/agent-sandboxes";
import {
  agentSandboxBackups,
  agentSandboxes,
  type NewAgentSandbox,
  WARM_POOL_ORG_ID,
} from "../../../../db/schemas/agent-sandboxes";
import { logger } from "../../../utils/logger";
import {
  completeProvisionCompute,
  reconcileFailedProvisionCompute,
  reserveProvisionCompute,
  restartProvisionCompute,
  startProvisionCompute,
} from "../../agent-compute-provision";
import { decryptAgentEnvVars } from "../../agent-env-crypto";
import { type DockerSandboxMetadata } from "../../docker-sandbox-provider";
import { prepareManagedElizaEnvironment } from "../../managed-eliza-env";
import { applyRemoteDockerRuntimeMode } from "../../remote-docker-runtime-mode";
import { resolveSandboxContainerLaunchConfig } from "../../sandbox-container-launch-config";
import { type SandboxHandle, type SandboxProvider } from "../../sandbox-provider";
import {
  type SandboxHealthContext,
  SandboxReplacementCleanupUnresolvedError,
} from "../../sandbox-provider-types";
import {
  agentConfigForProvision,
  computeManagedAgentDbEnv,
  resolveManagedProvisionDockerImage,
} from "../agent-config.js";
import {
  acquireReviewedProvisionAdmissionFence,
  assertReviewedFreshBootAuthority,
  assertReviewedProvisionRestoreAuthority,
  PreparedReviewedProvisionRestore,
  RESTORE_AUTHORITY_CHANGED,
  RESTORE_BACKUP_CHANGED,
  ReviewedProvisionAdmissionFence,
  releaseReviewedProvisionAdmissionFence,
  storedRestoreChainMatchesReviewedAuthority,
  storedRestoreChainStillCanonical,
} from "../backup/authority.js";
import { isUnrecoverableSnapshotError } from "../backup/policy.js";
import { isExplicitBackupRestore, ProvisionRestoreOverride } from "../backup/restore-contract.js";
import { SandboxBackup } from "../backup/service.js";
import { RuntimeAgentSummary } from "../bridge/contracts.js";
import { SandboxLifecycleAuthority } from "./authority.js";
import { digestPinnedImageRef } from "./image-contracts.js";
import { isDockerBackedMetadata, isDockerSandboxMetadata } from "./provider-metadata.js";
import { ProvisionResult, rejectNonContainerBackedProvision } from "./provision-contracts.js";
import {
  PROVISION_ATTRIBUTION_GUARD_PREFIX,
  SandboxReachabilityUnresolvedError,
} from "./provision-errors.js";
import { ElizaSandboxServiceTestHooks } from "./provision-hooks.js";
import { SandboxReplacementCleanup } from "./replacement-cleanup.js";
import { SandboxWarmClaim } from "./warm-claim.js";

const lifecycleAuthority = new SandboxLifecycleAuthority();

/** A stopped runtime retained in place holds writes that no backup covers (#30746). */
export const RETAINED_RUNTIME_PROVISION_REFUSAL =
  "Agent retains an unbacked runtime in place; resume it or delete it before provisioning a replacement";

/**
 * Maps a known-backup restore failure to its retry contract without ever
 * authorizing a fresh boot or pruning the chain (#30697). Transient failures
 * propagate unchanged so the owning job retries; failures that re-fail
 * identically become the typed consent error that only wake's explicit
 * forceFreshBoot can bypass.
 */
function restoreFailure(agentId: string, backupId: string | undefined, error: unknown): unknown {
  if (
    error instanceof ElizaError &&
    error.code === "SNAPSHOT_RESTORE_REQUIRES_FRESH_BOOT_CONSENT"
  ) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  const permanent =
    error instanceof SnapshotPayloadTooLargeError ||
    isUnrecoverableSnapshotError(error) ||
    (error instanceof ElizaError && error.code === "SNAPSHOT_RESTORE_RECONSTRUCTION_FAILED");
  logger.error("[agent-sandbox] Backup restore failed; retained state preserved", {
    agentId,
    backupId,
    retryable: !permanent,
    backupChain: "preserved",
    error: reason,
  });
  if (!permanent) return error;
  return new ElizaError(
    `Restore refused: ${reason}. Booting empty would discard this agent's state; wake with forceFreshBoot to explicitly accept the data loss.`,
    {
      code: "SNAPSHOT_RESTORE_REQUIRES_FRESH_BOOT_CONSENT",
      cause: error,
      context: {
        agentId,
        backupId,
        ...(error instanceof SnapshotPayloadTooLargeError
          ? { payloadBytes: error.payloadBytes, limitBytes: error.limitBytes }
          : {}),
      },
      severity: "fatal",
    },
  );
}

/**
 * Publishes an unfunded provision as `running` only after its restore tail
 * applied any known backup. The CAS binds the exact lifecycle generation and
 * adopted container, so a deletion, replacement or newer generation that won
 * during restore cannot be reopened for customer traffic.
 */
async function commitProvisionReadiness(
  expected: AgentSandbox,
  handle: SandboxHandle,
): Promise<AgentSandbox> {
  return dbWrite.transaction(async (tx) => {
    await lifecycleAuthority.lockLifecycle(tx, expected.id, expected.organization_id);
    const current = await lifecycleAuthority.getAgentForLifecycleMutation(
      tx,
      expected.id,
      expected.organization_id,
    );
    if (
      !current ||
      current.status !== "provisioning" ||
      current.lifecycle_revision !== expected.lifecycle_revision ||
      current.environment_revision !== expected.environment_revision ||
      current.lifecycle_job_id !== expected.lifecycle_job_id ||
      current.lifecycle_execution_generation !== expected.lifecycle_execution_generation ||
      current.sandbox_id !== handle.sandboxId ||
      current.bridge_url !== handle.bridgeUrl ||
      current.health_url !== handle.healthUrl ||
      current.replacement_cleanup_sandbox_id !== null ||
      current.deletion_attempt_id !== null ||
      current.deleted_at !== null
    ) {
      throw new ElizaError("Provision readiness generation changed before restore commit", {
        code: "PROVISION_READINESS_CAS_MISSED",
        context: { agentId: expected.id, sandboxId: handle.sandboxId },
      });
    }
    const now = new Date();
    const [ready] = await tx
      .update(agentSandboxes)
      .set({ status: "running", error_message: null, last_heartbeat_at: now, updated_at: now })
      .where(
        and(
          eq(agentSandboxes.id, current.id),
          eq(agentSandboxes.organization_id, current.organization_id),
          eq(agentSandboxes.status, "provisioning"),
        ),
      )
      .returning();
    if (!ready) {
      throw new ElizaError("Provision readiness CAS matched no row", {
        code: "PROVISION_READINESS_CAS_MISSED",
        context: { agentId: expected.id },
      });
    }
    return ready;
  });
}
export interface SandboxProvisionHost {
  getProvisionTestHooks(): ElizaSandboxServiceTestHooks | undefined;
  retireFailedWarmClaimForRetry(
    ...args: Parameters<SandboxWarmClaim["retireFailedWarmClaimForRetry"]>
  ): ReturnType<SandboxWarmClaim["retireFailedWarmClaimForRetry"]>;
  getReplacementCleanupLocator(
    ...args: Parameters<SandboxReplacementCleanup["getReplacementCleanupLocator"]>
  ): ReturnType<SandboxReplacementCleanup["getReplacementCleanupLocator"]>;
  retirePersistedReplacementCleanup(
    ...args: Parameters<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]>
  ): ReturnType<SandboxReplacementCleanup["retirePersistedReplacementCleanup"]>;
  getProvider(): Promise<SandboxProvider>;
  replacementCleanupCallbacks(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupCallbacks"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupCallbacks"]>;
  persistUnresolvedReplacementCleanupFence(
    ...args: Parameters<SandboxReplacementCleanup["persistUnresolvedReplacementCleanupFence"]>
  ): ReturnType<SandboxReplacementCleanup["persistUnresolvedReplacementCleanupFence"]>;
  ensureRuntimeAgentStarted(
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
  ): Promise<RuntimeAgentSummary | null>;
  transferReplacementToPrimary(
    ...args: Parameters<SandboxReplacementCleanup["transferReplacementToPrimary"]>
  ): ReturnType<SandboxReplacementCleanup["transferReplacementToPrimary"]>;
  fenceAdoptedProvisionForCleanup(
    ...args: Parameters<SandboxReplacementCleanup["fenceAdoptedProvisionForCleanup"]>
  ): ReturnType<SandboxReplacementCleanup["fenceAdoptedProvisionForCleanup"]>;
  pushState(
    ...args: Parameters<SandboxBackup["pushState"]>
  ): ReturnType<SandboxBackup["pushState"]>;
}
export class SandboxProvision {
  constructor(private readonly host: SandboxProvisionHost) {}
  // Provision
  /**
   * `restoreOverride` narrows step 5's backup restore for callers that have
   * already decided the restore source: `executeWake` (#15603 B6) and manual
   * `restore()`. `from-backup` restores a specific validated backup. `fresh-boot`
   * skips restore after explicit data-loss consent. Omitted: latest-backup
   * auto-restore. No lane degrades a known-backup failure to a fresh boot or
   * prunes the chain, and the row stays non-routable until restore commits
   * (#30697).
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
        // error-policy:J1 preserve restore authority failure for the queue boundary.
        return {
          success: false,
          error: error instanceof Error ? error.message : "Reviewed backup authority changed",
          failureCause: error,
        };
      }
    } else if (restoreOverride?.kind === "reviewed-fresh-boot") {
      try {
        await assertReviewedFreshBootAuthority(agentId, restoreOverride);
      } catch (error) {
        // error-policy:J1 preserve restore authority failure for the queue boundary.
        return {
          success: false,
          error: error instanceof Error ? error.message : "Reviewed fresh-boot authority changed",
          failureCause: error,
        };
      }
    }
    if (
      restoreOverride?.kind === "from-reviewed-backup" ||
      restoreOverride?.kind === "reviewed-fresh-boot"
    ) {
      await this.host.getProvisionTestHooks()?.afterReviewedRestorePreflight?.();
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
        const retryPreparation = await this.host.retireFailedWarmClaimForRetry(agentId, orgId);
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
      if (this.host.getReplacementCleanupLocator(candidate)) {
        try {
          await this.host.retirePersistedReplacementCleanup(agentId, orgId);
        } catch (error) {
          // error-policy:J1 provisioning boundary translation — unresolved cleanup
          // becomes an explicit retryable failure while the durable fence remains.
          return {
            success: false,
            retryable: true,
            sandboxRecord: candidate,
            error: `Replacement cleanup is still pending: ${error instanceof Error ? error.message : String(error)}`,
            failureCause: error,
          };
        }
        candidate = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
        if (!candidate) return { success: false, error: "Agent not found" } as ProvisionResult;
        const cleanupTierRejection = rejectNonContainerBackedProvision(candidate);
        if (cleanupTierRejection) return cleanupTierRejection;
      }
      if (candidate.retained_runtime) {
        return {
          success: false,
          sandboxRecord: candidate,
          error: RETAINED_RUNTIME_PROVISION_REFUSAL,
        };
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
        await this.host.getProvisionTestHooks()?.afterReviewedRestoreFence?.();
      } catch (error) {
        // error-policy:J1 translate rejected restore admission with its original cause.
        const message =
          error instanceof Error ? error.message : "Reviewed restore authority changed";
        if (reviewedAdmissionFence) {
          await releaseReviewedProvisionAdmissionFence(reviewedAdmissionFence);
          reviewedAdmissionFence = undefined;
        }
        rec = (await this.markError(rec, message)) ?? rec;
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: message,
          failureCause: error,
        };
      }
    }
    let computeFundingId: string | undefined;
    let retainedCompute = false;
    let skipFundingCleanup = false;
    // biome-ignore format: keep the existing provision body stable while this guard owns fence cleanup.
    try {
            const provisionProvider = await this.host.getProvider();
            const isWarmPoolProvision = rec.organization_id === WARM_POOL_ORG_ID && rec.pool_status === "unclaimed";
            if (provisionProvider.computeFundingCapability === "host-lease-v1" && !isWarmPoolProvision) {
                try {
                    const funding = await reserveProvisionCompute(rec);
                    computeFundingId = funding.window.id;
                    retainedCompute = funding.retained;
                    rec = funding.agent;
                }
                catch (error) {
                    // error-policy:J1 no provider allocation has occurred; return payment/admission failure.
                    const message = error instanceof Error ? error.message : String(error);
                    rec = (await this.markError(rec, message)) ?? rec;
                    return { success: false, sandboxRecord: await agentSandboxesRepository.findById(rec.id), error: message, failureCause: error };
                }
            }
            // 1. Database
            let dbUri = rec.database_uri;
            if (rec.database_status !== "ready" || !dbUri) {
                const db = await this.provisionAgentDatabase(rec);
                if (!db.success) {
                    rec = (await this.markError(rec, `Database provisioning failed: ${db.error}`)) ?? rec;
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
            const recoveringPendingWarmClaim = rec.claimed_at !== null &&
                (rec.warm_claim_credential_state === "pending" ||
                    rec.warm_claim_credential_state === "attested");
            const containerLaunch = resolveSandboxContainerLaunchConfig(rec.agent_config);
            const provisioningRetryHandle = previousStatus === "provisioning" ? this.buildProvisioningRetryHandle(rec) : null;
            // Every claimed row carries the exact managed key owned by its durable
            // handoff fence. Generic environment preparation revokes that key before
            // writing the replacement. A retained provisioning container also needs its
            // original environment: re-probing it cannot install a replacement key.
            // Only a new cold container may rotate credentials here.
            if (!rec.claimed_at && !provisioningRetryHandle && !retainedCompute) {
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
                    }
                    else {
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
            let lastFailureCause: unknown;
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
            const provisionDockerImage = isWarmPoolProvision &&
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
                materializedEnv = await decryptAgentEnvVars((rec.environment_vars as Record<string, string>) ?? {});
            }
            catch (envError) {
                // error-policy:J1 return a failed provision without losing its decryption cause.
                const message = envError instanceof Error ? envError.message : String(envError);
                rec = (await this.markError(rec, `Environment decryption failed: ${message}`)) ?? rec;
                return {
                    success: false,
                    sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                    error: message,
                    failureCause: envError,
                };
            }
            for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt++) {
                attemptsMade = attempt;
                let handle;
                let healthContext: SandboxHealthContext = { kind: "candidate" };
                try {
                    const retryHandle = attempt === 1 ? provisioningRetryHandle : null;
                    if (retryHandle || (attempt === 1 && retainedCompute)) {
                        handle = computeFundingId
                            ? await restartProvisionCompute(rec, computeFundingId)
                            : retryHandle!;
                        healthContext = { kind: "canonical" };
                        logger.info("[agent-sandbox] Re-probing persisted provisioning container before create", {
                            agentId: rec.id,
                            sandboxId: handle.sandboxId,
                        });
                    }
                    else {
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
                        const fundingId = computeFundingId;
                        handle = await provisionProvider.create({
                            agentId: rec.id,
                            agentName: rec.agent_name ?? "CloudAgent",
                            organizationId: rec.organization_id,
                            executionTier: rec.execution_tier,
                            environmentVars: applyRemoteDockerRuntimeMode({
                                ...callerEnv,
                                ...dbEnv,
                                ELIZA_RUNTIME_OWNER_ID: rec.user_id,
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
                            ...(fundingId ? { startFundedContainer: (created: SandboxHandle) => startProvisionCompute(rec, fundingId, created) } : {}),
                            ...this.host.replacementCleanupCallbacks(rec.id, rec.organization_id, {
                                status: "provisioning",
                                environmentRevision: rec.environment_revision,
                                sandboxId: rec.sandbox_id,
                                nodeId: rec.node_id,
                                containerName: rec.container_name,
                            }),
                        });
                    }
                }
                catch (err) {
                    // error-policy:J1 retain provider failure for the queue and cleanup boundaries.
                    const msg = err instanceof Error ? err.message : String(err);
                    if (err instanceof SandboxReplacementCleanupUnresolvedError) {
                        await this.host.persistUnresolvedReplacementCleanupFence(rec.id, rec.organization_id, err);
                        return {
                            success: false,
                            retryable: true,
                            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                            error: msg,
                            failureCause: err,
                        };
                    }
                    rec = (await this.markError(rec, `Sandbox creation failed: ${msg}`)) ?? rec;
                    return {
                        success: false,
                        sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                        error: msg,
                        failureCause: err,
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
                    const provider = await this.host.getProvider();
                    const health = provider.checkHealthDetailed
                        ? await provider.checkHealthDetailed(handle, healthContext)
                        : {
                            ready: await provider.checkHealth(handle, healthContext),
                            verdict: "not_ready" as const,
                        };
                    const dockerMeta = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;
                    if (!health.ready) {
                        if (health.verdict === "transport_unresolved" ||
                            health.verdict === "ingress_unresolved") {
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
                            await this.persistContainerHandleForRetry(rec.id, rec.organization_id, rec.environment_revision, handle, dockerMeta);
                            throw new SandboxReachabilityUnresolvedError(health.verdict === "ingress_unresolved"
                                ? "Sandbox container is healthy but its managed ingress is unresolved; leaving the container in place for retry/reconciliation"
                                : "Sandbox readiness probe could not reach the container (SSH transport unresolved); leaving the container in place for retry/reconciliation");
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
                        logger.warn("[agent-sandbox] Refusing to flip running: docker-backed handle has no durable node_id", {
                            agentId: rec.id,
                            sandboxId: handle.sandboxId,
                            executionTier: rec.execution_tier,
                            hasDockerMeta: Boolean(dockerMeta),
                            metadataProvider: typeof handle.metadata === "object" && handle.metadata !== null
                                ? (handle.metadata as {
                                    provider?: unknown;
                                }).provider
                                : undefined,
                        });
                        throw new Error(`${PROVISION_ATTRIBUTION_GUARD_PREFIX} docker-backed sandbox ${handle.sandboxId} produced no durable node_id (metadata shape drift or empty nodeId); refusing to mark running with node_id NULL`);
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
                    await this.host.ensureRuntimeAgentStarted(runtimeRec);
                    // 4. Persist the reachable container and provider-specific metadata.
                    //
                    // Every container remains non-routable (`provisioning`) until the
                    // restore tail commits readiness (#30697): the proxy readiness gate
                    // must not open while a known backup is still unapplied. A crash
                    // leaves a retryable provisioning row. Pool rows similarly remain
                    // unclaimable until their final readiness CAS.
                    const updateData: Parameters<typeof agentSandboxesRepository.update>[1] = {
                        status: "provisioning",
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
                        if (dockerMeta.nodeId)
                            updateData.node_id = dockerMeta.nodeId;
                        if (dockerMeta.containerName)
                            updateData.container_name = dockerMeta.containerName;
                        if (dockerMeta.bridgePort)
                            updateData.bridge_port = dockerMeta.bridgePort;
                        if (dockerMeta.webUiPort)
                            updateData.web_ui_port = dockerMeta.webUiPort;
                        if (dockerMeta.headscaleIp)
                            updateData.headscale_ip = dockerMeta.headscaleIp;
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
                    const updated = await this.host.transferReplacementToPrimary(rec.id, rec.organization_id, handle, rec.environment_revision, updateData);
                    rec = updated;
                    // 5. Restore from backup (reconstructs incrementals back to a full).
                    //
                    // A known backup is the agent's retained state. Every lookup,
                    // reconstruction or application failure fails this provision and
                    // leaves the stored chain intact (#30697): nothing here prunes, and
                    // nothing boots a reachable empty runtime around a known backup.
                    // Transient failures (5xx, network, DB) propagate unchanged so the
                    // job retries. Failures that cannot heal on retry (crypto, 401/403,
                    // 404/410, an image without the restore endpoint, null
                    // reconstruction, size refusal) become the typed consent error:
                    // the only way to boot without that state is wake's explicit
                    // forceFreshBoot. First creation without a backup is unaffected.
                    let backup: Awaited<ReturnType<typeof agentSandboxesRepository.getLatestBackup>>;
                    let restoreState: Awaited<ReturnType<typeof agentSandboxesRepository.getReconstructedBackupState>>;
                    if (restoreOverride?.kind === "fresh-boot" ||
                        restoreOverride?.kind === "reviewed-fresh-boot") {
                        // Explicit opt-in (wake forceFreshBoot): the caller accepted the
                        // data loss, so no backup is read or pruned — the stored chain
                        // stays intact for a later explicit restore.
                        backup = undefined;
                        restoreState = undefined;
                        logger.warn("[agent-sandbox] Backup restore skipped: explicit fresh boot requested", {
                            agentId: rec.id,
                        });
                    }
                    else {
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
                                    throw new Error(`Restore backup ${restoreOverride.backupId} not found for this agent`);
                                }
                            }
                            restoreState = reviewedRestore
                                ? reviewedRestore.state
                                : backup
                                    ? await agentSandboxesRepository.getReconstructedBackupState(backup.id)
                                    : undefined;
                            if (backup && !restoreState) {
                                // The row can disappear or leave the legacy-visible lane
                                // between lookup and chain reconstruction. A known backup
                                // that cannot be reconstructed is a recovery failure, not
                                // permission to boot a reachable empty runtime.
                                throw new ElizaError(`Restore backup ${backup.id} could not be reconstructed`, {
                                    code: "SNAPSHOT_RESTORE_RECONSTRUCTION_FAILED",
                                    context: { agentId: rec.id, backupId: backup.id },
                                    severity: "fatal",
                                });
                            }
                        }
                        catch (error) {
                            // error-policy:J1 translate unrecoverable restore failures to the consent contract.
                            throw restoreFailure(rec.id, backup?.id, error);
                        }
                    }
                    if (restoreState) {
                        try {
                            if (reviewedRestore && restoreOverride?.kind === "from-reviewed-backup") {
                                await dbWrite.transaction(async (tx) => {
                                    const lockedRestoreChain = await tx
                                        .select()
                                        .from(agentSandboxBackups)
                                        .where(and(inArray(agentSandboxBackups.id, reviewedRestore.storedChain.map((row) => row.id)), eq(agentSandboxBackups.sandbox_record_id, rec.id)))
                                        .orderBy(asc(agentSandboxBackups.id))
                                        .for("update")
                                        .execute();
                                    if (!storedRestoreChainStillCanonical(lockedRestoreChain, reviewedRestore.storedChain) ||
                                        !storedRestoreChainMatchesReviewedAuthority(lockedRestoreChain, rec.id, restoreOverride)) {
                                        throw new Error(RESTORE_BACKUP_CHANGED);
                                    }
                                    await this.host.pushState(handle.bridgeUrl, restoreState, {
                                        trusted: true,
                                        authRec: rec,
                                    });
                                });
                            }
                            else {
                                await this.host.pushState(handle.bridgeUrl, restoreState, {
                                    trusted: true,
                                    authRec: rec,
                                });
                            }
                        }
                        catch (error) {
                            // error-policy:J1 translate unrecoverable restore failures to the consent contract.
                            throw restoreFailure(rec.id, backup?.id, error);
                        }
                    }
                    // Re-enter the billable set only once the retained state is
                    // applied. A credit-suspended agent (billing_status='suspended')
                    // that a user tops up and resumes/wakes would otherwise run
                    // permanently EXCLUDED from listBillableSandboxes. Idempotent and
                    // exempt-guarded. Funded compute owns its own billing window.
                    if (!computeFundingId) {
                        await agentBillingRepository.reactivateSandboxBillingAfterFunding(rec.id, new Date());
                    }
                    let completed = computeFundingId
                        ? await completeProvisionCompute(updated, computeFundingId, handle)
                        : recoveringPendingWarmClaim || isWarmPoolProvision
                            ? updated
                            : await commitProvisionReadiness(updated, handle);
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
                    skipFundingCleanup = true;
                    return {
                        success: true,
                        sandboxRecord: completed,
                        bridgeUrl: handle.bridgeUrl,
                        healthUrl: handle.healthUrl,
                    };
                }
                catch (err) {
                    // error-policy:J1 preserve startup failure while proving replacement cleanup.
                    // Ghost container deletion: provider.create() succeeded but DB update or health check failed
                    const msg = err instanceof Error ? err.message : String(err);
                    lastError = msg;
                    lastFailureCause = err;
                    // Transport-unresolved readiness probe: the probe never reached the
                    // container, so it is likely healthy. DO NOT tear it down and DO NOT
                    // markError — that is exactly the false-negative that wedges a healthy
                    // row (#15310 #6). Leave the container running and return a RETRYABLE
                    // failure: the provision job retries, and the daemon stuck-provisioning
                    // reconciler re-probes and flips the row to `running` once transport
                    // recovers. Preserve the (pending/provisioning) row so the reconciler
                    // and job retry both have something to act on.
                    if (err instanceof SandboxReachabilityUnresolvedError) {
                        skipFundingCleanup = true;
                        logger.warn("[agent-sandbox] Managed reachability remains unresolved; leaving container in place for retry/reconciliation", { agentId: rec.id, sandboxId: handle.sandboxId, attempt });
                        return {
                            success: false,
                            retryable: true,
                            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                            error: msg,
                            failureCause: err,
                        };
                    }
                    logger.warn("[agent-sandbox] Post-create failure, cleaning up container", {
                        agentId: rec.id,
                        sandboxId: handle.sandboxId,
                        attempt,
                        error: msg,
                    });
                    try {
                        if (computeFundingId) {
                            await reconcileFailedProvisionCompute(rec.id, rec.organization_id, computeFundingId, {
                                expected: rec, handle,
                            });
                            skipFundingCleanup = true;
                        }
                        const current = await agentSandboxesRepository.findByIdAndOrg(rec.id, rec.organization_id);
                        let retiredExactly = false;
                        if (current && this.host.getReplacementCleanupLocator(current)) {
                            await this.host.retirePersistedReplacementCleanup(rec.id, rec.organization_id, undefined, undefined, "lifecycle", handle);
                            retiredExactly = true;
                        }
                        else if (!computeFundingId && isDockerBackedMetadata(handle.metadata)) {
                            // Adoption cleared the create-time fence. The container name
                            // is reusable, so delayed teardown by name could resolve a
                            // healthy successor (#29678). Re-fence the exact node,
                            // immutable container ID, attempt label and VPN identity,
                            // then retire through the same exact authority. Incomplete
                            // identity throws and stays a retryable cleanup failure.
                            await this.host.fenceAdoptedProvisionForCleanup(rec.id, rec.organization_id, handle, rec.environment_revision);
                            await this.host.retirePersistedReplacementCleanup(rec.id, rec.organization_id, undefined, undefined, "lifecycle", handle);
                            retiredExactly = true;
                        }
                        else if (!computeFundingId) {
                            // Non-Docker providers own no reusable fleet name.
                            const provider = await this.host.getProvider();
                            if (!provider.stopForReplacement) {
                                throw new Error("Sandbox provider cannot prove failed provision absent");
                            }
                            await provider.stopForReplacement(handle.sandboxId);
                        }
                        if (retiredExactly) {
                            // The fence writes advanced the lifecycle revision under this
                            // provision's own authority. Rebind the failure mark only when
                            // generation and job ownership are otherwise unchanged, so the
                            // failed recovery stays visible instead of a stale CAS miss.
                            const retired = await agentSandboxesRepository.findByIdAndOrgForWrite(rec.id, rec.organization_id);
                            if (retired &&
                                retired.environment_revision === rec.environment_revision &&
                                retired.lifecycle_job_id === rec.lifecycle_job_id &&
                                retired.lifecycle_execution_generation === rec.lifecycle_execution_generation &&
                                retired.deletion_attempt_id === null &&
                                retired.replacement_cleanup_sandbox_id === null) {
                                rec = retired;
                            }
                        }
                    }
                    catch (stopErr) {
                        // error-policy:J1 provisioning boundary translation — failed ghost
                        // cleanup is surfaced as retryable and retains its durable locator.
                        logger.error("[agent-sandbox] Ghost container cleanup remains unresolved", {
                            sandboxId: handle.sandboxId,
                            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
                        });
                        if (computeFundingId)
                            skipFundingCleanup = true;
                        return {
                            success: false,
                            retryable: true,
                            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                            error: `${msg}; replacement cleanup remains pending: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
                            failureCause: err,
                        };
                    }
                    // Check if it's a unique constraint error (port collision) -> retry
                    const isUniqueConstraintError = msg.includes("23505") ||
                        msg.toLowerCase().includes("unique") ||
                        msg.toLowerCase().includes("duplicate");
                    lastErrorRetryable = isUniqueConstraintError;
                    if (isUniqueConstraintError && !computeFundingId && attempt < MAX_PROVISION_ATTEMPTS) {
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
            rec = (await this.markError(rec, `Provisioning failed after ${attemptsLabel}${giveUpReason}: ${lastError}`)) ?? rec;
            return {
                success: false,
                sandboxRecord: await agentSandboxesRepository.findById(rec.id),
                error: lastError,
                ...(lastFailureCause === undefined
                    ? {}
                    : { failureCause: lastFailureCause }),
            };
        }
        finally {
            try {
                if (computeFundingId && !skipFundingCleanup) {
                    await reconcileFailedProvisionCompute(rec.id, rec.organization_id, computeFundingId, { expected: rec });
                }
            }
            finally {
                if (reviewedAdmissionFence) {
                    await releaseReviewedProvisionAdmissionFence(reviewedAdmissionFence);
                }
            }
        }
  }
  async markError(rec: AgentSandbox, msg: string) {
    return agentSandboxesRepository.markProvisionFailed(rec, msg);
  }
  /**
   * Resume a prior transport-unresolved provision attempt before creating a new
   * deterministic Docker container. The provider's container name is
   * `agent-${id}`; calling create again while the preserved container still
   * exists turns Docker's "already in use" into a cleanup path that removes the
   * very container the retry was meant to save.
   */
  buildProvisioningRetryHandle(rec: AgentSandbox): SandboxHandle | null {
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
  async persistContainerHandleForRetry(
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
    await this.host.transferReplacementToPrimary(
      agentId,
      organizationId,
      handle,
      environmentRevision,
      updateData,
    );
  }
  async provisionAgentDatabase(rec: AgentSandbox): Promise<{
    success: boolean;
    connectionUri?: string;
    error?: string;
  }> {
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
}

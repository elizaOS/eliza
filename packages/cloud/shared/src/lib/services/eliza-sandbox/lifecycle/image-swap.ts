/** Coordinates upgrade and rollback from candidate provisioning through health validation and atomic image cutover. The host supplies backup capture, cleanup authority, lifecycle locks, and its existing provider instance. */

import { inArray, sql } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "../../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../../db/repositories/docker-nodes";
import {
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../../../db/schemas/agent-sandboxes";
import { imageRepo, repinImageDigest } from "../../../../db/utils/docker-image-ref";
import { logger } from "../../../utils/logger";
import { withTimeout } from "../../../utils/with-timeout";
import {
  assertAdminCanaryCanonicalOrDemoPair,
  assertDemoSourceImage,
  assertSha256Digest,
  parseAdminCanaryDemoImage,
} from "../../admin-canary-image";
import { decryptAgentEnvVars } from "../../agent-env-crypto";
import { applyManagedAgentInferenceEnvDefaults } from "../../managed-eliza-config";
import { applyRemoteDockerRuntimeMode } from "../../remote-docker-runtime-mode";
import { type SandboxProvider } from "../../sandbox-provider";
import { SandboxReplacementCleanupUnresolvedError } from "../../sandbox-provider-types";
import { hasReadyWarmClaimCredential } from "../../warm-claim-key-push";
import { SandboxBackup } from "../backup/service.js";
import { SandboxTransport } from "../bridge/transport.js";
import { SandboxLifecycleAuthority } from "./authority.js";
import {
  AdminCanaryImageExecutionPolicy,
  AgentRuntimeHealthPayload,
  AgentRuntimeStartupPayload,
  AgentRuntimeStatusPayload,
  digestPinnedImageRef,
  ImageSwapResult,
  UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS,
} from "./image-contracts.js";
import { containerBackedServiceRejection } from "./policy.js";
import { isDockerSandboxMetadata } from "./provider-metadata.js";
import { SandboxReplacementCleanup } from "./replacement-cleanup.js";

export interface SandboxImageSwapHost {
  getAgentJsonHeaders(
    ...args: Parameters<SandboxTransport["getAgentJsonHeaders"]>
  ): ReturnType<SandboxTransport["getAgentJsonHeaders"]>;
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
  snapshot(...args: Parameters<SandboxBackup["snapshot"]>): ReturnType<SandboxBackup["snapshot"]>;
  lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]>;
  getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>;
  replacementCleanupMatchesHandle(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupMatchesHandle"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupMatchesHandle"]>;
  replacementCleanupCreatedAtMatches(
    ...args: Parameters<SandboxReplacementCleanup["replacementCleanupCreatedAtMatches"]>
  ): ReturnType<SandboxReplacementCleanup["replacementCleanupCreatedAtMatches"]>;
  pushState(
    ...args: Parameters<SandboxBackup["pushState"]>
  ): ReturnType<SandboxBackup["pushState"]>;
}

export class SandboxImageSwap {
  constructor(private readonly host: SandboxImageSwapHost) {}

  async verifyReplacementRuntimeHealth(args: {
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

    const headers = this.host.getAgentJsonHeaders(args.agent);
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
  async executeUpgradeWithPolicy(
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
    if (this.host.getReplacementCleanupLocator(agent)) {
      try {
        await this.host.retirePersistedReplacementCleanup(agentId, orgId);
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

    const provider = await this.host.getProvider();
    const { DockerSandboxProvider } = await import("../../docker-sandbox-provider");
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
      ...this.host.replacementCleanupCallbacks(agentId, orgId, {
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
        await this.host.persistUnresolvedReplacementCleanupFence(agentId, orgId, err);
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
        await this.host.retirePersistedReplacementCleanup(agentId, orgId);
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

    if (!(await provider.checkHealth(blueHandle, { kind: "candidate" }))) {
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
    const preUpgradeSnapshot = await this.host
      .snapshot(agentId, orgId, "pre-upgrade")
      .catch((err) => ({
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
        await this.host.lockLifecycle(tx, agentId, orgId);
        const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        const cleanupLocator = this.host.getReplacementCleanupLocator(current);
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
          !this.host.replacementCleanupMatchesHandle(cleanupLocator, blueHandle) ||
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
            AND ${this.host.replacementCleanupCreatedAtMatches(cleanupLocator.createdAt)}
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
      await this.host.retirePersistedReplacementCleanup(
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
  async executeDowngradeWithPolicy(
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
    if (this.host.getReplacementCleanupLocator(agent)) {
      try {
        await this.host.retirePersistedReplacementCleanup(agentId, orgId);
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

    const provider = await this.host.getProvider();
    const { DockerSandboxProvider } = await import("../../docker-sandbox-provider");
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
      ...this.host.replacementCleanupCallbacks(agentId, orgId, {
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
        await this.host.persistUnresolvedReplacementCleanupFence(agentId, orgId, err);
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
        await this.host.retirePersistedReplacementCleanup(agentId, orgId);
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

    if (!(await provider.checkHealth(blueHandle, { kind: "candidate" }))) {
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
          await this.host.pushState(blueHandle.bridgeUrl, restoreState, {
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
        await this.host.lockLifecycle(tx, agentId, orgId);
        const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        const cleanupLocator = this.host.getReplacementCleanupLocator(current);
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
          !this.host.replacementCleanupMatchesHandle(cleanupLocator, blueHandle) ||
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
            AND ${this.host.replacementCleanupCreatedAtMatches(cleanupLocator.createdAt)}
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
      await this.host.retirePersistedReplacementCleanup(
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
}

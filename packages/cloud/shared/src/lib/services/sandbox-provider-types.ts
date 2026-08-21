/** Coordinates cloud service sandbox provider contracts behind route handlers. */

import { ElizaError } from "@elizaos/core";
import {
  type AgentExecutionTier,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";

export type ContainerBackedExecutionTier = (typeof CONTAINER_BACKED_EXECUTION_TIERS)[number];

/** Rejects any tier that is not explicitly admitted to own a container. */
export function assertContainerBackedExecutionTier(
  executionTier: unknown,
): asserts executionTier is ContainerBackedExecutionTier {
  if (!CONTAINER_BACKED_EXECUTION_TIERS.some((tier) => tier === executionTier)) {
    throw new ElizaError("Sandbox creation requires an explicit container-backed execution tier", {
      code: "SANDBOX_CREATE_EXECUTION_TIER_NOT_CONTAINER_BACKED",
      context: {
        executionTier: typeof executionTier === "string" ? executionTier : null,
        executionTierType: executionTier === null ? "null" : typeof executionTier,
      },
      severity: "fatal",
    });
  }
}

/**
 * Why a readiness probe finished the way it did.
 *
 *   - `ready` — the probe reached the container and it answered healthy.
 *   - `not_ready` — the probe REACHED the container (SSH transport worked and
 *     the remote shell ran) but it was still not answering healthy when the
 *     budget ran out. A genuine "the container isn't up" verdict.
 *   - `transport_unresolved` — the budget was exhausted while EVERY probe
 *     attempt failed at the SSH transport layer (connect/exec/stream error or
 *     command timeout). The probe never reached a verdict about the container,
 *     so concluding "not ready" here would be a FALSE NEGATIVE — the exact
 *     split-brain that marks a healthy container failed and wedges its row.
 *     Callers should treat this as RETRYABLE, not terminal.
 */
export type SandboxHealthVerdict = "ready" | "not_ready" | "transport_unresolved";

export interface SandboxHealthOutcome {
  ready: boolean;
  verdict: SandboxHealthVerdict;
}

/**
 * Evidence produced by the provider-specific teardown used for agent deletion.
 * A successful stop is sufficient even when removal fails because stopped
 * containers do not consume compute slots. Unreachable workloads retain their
 * capacity until reconciliation proves they are no longer running.
 */
export type SandboxDeletionStopOutcome =
  | { kind: "not-running-proven" }
  | { kind: "not-running-unresolved"; reason: "node-unreachable" };

export interface SandboxReplacementCleanupLocator {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  replacementAttemptId?: string | null;
  containerId?: string | null;
  vpnNodeId?: string | null;
  vpnNodeName?: string | null;
  previousVpnNodeId?: string | null;
  vpnRegistrationStartedAt?: string | null;
  allocationCounted?: boolean | null;
}

/**
 * Carries the exact placement that must remain fenced when a replacement
 * candidate cannot be proven absent. Callers persist this locator before
 * retrying so an unreachable node can never produce two live agent runtimes.
 */
export class SandboxReplacementCleanupUnresolvedError extends Error {
  readonly sandboxId: string;
  readonly nodeId: string;
  readonly containerName: string;
  readonly replacementAttemptId: string | null;
  readonly containerId: string | null;
  readonly vpnNodeId: string | null;
  readonly vpnNodeName: string | null;
  readonly previousVpnNodeId: string | null;
  readonly vpnRegistrationStartedAt: string | null;
  readonly allocationCounted: boolean | null;

  constructor(locator: SandboxReplacementCleanupLocator, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Replacement cleanup is unresolved for ${locator.containerName} on ${locator.nodeId}: ${causeMessage}`,
      { cause },
    );
    this.name = "SandboxReplacementCleanupUnresolvedError";
    this.sandboxId = locator.sandboxId;
    this.nodeId = locator.nodeId;
    this.containerName = locator.containerName;
    this.replacementAttemptId = locator.replacementAttemptId ?? null;
    this.containerId = locator.containerId ?? null;
    this.vpnNodeId = locator.vpnNodeId ?? null;
    this.vpnNodeName = locator.vpnNodeName ?? null;
    this.previousVpnNodeId = locator.previousVpnNodeId ?? null;
    this.vpnRegistrationStartedAt = locator.vpnRegistrationStartedAt ?? null;
    this.allocationCounted = locator.allocationCounted ?? null;
  }
}

export interface SandboxProvider {
  create(config: SandboxCreateConfig): Promise<SandboxHandle>;
  /**
   * Tears down a sandbox for deletion and reports whether the provider proved
   * the workload is not running. The deletion workflow owns capacity release,
   * so an unresolved outcome completes deletion without authorizing release.
   */
  stopForDeletion(sandboxId: string): Promise<SandboxDeletionStopOutcome>;
  /**
   * Retires a sandbox before a replacement is allowed to start. Unlike the
   * ordinary delete-oriented stop path, this must reject whenever the provider
   * cannot prove the old workload is no longer running; abandoning an
   * unreachable container would create two live agents after the node returns.
   */
  stopForReplacement?(sandboxId: string): Promise<void>;
  /**
   * Reclaims a replacement candidate from its durable placement record. This
   * bypasses sandbox-id lookup because the routed agent row may still point at
   * the old blue/green leg while the candidate cleanup fence points elsewhere.
   */
  stopOnSpecificNodeForReplacement?(
    nodeId: string,
    containerName: string,
    vpnNodeId?: string | null,
    identity?: Omit<
      SandboxReplacementCleanupLocator,
      "sandboxId" | "nodeId" | "containerName" | "vpnNodeId"
    >,
  ): Promise<void>;
  checkHealth(handle: SandboxHandle): Promise<boolean>;
  /**
   * Richer readiness probe that distinguishes a genuine `not_ready` from a
   * `transport_unresolved` exhaustion (see {@link SandboxHealthVerdict}).
   * Optional so providers that cannot fail at a transport layer (memory/local)
   * need not implement it; callers fall back to `checkHealth` when absent.
   */
  checkHealthDetailed?(handle: SandboxHandle): Promise<SandboxHealthOutcome>;
  runCommand?(sandboxId: string, cmd: string, args?: string[]): Promise<string>;
  /** Tail container logs from the sandbox runtime (e.g. `docker logs --tail N`). */
  fetchLogs?(sandboxId: string, tail: number): Promise<string>;
}

export interface SandboxHandle {
  sandboxId: string;
  bridgeUrl: string;
  healthUrl: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxContainerLaunchConfig {
  projectName?: string;
  port?: number;
  /** ECS-style CPU units; 1024 units equal one vCPU. */
  cpu?: number;
  memoryMb?: number;
  desiredCount?: number;
  architecture?: "arm64" | "x86_64";
  healthCheckPath?: string;
}

export interface SandboxCreateConfig {
  agentId: string;
  agentName: string;
  organizationId: string;
  /** Durable placement authority read from the target agent row. */
  executionTier: AgentExecutionTier;
  environmentVars: Record<string, string>;
  /**
   * Full character config for this agent (the `agent_sandboxes.agent_config`
   * row). When present, the provider injects it as ELIZA_AGENT_CHARACTER_JSON
   * so the container boots AS this character instead of the bundled default
   * preset. See packages/agent/src/runtime/sandbox-character.ts.
   */
  agentConfig?: Record<string, unknown> | null;
  /**
   * The platform character_id used by the gateways to route inbound messages
   * (`agent:<id>:server` / `/agents/<id>/message`). Injected as
   * SANDBOX_ROUTE_AGENT_ID so the container registers under, and answers as,
   * this id (NOT the sandbox id). When absent the runtime keeps its prior
   * name-derived agent id and the sandbox falls back to keying the registry
   * by SANDBOX_AGENT_ID.
   */
  routeAgentId?: string | null;
  snapshotId?: string;
  resources?: { vcpus?: number; memoryMb?: number };
  timeout?: number;
  dockerImage?: string;
  container?: SandboxContainerLaunchConfig;
  /**
   * When set, the provider will not place the new sandbox on this Docker node.
   * Used for retry-on-failure to avoid re-selecting a node that just failed.
   */
  excludeNodeId?: string;
  /**
   * When false, an existing Headscale node under the agent's deterministic
   * hostname is preserved and recorded instead of deleted pre-provision
   * (#16565). Blue/green upgrade/downgrade set this: the "stale" node is the
   * LIVE serving one until the atomic swap commits. The orchestrator deletes
   * it by the recorded id (`metadata.previousVpnNodeId`) after cutover;
   * rolled-back paths leave it untouched. Default true (plain reprovision
   * keeps today's reclaim).
   */
  reclaimStaleVpnNode?: boolean;
  /**
   * Atomically reserves node capacity and persists the exact replacement
   * attempt before the remote Docker create can commit. The attempt token and
   * deterministic container name let recovery find the candidate even when the
   * SSH response carrying Docker's container id is lost.
   */
  onReplacementCreateIntent?: (handle: SandboxHandle) => Promise<void>;
  /** CAS-enriches a persisted intent with Docker's exact container id. */
  onReplacementCreated?: (handle: SandboxHandle) => Promise<void>;
  /**
   * Enriches the durable candidate fence with the exact Headscale identity as
   * soon as registration completes. The initial placement remains authoritative
   * if this callback fails, and the provider returns its exact locator.
   */
  onReplacementVpnRegistered?: (handle: SandboxHandle) => Promise<void>;
}

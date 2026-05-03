/**
 * Agent Sandbox Service — orchestrates cloud agent lifecycle:
 * Neon DB provisioning, Docker sandbox creation, bridge proxy, backups, heartbeat.
 */

import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { type Database, dbWrite } from "@/db/helpers";
import {
  type AgentBackupSnapshotType,
  type AgentSandbox,
  type AgentSandboxBackup,
  agentSandboxesRepository,
  prepareAgentBackupInsertData,
} from "@/db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import {
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
} from "@/db/schemas/agent-sandboxes";
import { jobs } from "@/db/schemas/jobs";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import {
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "@/lib/services/eliza-agent-config";
import { logger } from "@/lib/utils/logger";
import type { DockerSandboxMetadata } from "./docker-sandbox-provider";
import { elizaProvisionAdvisoryLockSql } from "./eliza-provision-lock";
import { prepareManagedElizaEnvironment } from "./managed-eliza-env";
import { getNeonClient, NeonClientError } from "./neon-client";
import { JOB_TYPES } from "./provisioning-job-types";
import { createSandboxProvider, type SandboxProvider } from "./sandbox-provider";

/** Shared Neon project used as branch parent for per-agent databases. */
const NEON_PARENT_PROJECT_ID: string = process.env.NEON_PARENT_PROJECT_ID ?? "";

export interface CreateAgentParams {
  organizationId: string;
  userId: string;
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  /** Link to a user_characters record (canonical character with token linkage). */
  characterId?: string;
  /** Override the default Docker image (e.g. for different agent flavors). */
  dockerImage?: string;
}

export type ProvisionResult =
  | {
      success: true;
      sandboxRecord: AgentSandbox;
      bridgeUrl: string;
      healthUrl: string;
    }
  | { success: false; sandboxRecord?: AgentSandbox; error: string };

export type DeleteAgentResult =
  | { success: true; deletedSandbox: AgentSandbox }
  | { success: false; error: string };

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface SnapshotResult {
  success: boolean;
  backup?: AgentSandboxBackup;
  error?: string;
}

const MAX_BACKUPS = 10;
type LifecycleTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class ElizaSandboxService {
  private _provider?: SandboxProvider;
  private _providerPromise?: Promise<SandboxProvider>;

  constructor(provider?: SandboxProvider) {
    if (provider) {
      this._provider = provider;
    }
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

  // Agent CRUD

  async createAgent(params: CreateAgentParams): Promise<AgentSandbox> {
    logger.info("[agent-sandbox] Creating agent", {
      orgId: params.organizationId,
      name: params.agentName,
    });

    const sanitizedConfig = stripReservedElizaConfigKeys(params.agentConfig);
    const agentConfig = params.characterId
      ? withReusedElizaCharacterOwnership(sanitizedConfig)
      : sanitizedConfig;

    return agentSandboxesRepository.create({
      organization_id: params.organizationId,
      user_id: params.userId,
      agent_name: params.agentName,
      agent_config: agentConfig,
      environment_vars: params.environmentVars ?? {},
      status: "pending",
      database_status: "none",
      ...(params.characterId && { character_id: params.characterId }),
      ...(params.dockerImage && { docker_image: params.dockerImage }),
    });
  }

  async getAgent(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
  }

  async getAgentForWrite(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
  }

  async listAgents(orgId: string) {
    return agentSandboxesRepository.listByOrganization(orgId);
  }

  async deleteAgent(agentId: string, orgId: string): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          error: "Agent provisioning is in progress",
        } as const;
      }

      logger.info("[agent-sandbox] Deleting agent", {
        agentId,
        neon: rec.neon_project_id,
        sandbox: rec.sandbox_id,
      });

      if (rec.sandbox_id) {
        try {
          await (await this.getProvider()).stop(rec.sandbox_id);
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          if (!this.isIgnorableSandboxStopError(e)) {
            logger.warn("[agent-sandbox] Stop failed during delete", {
              sandboxId: rec.sandbox_id,
              status: rec.status,
              error: errorMessage,
            });
            return {
              success: false,
              error: "Failed to delete sandbox",
            } as const;
          }

          logger.info("[agent-sandbox] Sandbox already absent during delete cleanup", {
            sandboxId: rec.sandbox_id,
            status: rec.status,
            error: errorMessage,
          });
        }
      }
      if (rec.neon_project_id) {
        try {
          await this.cleanupNeon(rec.neon_project_id, rec.neon_branch_id);
        } catch (e) {
          logger.warn("[agent-sandbox] Neon cleanup failed during delete", {
            projectId: rec.neon_project_id,
            branchId: rec.neon_branch_id,
            error: e instanceof Error ? e.message : String(e),
          });
          return {
            success: false,
            error: "Failed to delete database project",
          } as const;
        }
      }

      const result = await tx.execute<AgentSandbox>(sql`
        DELETE FROM ${agentSandboxes}
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
        RETURNING *
      `);
      const deletedSandbox = result.rows[0];

      return deletedSandbox
        ? ({ success: true, deletedSandbox } as const)
        : ({ success: false, error: "Agent not found" } as const);
    });
  }

  // Provision

  async provision(agentId: string, orgId: string): Promise<ProvisionResult> {
    let rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" } as ProvisionResult;

    const lock = await agentSandboxesRepository.trySetProvisioning(rec.id);
    if (!lock) {
      if (rec.status === "running" && rec.bridge_url && rec.health_url)
        return {
          success: true,
          sandboxRecord: rec,
          bridgeUrl: rec.bridge_url,
          healthUrl: rec.health_url,
        };
      return {
        success: false,
        sandboxRecord: rec,
        error: "Agent is already being provisioned",
      };
    }

    // 1. Database
    let dbUri = rec.database_uri;
    if (rec.database_status !== "ready" || !dbUri) {
      const db = await this.provisionNeon(rec);
      if (!db.success) {
        await this.markError(rec, `Database provisioning failed: ${db.error}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: db.error ?? "Unknown database error",
        };
      }
      dbUri = db.connectionUri!;
      // Neon provision updates DB but doesn't return the full record; re-fetch to avoid stale data
      const refreshed = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
      if (refreshed) {
        rec = refreshed;
      }
    }

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

    // 2-5. Sandbox creation + DB persistence with retry for port collision
    // TOCTOU race: Port allocation happens in-memory (provider allocates next available port),
    // but persistence to DB (unique constraint on node_id + bridge_port) happens later.
    // If two concurrent provisions pick the same port, one will fail with PG 23505.
    // Solution: Retry loop catches unique constraint errors, cleans up ghost container, and retries.
    const MAX_PROVISION_ATTEMPTS = 3;
    let lastError: string = "Unknown error";

    for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt++) {
      let handle;

      try {
        // 2. Sandbox (via provider)
        handle = await (await this.getProvider()).create({
          agentId: rec.id,
          agentName: rec.agent_name ?? "CloudAgent",
          organizationId: rec.organization_id,
          environmentVars: {
            ...((rec.environment_vars as Record<string, string>) ?? {}),
            DATABASE_URL: dbUri,
          },
          snapshotId: rec.snapshot_id ?? undefined,
          dockerImage: rec.docker_image ?? undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.markError(rec, `Sandbox creation failed: ${msg}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: msg,
        };
      }

      try {
        // 3. Health check (via provider)
        if (!(await (await this.getProvider()).checkHealth(handle))) {
          throw new Error("Sandbox health check timed out");
        }

        // 4. Restore from backup
        const backup = await agentSandboxesRepository.getLatestBackup(rec.id);
        if (backup)
          await this.pushState(handle.bridgeUrl, backup.state_data as AgentBackupStateData, {
            trusted: true,
          });

        // 5. Mark running + persist provider-specific metadata
        const updateData: Parameters<typeof agentSandboxesRepository.update>[1] = {
          status: "running",
          sandbox_id: handle.sandboxId,
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          last_heartbeat_at: new Date(),
          error_message: null,
        };

        const dockerMeta = handle.metadata as unknown as DockerSandboxMetadata | undefined;
        if (dockerMeta) {
          if (dockerMeta.nodeId) updateData.node_id = dockerMeta.nodeId;
          if (dockerMeta.containerName) updateData.container_name = dockerMeta.containerName;
          if (dockerMeta.bridgePort) updateData.bridge_port = dockerMeta.bridgePort;
          if (dockerMeta.webUiPort) updateData.web_ui_port = dockerMeta.webUiPort;
          if (dockerMeta.headscaleIp) updateData.headscale_ip = dockerMeta.headscaleIp;
          if (dockerMeta.dockerImage) updateData.docker_image = dockerMeta.dockerImage;
        }

        const updated = await agentSandboxesRepository.update(rec.id, updateData);

        logger.info("[agent-sandbox] Provisioned", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
        });
        return {
          success: true,
          sandboxRecord: updated!,
          bridgeUrl: handle.bridgeUrl,
          healthUrl: handle.healthUrl,
        };
      } catch (err) {
        // Ghost container cleanup: provider.create() succeeded but DB update or health check failed
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;

        logger.warn("[agent-sandbox] Post-create failure, cleaning up container", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
          error: msg,
        });

        await (await this.getProvider()).stop(handle.sandboxId).catch((stopErr) => {
          logger.error("[agent-sandbox] Ghost container cleanup failed", {
            sandboxId: handle.sandboxId,
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        });

        // Check if it's a unique constraint error (port collision) -> retry
        const isUniqueConstraintError =
          msg.includes("23505") ||
          msg.toLowerCase().includes("unique") ||
          msg.toLowerCase().includes("duplicate");

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

    // All attempts exhausted
    await this.markError(
      rec,
      `Provisioning failed after ${MAX_PROVISION_ATTEMPTS} attempts: ${lastError}`,
    );
    return {
      success: false,
      sandboxRecord: await agentSandboxesRepository.findById(rec.id),
      error: lastError,
    };
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

  // Bridge

  async bridge(agentId: string, orgId: string, rpc: BridgeRequest): Promise<BridgeResponse> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) {
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
      const bridgeEndpoint = await this.getSafeBridgeEndpoint(rec, "/bridge");
      const res = await fetch(bridgeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok)
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32000,
            message: `Bridge returned HTTP ${res.status}`,
          },
        };
      return (await res.json()) as BridgeResponse;
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
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

      // Extract API token from environment_vars
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for wallet proxy", {
          agentId,
        });
      }

      // Prefer the public domain over internal bridge IPs (only reachable
      // from within the Hetzner network).
      const agentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      let endpoint: string;
      if (agentBaseDomain) {
        // Public URL: https://{agentId}.waifu.fun/api/wallet/...
        endpoint = `https://${agentId}.${agentBaseDomain}${fullPath}`;
      } else if (rec.web_ui_port && rec.node_id) {
        // Internal fallback: http://{host}:{web_ui_port}/api/wallet/...
        const bridgeUrl = new URL(rec.bridge_url);
        endpoint = `${bridgeUrl.protocol}//${bridgeUrl.hostname}:${rec.web_ui_port}${fullPath}`;
      } else {
        endpoint = await this.getSafeBridgeEndpoint(rec, fullPath);
      }

      logger.info("[agent-sandbox] Wallet proxy endpoint", {
        agentId,
        endpoint: endpoint.replace(/Bearer.*/, "***"),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
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
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for schedule proxy", {
          agentId,
        });
      }

      const agentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      let endpoint: string;
      if (agentBaseDomain) {
        endpoint = `https://${agentId}.${agentBaseDomain}${fullPath}`;
      } else if (rec.web_ui_port && rec.node_id) {
        const bridgeUrl = new URL(rec.bridge_url);
        endpoint = `${bridgeUrl.protocol}//${bridgeUrl.hostname}:${rec.web_ui_port}${fullPath}`;
      } else {
        endpoint = await this.getSafeBridgeEndpoint(rec, fullPath);
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Schedule proxy request failed", {
        agentId,
        schedulePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async bridgeStream(agentId: string, orgId: string, rpc: BridgeRequest): Promise<Response | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) return null;

    try {
      const bridgeEndpoint = await this.getSafeBridgeEndpoint(rec, "/bridge/stream");
      const res = await fetch(bridgeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc),
        signal: AbortSignal.timeout(120_000),
      });
      return res.ok ? res : null;
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Snapshots

  async snapshot(
    agentId: string,
    orgId: string,
    type: AgentBackupSnapshotType = "manual",
  ): Promise<SnapshotResult> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) return { success: false, error: "Sandbox is not running" };

    const { stateData, sizeBytes } = await this.fetchSnapshotState(rec);

    const backup = await agentSandboxesRepository.createBackup({
      sandbox_record_id: rec.id,
      snapshot_type: type,
      state_data: stateData,
      size_bytes: sizeBytes,
    });

    await agentSandboxesRepository.update(rec.id, {
      last_backup_at: new Date(),
    });
    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS);
    logger.info("[agent-sandbox] Backup created", {
      agentId,
      type,
      bytes: backup.size_bytes,
    });
    return { success: true, backup };
  }

  async restore(agentId: string, orgId: string, backupId?: string): Promise<SnapshotResult> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };

    const backup = backupId
      ? await agentSandboxesRepository.getBackupById(backupId)
      : await agentSandboxesRepository.getLatestBackup(rec.id);
    if (!backup) return { success: false, error: "No backup found" };

    // Verify backup belongs to this sandbox to prevent cross-agent restore
    if (backup.sandbox_record_id !== rec.id) {
      return { success: false, error: "Backup does not belong to this agent" };
    }

    if (rec.status !== "running" && backupId) {
      const latestBackup = await agentSandboxesRepository.getLatestBackup(rec.id);
      if (!latestBackup || backup.id !== latestBackup.id) {
        return {
          success: false,
          error: "Stopped agents can only restore the latest backup",
        };
      }
    }

    if (rec.status === "running" && rec.bridge_url) {
      await this.pushState(rec, backup.state_data as AgentBackupStateData);
      return { success: true, backup };
    }

    const prov = await this.provision(agentId, orgId);
    return prov.success ? { success: true, backup } : { success: false, error: prov.error };
  }

  async listBackups(agentId: string, orgId: string): Promise<AgentSandboxBackup[]> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    return rec ? agentSandboxesRepository.listBackups(rec.id) : [];
  }

  // Heartbeat

  async heartbeat(agentId: string, orgId: string): Promise<boolean> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) return false;

    const res = await (async () => {
      try {
        const heartbeatEndpoint = await this.getSafeBridgeEndpoint(rec, "/bridge");
        return await fetch(heartbeatEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "heartbeat",
          } satisfies BridgeRequest),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        logger.warn("[agent-sandbox] Heartbeat request failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!res?.ok) {
      logger.warn("[agent-sandbox] Heartbeat failed, marking disconnected", {
        agentId,
      });
      await agentSandboxesRepository.update(rec.id, {
        status: "disconnected",
      });
      return false;
    }
    await agentSandboxesRepository.update(rec.id, {
      last_heartbeat_at: new Date(),
    });
    return true;
  }

  // Shutdown

  async shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }> {
    let snapshotAgentId: string | null = null;
    let preShutdownSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;

    const snapshotSource = await this.getAgentForWrite(agentId, orgId);
    if (snapshotSource?.status === "running" && snapshotSource.bridge_url) {
      preShutdownSnapshot = await this.fetchSnapshotState(snapshotSource).catch((error) => {
        logger.warn("[agent-sandbox] Pre-shutdown backup fetch failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    }

    const result = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          error: "Agent provisioning is in progress",
        } as const;
      }

      if (
        preShutdownSnapshot &&
        rec.status === "running" &&
        rec.bridge_url === preShutdownSnapshot.bridgeUrl
      ) {
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
        await (await this.getProvider()).stop(rec.sandbox_id).catch((e) => {
          logger.warn("[agent-sandbox] Stop failed during shutdown", {
            sandboxId: rec.sandbox_id,
            status: rec.status,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          updated_at = NOW()
        WHERE id = ${rec.id}
      `);

      snapshotAgentId = rec.id;
      return { success: true } as const;
    });

    if (result.success && snapshotAgentId) {
      await agentSandboxesRepository.pruneBackups(snapshotAgentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after shutdown", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("[agent-sandbox] Shutdown complete", { agentId });
    }

    return result;
  }

  // Private helpers

  private async lockLifecycle(tx: LifecycleTx, agentId: string, orgId: string): Promise<void> {
    await tx.execute(elizaProvisionAdvisoryLockSql(orgId, agentId));
  }

  private async getAgentForLifecycleMutation(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<AgentSandbox | undefined> {
    const result = await tx.execute<AgentSandbox>(sql`
      SELECT *
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
      FOR UPDATE
    `);
    return result.rows[0];
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

  private async fetchSnapshotState(
    rec: Pick<
      AgentSandbox,
      "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id"
    >,
  ): Promise<{
    stateData: AgentBackupStateData;
    sizeBytes: number;
    bridgeUrl: string;
  }> {
    if (!rec.bridge_url) {
      throw new Error("Sandbox is not running");
    }

    const snapshotEndpoint = await this.getSafeBridgeEndpoint(rec, "/api/snapshot");
    const res = await fetch(snapshotEndpoint, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Snapshot fetch failed: HTTP ${res.status}`);
    }

    const stateData = (await res.json()) as AgentBackupStateData;
    const sizeBytes = Buffer.byteLength(JSON.stringify(stateData), "utf-8");

    return {
      stateData,
      sizeBytes,
      bridgeUrl: rec.bridge_url,
    };
  }

  private async persistSnapshotWithinTransaction(
    tx: LifecycleTx,
    sandboxRecordId: string,
    organizationId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<void> {
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

    await tx.execute(sql`
      UPDATE ${agentSandboxes}
      SET
        last_backup_at = NOW(),
        updated_at = NOW()
      WHERE id = ${sandboxRecordId}
    `);

    logger.info("[agent-sandbox] Backup created", {
      agentId: sandboxRecordId,
      type,
      bytes: backup?.size_bytes ?? sizeBytes,
    });
  }

  private async markError(rec: AgentSandbox, msg: string) {
    await agentSandboxesRepository.update(rec.id, {
      status: "error",
      error_message: msg,
      error_count: (rec.error_count ?? 0) + 1,
    });
  }

  private async provisionNeon(
    rec: AgentSandbox,
  ): Promise<{ success: boolean; connectionUri?: string; error?: string }> {
    // Use the shared cloud database instead of creating per-agent Neon projects.
    // ElizaOS plugin-sql tables scope all data by agent UUID, so multiple agents
    // safely coexist in one database. This avoids Neon project/branch limits
    // (BRANCHES_LIMIT_EXCEEDED at 100 projects / 10 branches per project).
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

  private async cleanupNeon(projectId: string | null | undefined, branchId?: string | null) {
    // In shared-DB mode no per-agent Neon project exists; nothing to clean up.
    if (!projectId) return;

    const neon = getNeonClient();
    try {
      if (projectId === NEON_PARENT_PROJECT_ID && branchId) {
        // Branch-based: delete the branch, not the shared project
        await neon.deleteBranch(NEON_PARENT_PROJECT_ID, branchId);
      } else if (projectId !== NEON_PARENT_PROJECT_ID) {
        // Legacy project-based: delete the entire project
        await neon.deleteProject(projectId);
      }
    } catch (error) {
      if (error instanceof NeonClientError && error.statusCode === 404) {
        logger.info("[agent-sandbox] Neon resource already absent during cleanup", {
          projectId,
          branchId,
        });
        return;
      }
      throw error;
    }
  }

  private isIgnorableSandboxStopError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("already gone") ||
      normalized.includes("no longer exists") ||
      normalized.includes("404")
    );
  }

  private async pushState(
    sandboxOrBridgeUrl:
      | Pick<AgentSandbox, "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id">
      | string,
    state: AgentBackupStateData,
    options?: { trusted?: boolean },
  ) {
    const restoreEndpoint = await this.getSafeBridgeEndpoint(
      sandboxOrBridgeUrl,
      "/api/restore",
      options,
    );
    const res = await fetch(restoreEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`State restore failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }
}

export const elizaSandboxService = new ElizaSandboxService();

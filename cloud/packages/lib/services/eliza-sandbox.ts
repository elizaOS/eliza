/**
 * Agent Sandbox Service — orchestrates cloud agent lifecycle:
 * Neon DB provisioning, Docker sandbox creation, bridge proxy, backups, heartbeat.
 */

import crypto from "node:crypto";
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
import { getElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
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

type RuntimeAgentSummary = {
  id?: string;
  name?: string;
  status?: string;
};

type RuntimeAgentListResult = {
  supported: boolean;
  agents: RuntimeAgentSummary[];
};

const DEFAULT_CENTRAL_SERVER_ID = "00000000-0000-0000-0000-000000000000";
const RUNTIME_AGENT_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_API_KEY",
  "OPENAI_EMBEDDING_URL",
  "OPENAI_EMBEDDING_DIMENSIONS",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
] as const;

class BridgeRouteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeRouteUnavailableError";
  }
}

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
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
    const agentsEndpoint = await this.getAgentApiEndpoint(rec, "/api/agents");
    const agentsRes = await fetch(agentsEndpoint, {
      method: "GET",
      headers: this.getAgentJsonHeaders(rec),
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
        : rec.agent_name?.trim() || `Cloud Agent ${rec.id.slice(0, 8)}`;
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
    const secrets: Record<string, unknown> = { ...rawSecrets };
    for (const key of RUNTIME_AGENT_SECRET_KEYS) {
      const current = typeof secrets[key] === "string" ? secrets[key].trim() : "";
      const next = environmentVars[key]?.trim();
      if (!current && next) {
        secrets[key] = next;
      }
    }
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
      system:
        typeof rawConfig.system === "string" && rawConfig.system.trim()
          ? rawConfig.system
          : "You are a concise, helpful cloud agent.",
      bio:
        Array.isArray(rawConfig.bio) && rawConfig.bio.length > 0
          ? rawConfig.bio
          : ["Managed Eliza Cloud agent"],
      topics:
        Array.isArray(rawConfig.topics) && rawConfig.topics.length > 0
          ? rawConfig.topics
          : ["cloud assistance"],
      adjectives:
        Array.isArray(rawConfig.adjectives) && rawConfig.adjectives.length > 0
          ? rawConfig.adjectives
          : ["helpful", "concise"],
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
    const startEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/agents/${encodeURIComponent(runtimeAgentId)}/start`,
    );
    const startRes = await fetch(startEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      signal: AbortSignal.timeout(60_000),
    });
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
    >,
  ): Promise<string> {
    const createEndpoint = await this.getAgentApiEndpoint(rec, "/api/agents");
    const createRes = await fetch(createEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify({ agent: this.buildRuntimeBootstrapAgent(rec) }),
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

        const dockerMeta = handle.metadata as unknown as DockerSandboxMetadata | undefined;
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

  private getConfiguredAgentBaseDomain(): string | null {
    const configured = getCloudAwareEnv().ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim();
    if (!configured) return null;
    const normalized = configured
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.+$/, "");
    return normalized || null;
  }

  private async getAgentApiEndpoint(
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
    const isWorkerRuntime = this.isCloudflareWorkerRuntime();
    const baseDomain = this.getConfiguredAgentBaseDomain();
    if (isWorkerRuntime) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(
        rec,
        baseDomain ? { baseDomain, path } : { path },
      );
      if (publicEndpoint) return publicEndpoint;
    }

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return new URL(path, trustedWebBaseUrl).toString();
    }

    if (baseDomain) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) return publicEndpoint;
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

    const rootEndpoint = await this.getAgentApiEndpoint(rec, "/");
    const rootRes = await fetch(rootEndpoint, {
      method: "GET",
      headers: this.getAgentJsonHeaders(rec),
      signal: AbortSignal.timeout(10_000),
    });
    if (!rootRes.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${rootRes.status}` },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
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

    const attempts = [
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
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32000, message: "Bridge message produced an empty response" },
    };
  }

  private bridgeResponseHasText(response: BridgeResponse): boolean {
    return typeof response.result?.text === "string" && response.result.text.trim().length > 0;
  }

  private async bridgeConversationMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const conversationId = await this.createBridgeConversation(rec, params);
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractBridgeMessageText(body) ?? "",
        agentName: typeof body.agentName === "string" ? body.agentName : undefined,
        conversationId,
      },
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
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeSessionMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    });
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
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeCentralChannelMessageBody(params, runtimeAgent.id)),
      signal: AbortSignal.timeout(60_000),
    });
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
      },
    };
  }

  private async requestBridgeOpenAiChatCompletion(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const endpoint = await this.getAgentApiEndpoint(rec, "/v1/chat/completions");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
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

    const exactWords =
      /\bexact words?\s*:\s*["']?(.+?)["']?\s*$/i.exec(text) ??
      /\breply\s+(?:briefly\s+)?with\s+["']([^"']+)["']/i.exec(text);
    if (exactWords?.[1]?.trim()) {
      return exactWords[1].trim();
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
    const endpoint = await this.getAgentApiEndpoint(rec, "/api/conversations");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
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
    const endpoint = await this.getAgentApiEndpoint(rec, "/api/messaging/sessions");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
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
    const endpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`,
    );

    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await fetch(endpoint, {
        method: "GET",
        headers: this.getAgentJsonHeaders(rec),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.toReversed()) {
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
    const endpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages?limit=30`,
    );

    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await fetch(endpoint, {
        method: "GET",
        headers: this.getAgentJsonHeaders(rec),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.toReversed()) {
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
    if (
      !ElizaSandboxService.ALLOWED_WORKFLOW_PATH_PATTERNS.some((re) => re.test(workflowPath))
    ) {
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
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for workflow proxy", { agentId });
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

      const headers: Record<string, string> = { Accept: "application/json" };
      if (method !== "GET" && method !== "DELETE") {
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
      if ((method === "POST" || method === "PUT") && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
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
    if (!rec?.bridge_url) {
      logger.warn("[agent-sandbox] Bridge stream to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);

    try {
      const conversationId = await this.createBridgeConversation(rec, params);
      const bridgeEndpoint = await this.getAgentApiEndpoint(
        rec,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      );
      const res = await fetch(bridgeEndpoint, {
        method: "POST",
        headers: this.getAgentJsonHeaders(rec),
        body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return res;
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
    return new Response(
      `data: ${JSON.stringify({ text })}\n\nevent: done\ndata: ${JSON.stringify({})}\n\n`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      },
    );
  }

  private createBridgeSseErrorResponse(message: string): Response {
    return new Response(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, {
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
        const heartbeatEndpoint = await this.getAgentApiEndpoint(rec, "/");
        return await fetch(heartbeatEndpoint, {
          method: "GET",
          headers: this.getAgentJsonHeaders(rec),
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

    const snapshotEndpoint = await this.getAgentApiEndpoint(rec, "/api/snapshot");
    const res = await fetch(snapshotEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
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
    options?: { trusted?: boolean },
  ) {
    const restoreEndpoint =
      typeof sandboxOrBridgeUrl === "string"
        ? await this.getSafeBridgeEndpoint(sandboxOrBridgeUrl, "/api/restore", options)
        : await this.getAgentApiEndpoint(sandboxOrBridgeUrl, "/api/restore");
    const res = await fetch(restoreEndpoint, {
      method: "POST",
      headers:
        typeof sandboxOrBridgeUrl === "string"
          ? { "Content-Type": "application/json" }
          : this.getAgentJsonHeaders(sandboxOrBridgeUrl),
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

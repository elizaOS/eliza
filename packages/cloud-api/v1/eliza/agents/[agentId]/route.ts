/**
 * /api/v1/eliza/agents/:agentId
 *
 * GET    — agent detail (with admin slice when caller is org admin).
 * PATCH  — { action: "shutdown" | "suspend" } lifecycle action.
 * DELETE — delete sandbox + cleanup linked character.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db/client";
import { userCharactersRepository } from "@/db/repositories/characters";
import { agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getPreferredElizaAgentWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { adminService } from "@/lib/services/admin";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { getStewardAgent } from "@/lib/services/steward-client";
import type {
  AgentAdminDetailsDto,
  AgentDetailDto,
  AgentResponse,
  AgentWalletStatus,
} from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const patchAgentSchema = z.object({
  action: z.enum(["shutdown", "suspend"]),
});

type Agent = NonNullable<
  Awaited<ReturnType<typeof elizaSandboxService.getAgent>>
>;

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}

function stringConfigValue(
  config: Agent["agent_config"],
  key: "tokenContractAddress" | "chain" | "tokenName" | "tokenTicker",
): string | null {
  const value = config?.[key];
  return typeof value === "string" ? value : null;
}

function toAdminDetailsDto(
  agent: Agent,
  isDockerAgent: boolean,
): AgentAdminDetailsDto {
  return {
    nodeId: agent.node_id,
    containerName: agent.container_name,
    headscaleIp: agent.headscale_ip,
    bridgePort: agent.bridge_port,
    webUiPort: agent.web_ui_port,
    dockerImage: agent.docker_image,
    isDockerBacked: isDockerAgent,
    webUiUrl: getPreferredElizaAgentWebUiUrl(agent),
    sshCommand: agent.headscale_ip ? `ssh root@${agent.headscale_ip}` : null,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await elizaSandboxService.getAgent(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    let tokenAddress: string | null = null;
    let tokenChain: string | null = null;
    let tokenName: string | null = null;
    let tokenTicker: string | null = null;

    if (agent.character_id) {
      const char = await userCharactersRepository.findByIdInOrganization(
        agent.character_id,
        user.organization_id,
      );
      if (char) {
        tokenAddress = char.token_address ?? null;
        tokenChain = char.token_chain ?? null;
        tokenName = char.token_name ?? null;
        tokenTicker = char.token_ticker ?? null;
      }
    }

    if (!tokenAddress) {
      tokenAddress = stringConfigValue(
        agent.agent_config,
        "tokenContractAddress",
      );
      tokenChain = stringConfigValue(agent.agent_config, "chain");
      tokenName = stringConfigValue(agent.agent_config, "tokenName");
      tokenTicker = stringConfigValue(agent.agent_config, "tokenTicker");
    }

    let walletAddress: string | null = null;
    let walletProvider: string | null = null;
    let walletStatus: AgentWalletStatus = "none";

    const isDockerAgent = !!agent.node_id;

    if (isDockerAgent) {
      try {
        const stewardAgent = await getStewardAgent(agentId, {
          organizationId: user.organization_id,
        });
        if (stewardAgent?.walletAddress) {
          walletAddress = stewardAgent.walletAddress;
          walletProvider = "steward";
          walletStatus = "active";
        } else if (stewardAgent) {
          walletProvider = "steward";
          walletStatus = "pending";
        }
      } catch (err) {
        logger.warn(`[agent-api] Steward wallet lookup failed for ${agentId}`, {
          err,
        });
      }
    }

    if (!walletAddress && agent.character_id) {
      const walletRecord = await db.query.agentServerWallets.findFirst({
        where: eq(agentServerWallets.character_id, agent.character_id),
      });
      if (walletRecord) {
        walletAddress = walletRecord.address;
        walletProvider = "steward";
        walletStatus = "active";
      }
    }

    const { isAdmin } = await adminService.getAdminStatusForUser(user);

    const adminDetails = isAdmin
      ? toAdminDetailsDto(agent, isDockerAgent)
      : null;

    const data: AgentDetailDto = {
      id: agent.id,
      agentName: agent.agent_name,
      status: agent.status,
      databaseStatus: agent.database_status,
      bridgeUrl: agent.bridge_url,
      lastBackupAt: toIsoStringOrNull(agent.last_backup_at),
      lastHeartbeatAt: toIsoStringOrNull(agent.last_heartbeat_at),
      errorMessage: agent.error_message,
      errorCount: agent.error_count,
      createdAt: toIsoString(agent.created_at),
      updatedAt: toIsoString(agent.updated_at),
      token_address: tokenAddress,
      token_chain: tokenChain,
      token_name: tokenName,
      token_ticker: tokenTicker,
      walletAddress,
      walletProvider,
      walletStatus,
      adminDetails,
    };

    const response: AgentResponse = {
      success: true,
      data,
    };

    return c.json(response);
  } catch (error) {
    logger.error("[agent-api] GET /agents/:agentId error", { error });
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => null);

    const parsed = patchAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    if (agent.status === "stopped") {
      return c.json({
        success: true,
        data: {
          agentId,
          action: parsed.data.action,
          message:
            parsed.data.action === "shutdown"
              ? "Agent is already stopped"
              : "Agent is already suspended",
          previousStatus: agent.status,
        },
      });
    }

    // Enqueue `agent_suspend` job — the orchestrator does the docker stop
    // via SSH and flips the DB. Workers can't SSH the cores; the previous
    // inline `shutdown()` path silently failed to stop the container and
    // left a stale DB row claiming `stopped` while the container kept
    // running. See suspend/route.ts for the same refactor.
    if (agent.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentSuspendOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // Logged inside the service.
    });

    logger.info(
      `[agent-api] Agent ${parsed.data.action} enqueued (suspend job)`,
      {
        agentId,
        orgId: user.organization_id,
        jobId: enqueueResult.job.id,
        created: enqueueResult.created,
      },
    );

    return c.json(
      {
        success: true,
        created: enqueueResult.created,
        alreadyInProgress: !enqueueResult.created,
        data: {
          agentId,
          action: parsed.data.action,
          jobId: enqueueResult.job.id,
          status: enqueueResult.job.status,
          message: enqueueResult.created
            ? `${parsed.data.action} job created. Poll the job endpoint for status.`
            : `${parsed.data.action} is already in progress.`,
          previousStatus: agent.status,
        },
      },
      202,
    );
  } catch (error) {
    logger.error("[agent-api] PATCH /agents/:agentId error", { error });
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const existing = await elizaSandboxService.getAgent(
      agentId,
      user.organization_id,
    );
    if (!existing) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    if (existing.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    // Async delete via the same job-queue path agent_provision uses. This
    // moves the SSH stop, Neon cleanup, and per-agent key revoke off the
    // request thread so a slow / unreachable Hetzner core can no longer
    // make the API hang or silently return 200 while the container lives
    // on. Idempotent: a second DELETE while a job is in flight reuses
    // the existing one.
    const enqueueResult = await provisioningJobService.enqueueAgentDeleteOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
    });

    // Best-effort wake of the worker so the user does not wait for the
    // next cron tick. Same pattern as the provision path.
    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // Logged inside the service; nothing actionable here.
    });

    logger.info("[agent-api] Agent delete enqueued", {
      agentId,
      orgId: user.organization_id,
      jobId: enqueueResult.job.id,
      created: enqueueResult.created,
    });

    return c.json(
      {
        success: true,
        created: enqueueResult.created,
        alreadyInProgress: !enqueueResult.created,
        message: enqueueResult.created
          ? "Delete job created. Poll the job endpoint for status."
          : "Delete is already in progress.",
        data: {
          jobId: enqueueResult.job.id,
          agentId,
          status: enqueueResult.job.status,
        },
        polling: {
          endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
          intervalMs: 5_000,
          expectedDurationMs: 30_000,
        },
      },
      202,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Agent not found") {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }
    logger.error("[agent-api] DELETE /agents/:agentId error", { error });
    return failureResponse(c, error);
  }
});

export default app;

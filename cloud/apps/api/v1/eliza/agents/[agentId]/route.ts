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
import { reusesExistingElizaCharacter } from "@/lib/services/eliza-agent-config";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { getStewardAgent } from "@/lib/services/steward-client";
import type {
  AgentAdminDetailsDto,
  AgentDetailDto,
  AgentResponse,
  AgentWalletStatus,
} from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const patchAgentSchema = z.object({
  action: z.enum(["shutdown", "suspend"]),
});

type Agent = NonNullable<Awaited<ReturnType<typeof elizaSandboxService.getAgent>>>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function toAdminDetailsDto(agent: Agent, isDockerAgent: boolean): AgentAdminDetailsDto {
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

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readControlPlaneEnv(c: AppContext, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function deleteDockerBackedAgentViaControlPlane(
  c: AppContext,
  user: { id: string; organization_id: string },
  agentId: string,
): Promise<Response | null> {
  const baseUrl = readControlPlaneEnv(c, CONTROL_PLANE_URL_KEYS);
  if (!baseUrl) return null;

  const target = new URL(baseUrl);
  target.pathname = `/api/compat/agents/${encodeURIComponent(agentId)}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  const internalToken = readControlPlaneEnv(c, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);
  headers.set("x-eliza-user-id", user.id);
  headers.set("x-eliza-organization-id", user.organization_id);

  const upstream = await fetch(target, {
    headers,
    method: "DELETE",
    redirect: "manual",
  });
  const upstreamBody = await upstream.json().catch(() => null);

  if (upstream.ok) {
    return Response.json(
      {
        success: true,
        data: {
          agentId,
          message: "Agent delete complete",
        },
      },
      { status: upstream.status, statusText: upstream.statusText },
    );
  }

  const error =
    typeof upstreamBody?.error === "string"
      ? upstreamBody.error
      : typeof upstreamBody?.message === "string"
        ? upstreamBody.message
        : "Agent delete failed";

  return Response.json(
    { success: false, error },
    { status: upstream.status, statusText: upstream.statusText },
  );
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await elizaSandboxService.getAgent(agentId, user.organization_id);
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
      tokenAddress = stringConfigValue(agent.agent_config, "tokenContractAddress");
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
        logger.warn(`[agent-api] Steward wallet lookup failed for ${agentId}`, { err });
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

    const isAdmin = user.wallet_address ? await adminService.isAdmin(user.wallet_address) : false;

    const adminDetails = isAdmin ? toAdminDetailsDto(agent, isDockerAgent) : null;

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

    const agent = await elizaSandboxService.getAgentForWrite(agentId, user.organization_id);
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

    const result = await elizaSandboxService.shutdown(agentId, user.organization_id);
    if (!result.success) {
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "Agent provisioning is in progress"
            ? 409
            : 400;
      return c.json(
        {
          success: false,
          error: result.error ?? `${parsed.data.action} failed`,
        },
        status,
      );
    }

    logger.info(`[agent-api] Agent ${parsed.data.action} complete`, {
      agentId,
      orgId: user.organization_id,
    });

    return c.json({
      success: true,
      data: {
        agentId,
        action: parsed.data.action,
        message:
          parsed.data.action === "shutdown"
            ? "Agent shutdown complete"
            : "Agent suspended with snapshot. Use resume or provision to restart.",
        previousStatus: agent.status,
      },
    });
  } catch (error) {
    logger.error("[agent-api] PATCH /agents/:agentId error", { error });
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const existing = await elizaSandboxService.getAgent(agentId, user.organization_id);
    if (!existing) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    if (existing.node_id && existing.sandbox_id) {
      const forwarded = await deleteDockerBackedAgentViaControlPlane(c, user, agentId);
      if (forwarded) return forwarded;
    }

    const deleted = await elizaSandboxService.deleteAgent(agentId, user.organization_id);
    if (!deleted.success) {
      const status =
        deleted.error === "Agent not found"
          ? 404
          : deleted.error === "Agent provisioning is in progress"
            ? 409
            : 500;
      return c.json({ success: false, error: deleted.error }, status);
    }

    const characterId = deleted.deletedSandbox.character_id;
    const reusesExistingCharacter = reusesExistingElizaCharacter(
      deleted.deletedSandbox.agent_config,
    );

    if (characterId && !reusesExistingCharacter) {
      try {
        await userCharactersRepository.delete(characterId);
        logger.info("[agent-api] Cleaned up linked character after delete", {
          agentId,
          characterId,
        });
      } catch (characterErr) {
        logger.warn("[agent-api] Failed to clean up linked character after delete", {
          agentId,
          characterId,
          error: characterErr instanceof Error ? characterErr.message : String(characterErr),
        });
      }
    }

    logger.info("[agent-api] Agent deleted", {
      agentId,
      orgId: user.organization_id,
    });

    return c.json({ success: true });
  } catch (error) {
    logger.error("[agent-api] DELETE /agents/:agentId error", { error });
    return failureResponse(c, error);
  }
});

export default app;

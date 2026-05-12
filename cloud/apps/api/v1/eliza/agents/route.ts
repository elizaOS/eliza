/**
 * /api/v1/eliza/agents
 *
 * GET  — list all Agent cloud agents for the caller's organization.
 * POST — create a new Agent cloud agent (gated on a minimum credit balance).
 */

import { Hono } from "hono";
import { z } from "zod";
import { userCharactersRepository } from "@/db/repositories/characters";
import {
  ApiError,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import {
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "@/lib/services/eliza-agent-config";
import { prepareManagedElizaEnvironment } from "@/lib/services/eliza-managed-launch";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AgentListItemDto, AgentsResponse } from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const createAgentSchema = z.object({
  agentName: z.string().min(1).max(100),
  characterId: z.string().uuid().optional(),
  agentConfig: z.record(z.string(), z.unknown()).optional(),
  environmentVars: z.record(z.string(), z.string()).optional(),
});

type Agent = Awaited<ReturnType<typeof elizaSandboxService.listAgents>>[number];
type UserCharacter = Awaited<
  ReturnType<typeof userCharactersRepository.findByIdsInOrganization>
>[number];

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

function toAgentListItemDto(
  agent: Agent,
  character: UserCharacter | undefined,
): AgentListItemDto {
  return {
    id: agent.id,
    agentName: agent.agent_name,
    status: agent.status,
    databaseStatus: agent.database_status,
    lastBackupAt: toIsoStringOrNull(agent.last_backup_at),
    lastHeartbeatAt: toIsoStringOrNull(agent.last_heartbeat_at),
    errorMessage: agent.error_message,
    createdAt: toIsoString(agent.created_at),
    updatedAt: toIsoString(agent.updated_at),
    token_address:
      character?.token_address ??
      stringConfigValue(agent.agent_config, "tokenContractAddress"),
    token_chain:
      character?.token_chain ?? stringConfigValue(agent.agent_config, "chain"),
    token_name:
      character?.token_name ??
      stringConfigValue(agent.agent_config, "tokenName"),
    token_ticker:
      character?.token_ticker ??
      stringConfigValue(agent.agent_config, "tokenTicker"),
  };
}

app.get("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  const agents = await elizaSandboxService.listAgents(user.organization_id);

  const characterIds = Array.from(
    new Set(
      agents
        .map((a) => a.character_id)
        .filter((id): id is string => id != null),
    ),
  );
  const characters =
    characterIds.length > 0
      ? await userCharactersRepository.findByIdsInOrganization(
          characterIds,
          user.organization_id,
        )
      : [];
  const charMap = new Map(characters.map((ch) => [ch.id, ch]));

  const response: AgentsResponse = {
    success: true,
    data: agents.map((agent) =>
      toAgentListItemDto(
        agent,
        agent.character_id ? charMap.get(agent.character_id) : undefined,
      ),
    ),
  };

  return c.json(response);
});

app.post("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  const body = await c.req.json().catch(() => {
    throw ValidationError("Invalid JSON");
  });

  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    throw ValidationError("Invalid request data", {
      issues: parsed.error.issues,
    });
  }

  const creditCheck = await checkAgentCreditGate(user.organization_id);
  if (!creditCheck.allowed) {
    logger.warn("[agent-api] Agent creation blocked: insufficient credits", {
      orgId: user.organization_id,
      balance: creditCheck.balance,
      required: AGENT_PRICING.MINIMUM_DEPOSIT,
    });
    throw new ApiError(
      402,
      "insufficient_credits",
      creditCheck.error ?? "Insufficient credits",
      {
        requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
        currentBalance: creditCheck.balance,
      },
    );
  }

  if (parsed.data.characterId) {
    const character =
      await userCharactersRepository.findByIdInOrganizationForWrite(
        parsed.data.characterId,
        user.organization_id,
      );

    if (!character) throw NotFoundError("Character not found");
  }

  const sanitizedConfig = stripReservedElizaConfigKeys(parsed.data.agentConfig);

  const agent = await elizaSandboxService.createAgent({
    organizationId: user.organization_id,
    userId: user.id,
    agentName: parsed.data.agentName,
    characterId: parsed.data.characterId,
    agentConfig: parsed.data.characterId
      ? withReusedElizaCharacterOwnership(sanitizedConfig)
      : sanitizedConfig,
    environmentVars: parsed.data.environmentVars ?? {},
  });

  const managedEnvironment = await prepareManagedElizaEnvironment({
    existingEnv: parsed.data.environmentVars,
    organizationId: user.organization_id,
    userId: user.id,
    agentSandboxId: agent.id,
  });

  if (managedEnvironment.changed) {
    await elizaSandboxService.updateAgentEnvironment(
      agent.id,
      user.organization_id,
      managedEnvironment.environmentVars,
    );
  }

  logger.info("[agent-api] Agent created", {
    agentId: agent.id,
    orgId: user.organization_id,
  });

  return c.json(
    {
      success: true,
      data: {
        id: agent.id,
        agentName: agent.agent_name,
        status: agent.status,
        createdAt: agent.created_at,
      },
    },
    201,
  );
});

export default app;

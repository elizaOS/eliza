/**
 * /api/v1/eliza/agents
 *
 * GET  — list all Agent cloud agents for the caller's organization.
 * POST — create a new Agent cloud agent (gated on a minimum credit balance).
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import {
  ApiError,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import {
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "@/lib/services/eliza-agent-config";
import { prepareManagedElizaEnvironment } from "@/lib/services/eliza-managed-launch";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import type { AgentListItemDto, AgentsResponse } from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const dockerImageSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._/:@-]+$/, "Invalid Docker image reference");

const createAgentSchema = z.object({
  agentName: z.string().min(1).max(100),
  characterId: z.string().uuid().optional(),
  agentConfig: z.record(z.string(), z.unknown()).optional(),
  environmentVars: z.record(z.string(), z.string()).optional(),
  dockerImage: dockerImageSchema.optional(),
  // Provisioning is started automatically by default so a single round-trip
  // returns a running session (warm pool) or a provisioning job to poll.
  // S2S callers that want to create the record without spending can opt out
  // with `autoProvision: false` (or the `?autoProvision=false` query param).
  autoProvision: z.boolean().optional(),
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
    dockerImage: agent.docker_image,
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

  // Auto-provision is the default: a single POST returns a running session
  // (warm pool) or a provisioning job to poll, eliminating the mandatory
  // second /provision call and the orphaned-pending-agent failure mode.
  // Opt out via `?autoProvision=false` or `autoProvision: false` in the body.
  const autoProvision =
    c.req.query("autoProvision") !== "false" &&
    parsed.data.autoProvision !== false;

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

  // Worker-health pre-check happens BEFORE createAgent so that, when the
  // provisioning worker is down, we never create an agent row that can't be
  // provisioned (no orphaned pending agent, nothing to roll back). Skipped
  // when the caller opted out of auto-provisioning.
  if (autoProvision) {
    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn("[agent-api] Agent creation blocked: worker unavailable", {
        orgId: user.organization_id,
        code: workerHealth.code,
      });
      return c.json(
        provisioningWorkerFailureBody(workerHealth),
        workerHealth.status,
      );
    }
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
    dockerImage: parsed.data.dockerImage,
    agentConfig: parsed.data.characterId
      ? withReusedElizaCharacterOwnership(sanitizedConfig)
      : sanitizedConfig,
    environmentVars: parsed.data.environmentVars,
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
    autoProvision,
  });

  // Opt-out path: create the record only (legacy two-step flow). The caller
  // is responsible for a follow-up POST /eliza/agents/:id/provision.
  if (!autoProvision) {
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
  }

  // ── Warm pool fast path ─────────────────────────────────────────────────
  // Atomically claim a pre-warmed container; on success the agent is already
  // running and we return its connection info in the same round-trip.
  if (containersEnv.warmPoolEnabled()) {
    try {
      const claimed = await agentSandboxesRepository.claimWarmContainer({
        userAgentId: agent.id,
        organizationId: user.organization_id,
        image: containersEnv.defaultAgentImage(),
        agentName: agent.agent_name ?? agent.id,
        agentConfig:
          (agent.agent_config as Record<string, unknown> | undefined) ??
          undefined,
        characterId: agent.character_id,
      });
      if (claimed) {
        logger.info("[agent-api] Warm pool claim succeeded on create", {
          agentId: agent.id,
          orgId: user.organization_id,
          poolNodeId: claimed.node_id,
        });
        return c.json(
          {
            success: true,
            source: "warm_pool",
            data: {
              id: claimed.id,
              agentName: claimed.agent_name,
              status: claimed.status,
              bridgeUrl: claimed.bridge_url,
              healthUrl: claimed.health_url,
            },
          },
          201,
        );
      }
    } catch (err) {
      // Don't block on claim errors — fall through to the async job path.
      logger.warn("[agent-api] Warm pool claim threw on create; falling back", {
        agentId: agent.id,
        orgId: user.organization_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Async path (default) ────────────────────────────────────────────────
  // `expectedUpdatedAt` is intentionally omitted: the row was just created
  // (and possibly touched by the managed-env update above), so there is no
  // concurrent handle to guard against — passing the stale create timestamp
  // would spuriously trip the race check after a managed-env write.
  let job: Awaited<ReturnType<typeof provisioningJobService.enqueueAgentProvision>>;
  try {
    job = await provisioningJobService.enqueueAgentProvision({
      agentId: agent.id,
      organizationId: user.organization_id,
      userId: user.id,
      agentName: agent.agent_name ?? agent.id,
    });
  } catch (enqueueErr) {
    // Roll back the just-created agent so a failed enqueue doesn't leave an
    // unprovisionable row behind (mirrors the orphaned-record cleanup the
    // S2S /api/v1/agents route does for its character).
    try {
      await agentSandboxesRepository.delete(agent.id, user.organization_id);
      logger.info("[agent-api] Cleaned up agent after enqueue failure", {
        agentId: agent.id,
        orgId: user.organization_id,
      });
    } catch (cleanupErr) {
      logger.error("[agent-api] Failed to clean up agent after enqueue failure", {
        agentId: agent.id,
        orgId: user.organization_id,
        error:
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw enqueueErr;
  }

  // Inline trigger: kick the worker now instead of waiting up to a minute for
  // the next cron tick. Fire-and-forget; the cron is the safety net.
  void provisioningJobService.triggerImmediate(c.env).catch(() => {
    // Logged inside the service.
  });

  logger.info("[agent-api] Agent provisioning job enqueued on create", {
    agentId: agent.id,
    orgId: user.organization_id,
    jobId: job.id,
  });

  return c.json(
    {
      success: true,
      created: true,
      message:
        "Agent created. Provisioning job started — poll the job endpoint for status.",
      data: {
        agentId: agent.id,
        agentName: agent.agent_name,
        status: job.status,
        jobId: job.id,
        estimatedCompletionAt: job.estimated_completion_at,
      },
      polling: {
        endpoint: `/api/v1/jobs/${job.id}`,
        intervalMs: 5000,
        expectedDurationMs: 90000,
      },
    },
    202,
  );
});

export default app;

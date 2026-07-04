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
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { getElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "@/lib/services/eliza-agent-config";
import { prepareManagedElizaEnvironment } from "@/lib/services/eliza-managed-launch";
import {
  AgentImageNotAllowedError,
  AgentQuotaExceededError,
  elizaSandboxService,
} from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import {
  getAgentTier,
  tierProvisionsEagerly,
} from "@/lib/services/shared-runtime/agent-tier";
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
  alwaysOn: z.boolean().optional(),
  statefulRuntime: z.boolean().optional(),
  modelTooLargeForShared: z.boolean().optional(),
  // Provisioning is started automatically by default so a single round-trip
  // returns a running session (warm pool) or a provisioning job to poll.
  // S2S callers that want to create the record without spending can opt out
  // with `autoProvision: false` (or the `?autoProvision=false` query param).
  autoProvision: z.boolean().optional(),
  // Bypass the org-scoped reuse guard and ALWAYS mint a fresh agent. Default
  // (absent/false) keeps `reuseExistingNonTerminal: true` so every existing
  // caller still reuses an org's live agent. The seamless shared→dedicated
  // handoff sets this so the 2nd create (the DEDICATED migration target) is a
  // SEPARATE record from the shared bridge it's handing off from — otherwise
  // the reuse guard hands back the shared agent and the handoff probe polls a
  // base that never grows a dedicated container (it times out, no switch).
  forceCreate: z.boolean().optional(),
});

type Agent = Awaited<ReturnType<typeof elizaSandboxService.listAgents>>[number];
type UserCharacter = Awaited<
  ReturnType<typeof userCharactersRepository.findByIdsInOrganization>
>[number];
type CreateAgentBody = z.infer<typeof createAgentSchema>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanConfigValue(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return config?.[key] === true;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function nestedCharacterConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return isRecord(config?.character) ? config.character : undefined;
}

function deriveAgentPlugins(
  config: Record<string, unknown> | undefined,
  character: UserCharacter | undefined,
): string[] {
  const characterConfig = nestedCharacterConfig(config);
  return Array.from(
    new Set([
      ...stringArrayValue(config?.plugins),
      ...stringArrayValue(characterConfig?.plugins),
      ...(character?.plugins ?? []),
    ]),
  );
}

function deriveAlwaysOn(
  data: CreateAgentBody,
  config: Record<string, unknown> | undefined,
): boolean {
  const characterConfig = nestedCharacterConfig(config);
  return (
    data.alwaysOn === true ||
    booleanConfigValue(config, "alwaysOn") ||
    booleanConfigValue(config, "always_on") ||
    booleanConfigValue(characterConfig, "alwaysOn") ||
    booleanConfigValue(characterConfig, "always_on")
  );
}

function deriveStatefulRuntime(
  data: CreateAgentBody,
  config: Record<string, unknown> | undefined,
): boolean {
  const characterConfig = nestedCharacterConfig(config);
  return (
    data.statefulRuntime === true ||
    booleanConfigValue(config, "statefulRuntime") ||
    booleanConfigValue(config, "stateful_runtime") ||
    booleanConfigValue(characterConfig, "statefulRuntime") ||
    booleanConfigValue(characterConfig, "stateful_runtime")
  );
}

function deriveModelTooLargeForShared(
  data: CreateAgentBody,
  config: Record<string, unknown> | undefined,
): boolean {
  const characterConfig = nestedCharacterConfig(config);
  return (
    data.modelTooLargeForShared === true ||
    booleanConfigValue(config, "modelTooLargeForShared") ||
    booleanConfigValue(config, "model_too_large_for_shared") ||
    booleanConfigValue(characterConfig, "modelTooLargeForShared") ||
    booleanConfigValue(characterConfig, "model_too_large_for_shared")
  );
}

function resolvePublicWebUiUrl(agent: Agent): string | null {
  if (agent.execution_tier === "shared") return null;
  const baseDomain = containersEnv.publicBaseDomain();
  return getElizaAgentPublicWebUiUrl(agent, baseDomain ? { baseDomain } : {});
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
    executionTier: agent.execution_tier,
    webUiUrl: resolvePublicWebUiUrl(agent),
  };
}

/**
 * Run the create→enqueue span and delete the just-created sandbox if ANY step
 * throws. `createAgent` commits a `pending` row up front, but the daemon only
 * provisions rows that have a matching `agent_provision` job — so an error
 * before the enqueue (e.g. KMS key mint in prepareManagedElizaEnvironment, or
 * the env/job DB writes) would otherwise leave a `pending` row no worker can
 * ever claim. We roll the row back and rethrow so the caller still sees the
 * failure. Cleanup is best-effort; the cleanup-stuck-provisioning cron is the
 * safety net for rows that slip through.
 */
async function withOrphanCleanup<T>(
  agentSandboxId: string,
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    try {
      await agentSandboxesRepository.delete(agentSandboxId, organizationId);
      logger.info("[agent-api] Cleaned up agent after create→enqueue failure", {
        agentId: agentSandboxId,
        orgId: organizationId,
      });
    } catch (cleanupErr) {
      logger.error(
        "[agent-api] Failed to clean up agent after create→enqueue failure",
        {
          agentId: agentSandboxId,
          orgId: organizationId,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        },
      );
    }
    throw err;
  }
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

  const autoProvision =
    c.req.query("autoProvision") !== "false" &&
    parsed.data.autoProvision !== false;

  const sanitizedConfig = stripReservedElizaConfigKeys(parsed.data.agentConfig);
  let linkedCharacter: UserCharacter | undefined;
  if (parsed.data.characterId) {
    linkedCharacter =
      await userCharactersRepository.findByIdInOrganizationForWrite(
        parsed.data.characterId,
        user.organization_id,
      );

    if (!linkedCharacter) throw NotFoundError("Character not found");
  }

  const executionTier = getAgentTier({
    dockerImage: parsed.data.dockerImage,
    plugins: deriveAgentPlugins(sanitizedConfig, linkedCharacter),
    alwaysOn: deriveAlwaysOn(parsed.data, sanitizedConfig),
    statefulRuntime: deriveStatefulRuntime(parsed.data, sanitizedConfig),
    modelTooLargeForShared: deriveModelTooLargeForShared(
      parsed.data,
      sanitizedConfig,
    ),
  });
  // `forceCreate` bypasses the org-scoped reuse guard, and shared agents never
  // reach the credit gate below (only eager/dedicated tiers do). The only
  // legitimate `forceCreate` caller — the shared→dedicated handoff — always
  // targets a dedicated (`alwaysOn`) agent, so a `forceCreate` shared create has
  // no valid use and would let any authenticated caller mint unmetered shared
  // rows past the reuse ceiling. Reject that combination explicitly.
  if (parsed.data.forceCreate && executionTier === "shared") {
    throw ValidationError(
      "forceCreate is only valid for dedicated agents (the handoff migration target); a shared agent never needs to bypass the reuse guard",
    );
  }

  const shouldProvisionEagerly =
    autoProvision && tierProvisionsEagerly(executionTier);

  // Captured from the credit gate below so the per-org agent quota (#11023)
  // can scale the org's agent ceiling by its balance tier. Stays undefined on
  // the non-eager (shared-tier) path — no credit gate runs there — so those
  // creates get the smallest-tier ceiling.
  let orgBalanceForQuota: number | undefined;

  if (shouldProvisionEagerly) {
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    orgBalanceForQuota = creditCheck.balance;
    if (!creditCheck.allowed) {
      return c.json(
        insufficientCredits402(
          creditCheck,
          "[agent-api] Agent creation blocked: insufficient credits",
          { orgId: user.organization_id },
        ),
        402,
      );
    }

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

  let created: Awaited<ReturnType<typeof elizaSandboxService.createAgent>>;
  try {
    created = await elizaSandboxService.createAgent({
      organizationId: user.organization_id,
      userId: user.id,
      agentName: parsed.data.agentName,
      characterId: parsed.data.characterId,
      dockerImage: parsed.data.dockerImage,
      agentConfig: parsed.data.characterId
        ? withReusedElizaCharacterOwnership(sanitizedConfig)
        : sanitizedConfig,
      environmentVars: parsed.data.environmentVars,
      executionTier,
      // Default reuses the org's existing non-terminal agent (idempotent create);
      // `forceCreate` opts out so a caller that needs a SEPARATE record (the
      // shared→dedicated handoff's migration target) mints a fresh agent instead
      // of getting the shared one handed back.
      reuseExistingNonTerminal: !parsed.data.forceCreate,
      // EVERY user-facing create is bounded by the org's balance-tiered agent
      // ceiling — enforced atomically under the advisory lock (#11023).
      // forceCreate needs it because it bypasses the reuse guard; the normal
      // path needs it because suspended (`stopped`) / slept (`sleeping`)
      // agents keep their per-tenant managed DB but are not LIVE, so after a
      // suspend the reuse guard has nothing to hand back and would otherwise
      // mint a fresh uncapped row on every create (the create→suspend→create
      // loop). Trusted internal multi-agent callers don't go through this
      // route and stay uncapped.
      maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(orgBalanceForQuota),
    });
  } catch (error) {
    if (error instanceof AgentQuotaExceededError) {
      logger.warn(
        "[agent-api] Agent creation blocked: per-org quota exceeded",
        {
          orgId: user.organization_id,
          count: error.count,
          max: error.max,
        },
      );
      throw new ApiError(429, "agent_quota_exceeded", error.message, {
        currentAgents: error.count,
        maxAgents: error.max,
      });
    }
    if (error instanceof AgentImageNotAllowedError) {
      logger.warn("[agent-api] Agent creation blocked: image not allowed", {
        orgId: user.organization_id,
        image: error.image,
        reason: error.reason,
      });
      throw new ApiError(
        403,
        error.reason === "not_digest_pinned"
          ? "agent_image_not_digest_pinned"
          : "agent_image_not_allowed",
        error.message,
      );
    }
    throw error;
  }
  const { agent, idempotent } = created;

  // Idempotent reuse: the org already had a non-terminal agent, so createAgent
  // returned it instead of minting a duplicate. It is already provisioned (or
  // its provision job is in flight) — do NOT enqueue a second job, do NOT run
  // the orphan-deletion wrapper because that would tear down a live agent, and return
  // 200 (reuse) rather than the fresh-create 201/202.
  if (idempotent) {
    logger.info("[agent-api] Reusing existing non-terminal agent", {
      agentId: agent.id,
      orgId: user.organization_id,
      status: agent.status,
    });
    return c.json(
      {
        success: true,
        created: false,
        data: {
          id: agent.id,
          agentId: agent.id,
          agentName: agent.agent_name,
          status: agent.status,
          createdAt: agent.created_at,
          executionTier: agent.execution_tier,
        },
      },
      200,
    );
  }

  // Atomicity guard: createAgent already committed a pending row — any throw before the job is enqueued must roll it back (see withOrphanCleanup).
  return await withOrphanCleanup(agent.id, user.organization_id, async () => {
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
      executionTier,
    });

    if (executionTier === "shared") {
      return c.json(
        {
          success: true,
          created: true,
          source: "shared_runtime",
          data: {
            id: agent.id,
            agentId: agent.id,
            agentName: agent.agent_name,
            status: agent.status,
            createdAt: agent.created_at,
            executionTier: agent.execution_tier,
            // A shared agent has no agent server of its own; its reachable REST
            // base is the cloud-api adapter (`.../agents/:id/api/*`). Return the
            // agent root as webUiUrl so the chat client appends `/api/...` to it.
            webUiUrl: `${new URL(c.req.url).origin}/api/v1/eliza/agents/${agent.id}`,
          },
        },
        201,
      );
    }

    if (!shouldProvisionEagerly) {
      return c.json(
        {
          success: true,
          created: true,
          data: {
            id: agent.id,
            agentId: agent.id,
            agentName: agent.agent_name,
            status: agent.status,
            createdAt: agent.created_at,
            executionTier: agent.execution_tier,
          },
        },
        201,
      );
    }

    if (executionTier !== "custom" && containersEnv.warmPoolEnabled()) {
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
                executionTier: claimed.execution_tier,
              },
            },
            201,
          );
        }
      } catch (err) {
        // Don't block on claim errors — fall through to the async job path.
        // Emit a stable `event` so a persistently broken warm pool is
        // observable in aggregate (otherwise every claim silently degrades to
        // the slow async path with no signal that the fast path is dead).
        logger.warn(
          "[agent-api] Warm pool claim threw on create; falling back",
          {
            event: "warm_pool.claim_failed",
            agentId: agent.id,
            orgId: user.organization_id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    // ── Async path (default) ──────────────────────────────────────────────
    // `expectedUpdatedAt` is intentionally omitted: the row was just created
    // (and possibly touched by the managed-env update above), so there is no
    // concurrent handle to guard against — passing the stale create timestamp
    // would spuriously trip the race check after a managed-env write.
    const job = await provisioningJobService.enqueueAgentProvision({
      agentId: agent.id,
      organizationId: user.organization_id,
      userId: user.id,
      agentName: agent.agent_name ?? agent.id,
    });

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
          // `id` keeps parity with every other create branch (shared,
          // non-eager, warm-pool) so clients can always read `data.id`. The
          // async-provisioning branch previously returned only `agentId`,
          // which crashed the onboarding client with "missing data.id".
          id: agent.id,
          agentId: agent.id,
          agentName: agent.agent_name,
          status: job.status,
          jobId: job.id,
          estimatedCompletionAt: job.estimated_completion_at,
          executionTier: agent.execution_tier,
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
});

export default app;

/**
 * POST /api/v1/agents
 *
 * Service-to-service endpoint for waifu.fun to provision an Agent cloud agent.
 * Auth: X-Service-Key header.
 *
 * Default (async): create the agent record + enqueue a provisioning job.
 *   Returns 202 with `{ cloudAgentId, jobId, polling }`.
 *
 * `?sync=true` falls back to the legacy blocking behaviour and returns 201.
 */

import { Hono } from "hono";
import { z } from "zod";
import { userCharactersRepository } from "@/db/repositories/characters";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { charactersService } from "@/lib/services/characters/characters";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { isUniqueConstraintError } from "@/lib/utils/db-errors";
import { logger } from "@/lib/utils/logger";
import { normalizeTokenAddress } from "@/lib/utils/token-address";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const provisionSchema = z.object({
  tokenContractAddress: z.string().min(1).max(256),
  chain: z.string().min(1).max(50),
  chainId: z.number().int().positive(),
  tokenName: z.string().min(1).max(200),
  tokenTicker: z.string().min(1).max(30),
  launchType: z.enum(["native", "imported"]),
  character: z
    .object({
      name: z.string().min(1).max(200),
      bio: z.string().max(5000).optional(),
      avatar: z.string().url().max(2048).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      system: z.string().max(20000).optional(),
      plugins: z.array(z.string().min(1).max(200)).max(50).optional(),
    })
    .optional(),
  billing: z
    .object({
      mode: z.enum(["owner_credits", "waifu_treasury_subsidy", "hybrid"]),
      initialReserveUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  webhookUrl: z.string().url().max(2048).optional(),
});

// The wallet/trading plugin: gives the agent its Steward-backed wallet +
// trade actions (uses STEWARD_AGENT_ID / STEWARD_API_URL env injected at
// provision). Gated behind WAIFU_DEFAULT_WALLET_PLUGIN so we don't break
// agent boot on images that don't bundle the plugin yet; enable once the
// agent image ships @elizaos/plugin-steward-app. The system prompt below is
// applied unconditionally (it can't break boot).
function getDefaultAgentPlugins(): string[] {
  const enabled = getCloudAwareEnv().WAIFU_DEFAULT_WALLET_PLUGIN === "true";
  return enabled ? ["@elizaos/plugin-steward-app"] : [];
}

// Build a real system prompt from the token context so a freshly provisioned
// agent knows who it is, what token it represents, and what it can do — instead
// of booting as a contextless default character.
function buildDefaultSystemPrompt(p: {
  tokenName: string;
  tokenTicker: string;
  tokenContractAddress: string;
  chain: string;
  characterName: string;
  bio?: string;
}): string {
  const lines = [
    `You are ${p.characterName}, the autonomous AI agent for the ${p.tokenName} ($${p.tokenTicker}) token on ${p.chain}.`,
    `Your token contract address is ${p.tokenContractAddress} on ${p.chain}.`,
    p.bio ? `About you: ${p.bio}` : null,
    ``,
    `You have a crypto wallet provisioned through Steward (eliza.steward.fi) and can check balances, hold, and trade on behalf of your community when asked. When someone asks about your token, your wallet, or what you can do, answer concretely using your real token ($${p.tokenTicker}) and your wallet capabilities.`,
    `Be helpful, on-brand, and concise. Speak as ${p.characterName}. Never claim to be a generic assistant — you are ${p.characterName}, tied to $${p.tokenTicker}.`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);

    const body = await c.req.json().catch(() => null);
    if (!body) throw ValidationError("Invalid JSON body");

    const parsed = provisionSchema.safeParse(body);
    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        details: parsed.error.issues,
      });
    }

    const p = parsed.data;
    const sync = c.req.query("sync") === "true";
    const agentName = p.character?.name || p.tokenName;

    if (!sync) {
      const workerHealth = await checkProvisioningWorkerHealth();
      if (!workerHealth.ok) {
        logger.warn(
          "[service-api] Agent provisioning blocked: worker unavailable",
          {
            orgId: identity.organizationId,
            code: workerHealth.code,
          },
        );
        return c.json(
          provisioningWorkerFailureBody(workerHealth),
          workerHealth.status,
        );
      }
    }

    const normalizedTokenAddress = normalizeTokenAddress(
      p.tokenContractAddress,
      p.chain,
    );

    logger.info("[service-api] Provisioning agent", {
      token: normalizedTokenAddress,
      chain: p.chain,
      chainId: p.chainId,
      orgId: identity.organizationId,
      async: !sync,
    });

    const existingChar = await userCharactersRepository.findByTokenAddress(
      normalizedTokenAddress,
      p.chain,
    );
    if (existingChar) {
      return c.json(
        {
          error: `An agent is already linked to token ${p.tokenContractAddress} on ${p.chain}`,
          existingAgentId: existingChar.id,
        },
        409,
      );
    }

    let character: Awaited<ReturnType<typeof charactersService.create>>;
    try {
      // Always give the agent a real system prompt + the wallet plugin. Use
      // the caller's values when provided, otherwise synthesize from token
      // context so the agent is never a blank, contextless Eliza.
      const systemPrompt =
        p.character?.system?.trim() ||
        buildDefaultSystemPrompt({
          tokenName: p.tokenName,
          tokenTicker: p.tokenTicker,
          tokenContractAddress: normalizedTokenAddress,
          chain: p.chain,
          characterName: agentName,
          bio: p.character?.bio,
        });
      const plugins = Array.from(
        new Set([...(p.character?.plugins ?? []), ...getDefaultAgentPlugins()]),
      );

      character = await charactersService.create({
        name: agentName,
        bio: p.character?.bio
          ? [p.character.bio]
          : [`Agent for ${p.tokenName}`],
        system: systemPrompt,
        plugins,
        user_id: identity.userId,
        organization_id: identity.organizationId,
        source: "cloud",
        character_data: p.character?.config ?? {},
        avatar_url: p.character?.avatar ?? null,
        token_address: normalizedTokenAddress,
        token_chain: p.chain,
        token_name: p.tokenName,
        token_ticker: p.tokenTicker,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await userCharactersRepository.findByTokenAddress(
          normalizedTokenAddress,
          p.chain,
        );
        return c.json(
          {
            error: `An agent is already linked to token ${p.tokenContractAddress} on ${p.chain}`,
            ...(existing?.id ? { existingAgentId: existing.id } : {}),
          },
          409,
        );
      }
      throw error;
    }

    let agent: Awaited<ReturnType<typeof elizaSandboxService.createAgent>>;
    try {
      agent = await elizaSandboxService.createAgent({
        organizationId: identity.organizationId,
        userId: identity.userId,
        agentName,
        characterId: character.id,
        agentConfig: {
          tokenContractAddress: normalizedTokenAddress,
          chain: p.chain,
          chainId: p.chainId,
          tokenName: p.tokenName,
          tokenTicker: p.tokenTicker,
          launchType: p.launchType,
          character: p.character,
          billing: p.billing,
        },
        environmentVars: {
          TOKEN_CONTRACT_ADDRESS: normalizedTokenAddress,
          TOKEN_CHAIN: p.chain,
          TOKEN_CHAIN_ID: String(p.chainId),
          TOKEN_NAME: p.tokenName,
          TOKEN_TICKER: p.tokenTicker,
        },
      });
    } catch (createErr) {
      try {
        await charactersService.delete(character.id);
        logger.info(
          "[service-api] Cleaned up orphaned character after createAgent failure",
          {
            characterId: character.id,
          },
        );
      } catch (cleanupErr) {
        logger.error("[service-api] Failed to clean up orphaned character", {
          characterId: character.id,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        });
      }
      throw createErr;
    }

    if (sync) {
      const result = await elizaSandboxService.provision(
        agent.id,
        identity.organizationId,
      );
      if (!result.success) {
        logger.error("[service-api] Provision failed", {
          agentId: agent.id,
          error: result.error,
        });
        return c.json(
          {
            cloudAgentId: agent.id,
            status: result.sandboxRecord?.status ?? "error",
            error: result.error,
          },
          502,
        );
      }
      logger.info("[service-api] Agent provisioned (sync)", {
        agentId: agent.id,
        status: result.sandboxRecord.status,
      });
      return c.json(
        {
          cloudAgentId: agent.id,
          characterId: character.id,
          status: result.sandboxRecord.status,
          token_address: character.token_address ?? null,
          token_chain: character.token_chain ?? null,
          token_name: character.token_name ?? null,
          token_ticker: character.token_ticker ?? null,
        },
        201,
      );
    }

    let job: Awaited<
      ReturnType<typeof provisioningJobService.enqueueAgentProvision>
    >;
    try {
      job = await provisioningJobService.enqueueAgentProvision({
        agentId: agent.id,
        organizationId: identity.organizationId,
        userId: identity.userId,
        agentName,
        webhookUrl: p.webhookUrl,
      });
    } catch (enqueueErr) {
      try {
        await charactersService.delete(character.id);
        logger.info(
          "[service-api] Cleaned up orphaned character after enqueue failure",
          {
            characterId: character.id,
            agentId: agent.id,
          },
        );
      } catch (cleanupErr) {
        logger.error(
          "[service-api] Failed to clean up orphaned character after enqueue failure",
          {
            characterId: character.id,
            agentId: agent.id,
            error:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          },
        );
      }
      throw enqueueErr;
    }

    logger.info("[service-api] Agent provisioning job enqueued", {
      agentId: agent.id,
      jobId: job.id,
    });

    return c.json(
      {
        cloudAgentId: agent.id,
        characterId: character.id,
        status: "pending",
        jobId: job.id,
        polling: {
          endpoint: `/api/v1/jobs/${job.id}`,
          intervalMs: 5000,
          expectedDurationMs: 90000,
        },
        token_address: character.token_address ?? null,
        token_chain: character.token_chain ?? null,
        token_name: character.token_name ?? null,
        token_ticker: character.token_ticker ?? null,
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

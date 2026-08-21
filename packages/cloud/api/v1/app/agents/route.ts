/**
 * POST /api/v1/app/agents — create a new AI agent (character) for the
 * authenticated user. Enforces organization agent quotas and role.
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  charactersService,
  type MeteredCharacterCreationReceipt,
} from "@/lib/services/characters/characters";
import { isUniqueConstraintError } from "@/lib/utils/db-errors";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import { normalizeTokenAddress } from "@/lib/utils/token-address";
import type { AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_AGENT_BIO = "A helpful AI assistant";

const CreateAgentSchema = z.object({
  name: z
    .string()
    .max(100)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Name is required")),
  bio: z
    .string()
    .optional()
    .transform((s) => s?.trim()),
  tokenAddress: z.string().min(1).max(256).optional(),
  tokenChain: z.string().min(1).max(64).optional(),
  tokenName: z.string().min(1).max(128).optional(),
  tokenTicker: z.string().min(1).max(32).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

async function duplicateTokenResponseBody(
  existingCharacter: { id: string } | null | undefined,
  tokenAddress: string,
  tokenChain?: string,
): Promise<Record<string, unknown>> {
  const existingSandbox = existingCharacter?.id
    ? await agentSandboxesRepository.findLatestByCharacterId(
        existingCharacter.id,
      )
    : null;

  return {
    success: false,
    error: `An agent is already linked to token ${tokenAddress}${tokenChain ? ` on ${tokenChain}` : ""}`,
    ...(existingCharacter?.id
      ? { existingCharacterId: existingCharacter.id }
      : {}),
    ...(existingSandbox?.id ? { existingAgentId: existingSandbox.id } : {}),
  };
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    if (user.role === "viewer") {
      return c.json(
        {
          success: false,
          error:
            "Insufficient permissions. Viewers cannot create agents. Please contact your organization owner.",
        },
        403,
      );
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    const validationResult = CreateAgentSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        400,
      );
    }

    const { name, bio, tokenChain, tokenName, tokenTicker } =
      validationResult.data;
    const tokenAddress = validationResult.data.tokenAddress
      ? normalizeTokenAddress(validationResult.data.tokenAddress, tokenChain)
      : undefined;

    if (tokenAddress) {
      const existing = await userCharactersRepository.findByTokenAddress(
        tokenAddress,
        tokenChain,
      );
      if (existing) {
        return c.json(
          await duplicateTokenResponseBody(existing, tokenAddress, tokenChain),
          409,
        );
      }
    }

    let creation: MeteredCharacterCreationReceipt;
    try {
      creation = await charactersService.createWithReceipt(
        {
          name,
          bio: bio ? [bio] : [DEFAULT_AGENT_BIO],
          user_id: user.id,
          organization_id: user.organization_id,
          source: "cloud",
          character_data: {},
          ...(tokenAddress && { token_address: tokenAddress }),
          ...(tokenChain && { token_chain: tokenChain }),
          ...(tokenName && { token_name: tokenName }),
          ...(tokenTicker && { token_ticker: tokenTicker }),
        },
        { policy: { mode: "metered" } },
      );
    } catch (error) {
      if (tokenAddress && isUniqueConstraintError(error)) {
        const existing = await userCharactersRepository.findByTokenAddress(
          tokenAddress,
          tokenChain,
        );
        return c.json(
          await duplicateTokenResponseBody(existing, tokenAddress, tokenChain),
          409,
        );
      }
      throw error;
    }

    const { character, quota } = creation;

    logger.info(`[Agents API] Created agent: ${character.id}`, {
      agentId: character.id,
      name: character.name,
      userId: user.id,
      organizationId: user.organization_id,
      agentCount: quota.currentAfter,
      maxAgents: quota.limit,
    });

    return c.json(
      {
        success: true,
        agent: {
          id: character.id,
          name: character.name,
          username: character.username,
          bio: character.bio,
          created_at: character.created_at,
          token_address: character.token_address ?? null,
          token_chain: character.token_chain ?? null,
          token_name: character.token_name ?? null,
          token_ticker: character.token_ticker ?? null,
        },
      },
      201,
    );
  } catch (error) {
    logger.error("[Agents API] Failed to create agent:", error);
    return failureResponse(c, error);
  }
});

export default app;

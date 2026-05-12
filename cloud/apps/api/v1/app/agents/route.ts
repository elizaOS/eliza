/**
 * POST /api/v1/app/agents — create a new AI agent (character) for the
 * authenticated user. Enforces organization agent quotas and role.
 */

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead } from "@/db/client";
import { userCharactersRepository } from "@/db/repositories/characters";
import { organizations } from "@/db/schemas/organizations";
import { userCharacters } from "@/db/schemas/user-characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { charactersService } from "@/lib/services/characters/characters";
import { isUniqueConstraintError } from "@/lib/utils/db-errors";
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

const AGENT_LIMITS = {
  FREE_TIER: 5,
  STARTER: 20,
  PRO: 100,
  ENTERPRISE: 500,
} as const;

function getMaxAgentsForOrg(creditBalance: number, orgSettings?: Record<string, unknown>): number {
  const customLimit = orgSettings?.max_agents as number | undefined;
  if (customLimit && customLimit > 0) return customLimit;

  const balance = Number(creditBalance);
  if (balance >= 100.0) return AGENT_LIMITS.ENTERPRISE;
  if (balance >= 10.0) return AGENT_LIMITS.PRO;
  if (balance >= 1.0) return AGENT_LIMITS.STARTER;
  return AGENT_LIMITS.FREE_TIER;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

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

    const body = await c.req.json();
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

    const { name, bio, tokenChain, tokenName, tokenTicker } = validationResult.data;
    const tokenAddress = validationResult.data.tokenAddress
      ? normalizeTokenAddress(validationResult.data.tokenAddress, tokenChain)
      : undefined;

    const org = await dbRead.query.organizations.findFirst({
      where: eq(organizations.id, user.organization_id),
      columns: {
        id: true,
        credit_balance: true,
        settings: true,
      },
    });

    if (!org) {
      return c.json({ success: false, error: "Organization not found" }, 404);
    }

    const [{ count }] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userCharacters)
      .where(
        and(
          eq(userCharacters.organization_id, user.organization_id),
          eq(userCharacters.source, "cloud"),
        ),
      );

    const maxAgents = getMaxAgentsForOrg(
      Number(org.credit_balance),
      org.settings as Record<string, unknown> | undefined,
    );

    if (count >= maxAgents) {
      return c.json(
        {
          success: false,
          error: `Agent quota exceeded. Your organization has reached the maximum of ${maxAgents} agents.`,
          details: {
            current: count,
            max: maxAgents,
            upgrade_hint: "Add credits to your account to increase your agent limit.",
          },
        },
        403,
      );
    }

    if (tokenAddress) {
      const existing = await userCharactersRepository.findByTokenAddress(tokenAddress, tokenChain);
      if (existing) {
        return c.json(
          {
            success: false,
            error: `An agent is already linked to token ${tokenAddress}${tokenChain ? ` on ${tokenChain}` : ""}`,
            existingAgentId: existing.id,
          },
          409,
        );
      }
    }

    let character;
    try {
      character = await charactersService.create({
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
      });
    } catch (error) {
      if (tokenAddress && isUniqueConstraintError(error)) {
        const existing = await userCharactersRepository.findByTokenAddress(
          tokenAddress,
          tokenChain,
        );
        return c.json(
          {
            success: false,
            error: `An agent is already linked to token ${tokenAddress}${tokenChain ? ` on ${tokenChain}` : ""}`,
            existingAgentId: existing?.id,
          },
          409,
        );
      }
      throw error;
    }

    logger.info(`[Agents API] Created agent: ${character.id}`, {
      agentId: character.id,
      name: character.name,
      userId: user.id,
      organizationId: user.organization_id,
      agentCount: count + 1,
      maxAgents,
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

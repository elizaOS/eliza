/**
 * POST /api/affiliate/create-character
 * Affiliate API endpoint for creating characters without requiring user signup.
 * Requires an API key whose `permissions` include `affiliate:create-character`.
 *
 * This Workers port performs URL pass-through for image inputs: HTTP(S) URLs
 * in `character.avatar_url` and `metadata.imageUrls` are kept verbatim, and
 * base64 image inputs are ignored. The R2-backed upload path is wired into
 * `processAffiliateImages` for callers that need it.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { apiKeysService } from "@/lib/services/api-keys";
import { charactersService } from "@/lib/services/characters/characters";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import type { ElizaCharacter } from "@/lib/types";
import { getCorsHeaders } from "@/lib/utils/cors";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const AFFILIATE_PERMISSION = "affiliate:create-character";
const AFFILIATE_ORG_SLUG = "affiliate-characters";
const AFFILIATE_ORG_NAME = "Affiliate Characters";
const AFFILIATE_ORG_INITIAL_BALANCE = "1000000";
const SESSION_TTL_DAYS = 7;
const ANON_USER_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const urlOrBase64 = z
  .string()
  .refine((value) => value.startsWith("data:image/") || isHttpUrl(value), {
    message: "Must be a valid URL or base64 data URL",
  });

const CreateCharacterSchema = z.object({
  character: z.object({
    name: z.string().min(1).max(50),
    bio: z.union([z.string(), z.array(z.string())]),
    lore: z.array(z.string()).optional(),
    messageExamples: z.array(z.unknown()).optional(),
    style: z
      .object({
        all: z.array(z.string()).optional(),
        chat: z.array(z.string()).optional(),
        post: z.array(z.string()).optional(),
      })
      .optional(),
    topics: z.array(z.string()).optional(),
    adjectives: z.array(z.string()).optional(),
    settings: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]),
      )
      .optional(),
    secrets: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    avatar_url: urlOrBase64.optional(),
  }),
  affiliateId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  metadata: z
    .object({
      source: z.string().optional(),
      vibe: z.string().optional(),
      backstory: z.string().optional(),
      instagram: z.string().optional(),
      twitter: z.string().optional(),
      socialContent: z.string().optional(),
      imageUrls: z.array(urlOrBase64).optional(),
      imageBase64s: z.array(z.string()).optional(),
      images: z
        .array(
          z.object({
            type: z.enum(["url", "base64"]),
            data: z.string(),
          }),
        )
        .optional(),
      avatarBase64: z.string().optional(),
    })
    .optional(),
});

async function authenticateAffiliate(c: AppContext) {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw AuthenticationError(
      "Missing or invalid Authorization header. Expected: Bearer <api_key>",
    );
  }
  const apiKeyValue = authHeader.slice(7).trim();
  if (!apiKeyValue) {
    throw AuthenticationError(
      "Missing or invalid Authorization header. Expected: Bearer <api_key>",
    );
  }

  const apiKey = await apiKeysService.validateApiKey(apiKeyValue);
  if (!apiKey) throw AuthenticationError("Invalid API key");
  if (!apiKey.is_active) throw ForbiddenError("API key is inactive");
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    throw AuthenticationError("API key has expired");
  }

  const permissions = Array.isArray(apiKey.permissions) ? apiKey.permissions : [];
  if (!permissions.includes(AFFILIATE_PERMISSION)) {
    throw ForbiddenError(
      "This API key does not have permission to create characters via affiliate API",
    );
  }
  return apiKey;
}

async function getOrCreateAffiliateOrg() {
  const existing = await organizationsService.getBySlug(AFFILIATE_ORG_SLUG);
  if (existing) return existing;
  return organizationsService.create({
    name: AFFILIATE_ORG_NAME,
    slug: AFFILIATE_ORG_SLUG,
    credit_balance: AFFILIATE_ORG_INITIAL_BALANCE,
  });
}

function pickHttpUrl(value: string | undefined | null): string | null {
  return value && isHttpUrl(value) ? value : null;
}

function resolveAvatarUrl(
  characterAvatar: string | undefined,
  imageUrls: string[] | undefined,
): string | null {
  return pickHttpUrl(characterAvatar) ?? imageUrls?.find(isHttpUrl) ?? null;
}

function clientIp(c: AppContext): string | undefined {
  return (
    c.req.header("x-real-ip")?.trim() ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined
  );
}

const app = new Hono<AppEnv>();

app.options("/", (c) => {
  const origin = c.req.header("origin") ?? null;
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
});

app.post("/", async (c) => {
  const startTime = Date.now();
  try {
    const apiKey = await authenticateAffiliate(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw ValidationError("Invalid JSON body");
    }

    const parsed = CreateCharacterSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("[Affiliate API] Invalid request body", parsed.error.issues);
      throw new ApiError(400, "validation_error", "Invalid request body", {
        issues: parsed.error.issues,
      });
    }

    const { character, affiliateId, sessionId: providedSessionId, metadata } = parsed.data;

    logger.info(`[Affiliate API] Creating character for affiliate: ${affiliateId}`, {
      characterName: character.name,
      hasSessionId: !!providedSessionId,
      imageCount: metadata?.imageUrls?.length ?? 0,
    });

    const affiliateOrg = await getOrCreateAffiliateOrg();

    const anonymousUserId = crypto.randomUUID();
    const anonymousUser = await usersService.create({
      steward_user_id: `affiliate:${anonymousUserId}`,
      name: character.name,
      email: `affiliate-${anonymousUserId}@anonymous.elizacloud.ai`,
      organization_id: affiliateOrg.id,
      is_anonymous: true,
      expires_at: new Date(Date.now() + ANON_USER_TTL_MS),
    });

    const sessionId = providedSessionId || crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ANON_USER_TTL_MS);

    const messagesLimit = Number.parseInt(
      (c.env.ANON_MESSAGE_LIMIT as string | undefined) ?? "5",
      10,
    );

    try {
      await anonymousSessionsService.create({
        session_token: sessionId,
        user_id: anonymousUser.id,
        expires_at: expiresAt,
        messages_limit: messagesLimit,
        ip_address: clientIp(c),
        user_agent: c.req.header("user-agent") ?? undefined,
      });
    } catch (error) {
      logger.warn("[Affiliate API] Failed to create anonymous session — continuing", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const httpImageUrls = (metadata?.imageUrls ?? []).filter(isHttpUrl);
    const resolvedAvatarUrl = resolveAvatarUrl(character.avatar_url, httpImageUrls);

    const elizaCharacter: ElizaCharacter = {
      name: character.name,
      bio: character.bio,
      messageExamples: character.messageExamples as ElizaCharacter["messageExamples"],
      style: character.style,
      topics: character.topics,
      adjectives: character.adjectives,
      settings: character.settings,
      secrets: character.secrets,
      avatarUrl: resolvedAvatarUrl ?? undefined,
    };

    const createdCharacter = await charactersService.create({
      organization_id: affiliateOrg.id,
      user_id: anonymousUser.id,
      name: elizaCharacter.name,
      bio: elizaCharacter.bio,
      message_examples: (elizaCharacter.messageExamples ?? []) as Record<string, unknown>[][],
      post_examples: [],
      topics: elizaCharacter.topics ?? [],
      adjectives: elizaCharacter.adjectives ?? [],
      knowledge: [],
      plugins: [],
      settings: (elizaCharacter.settings ?? {}) as Record<
        string,
        string | number | boolean | Record<string, unknown>
      >,
      secrets: (elizaCharacter.secrets ?? {}) as Record<string, string | number | boolean>,
      style: elizaCharacter.style ?? {},
      character_data: {
        ...elizaCharacter,
        lore: character.lore ?? [],
        affiliate: {
          affiliateId,
          source: metadata?.source,
          vibe: metadata?.vibe,
          backstory: metadata?.backstory,
          instagram: metadata?.instagram,
          twitter: metadata?.twitter,
          socialContent: metadata?.socialContent,
          imageUrls: httpImageUrls,
          createdAt: new Date().toISOString(),
        },
      } as Record<string, unknown>,
      is_template: false,
      is_public: false,
      avatar_url: resolvedAvatarUrl,
    });

    if (typeof c.executionCtx?.waitUntil === "function") {
      c.executionCtx.waitUntil(
        apiKeysService.incrementUsage(apiKey.id).catch((error) => {
          logger.warn("[Affiliate API] Failed to increment API key usage", {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const redirectUrl = new URL(`${baseUrl}/chat/${createdCharacter.id}`);
    redirectUrl.searchParams.set("source", affiliateId);
    redirectUrl.searchParams.set("session", sessionId);
    if (metadata?.vibe) redirectUrl.searchParams.set("vibe", metadata.vibe);

    logger.info(`[Affiliate API] Request completed in ${Date.now() - startTime}ms`, {
      characterId: createdCharacter.id,
      sessionId,
      affiliateId,
    });

    return c.json(
      {
        success: true,
        characterId: createdCharacter.id,
        sessionId,
        redirectUrl: redirectUrl.toString(),
        character: {
          id: createdCharacter.id,
          name: createdCharacter.name,
          avatarUrl: createdCharacter.avatar_url ?? null,
        },
        message: "Character created successfully",
      },
      201,
    );
  } catch (error) {
    if (!(error instanceof ApiError)) {
      logger.error("[Affiliate API] Request failed", error);
    }
    return failureResponse(c, error);
  }
});

export default app;

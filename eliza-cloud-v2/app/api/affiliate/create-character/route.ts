import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { apiKeysService } from "@/lib/services/api-keys";
import { charactersService } from "@/lib/services/characters/characters";
import { usersService } from "@/lib/services/users";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { organizationsService } from "@/lib/services/organizations";
import { processAffiliateImages } from "@/lib/services/affiliate-images";
import type { ElizaCharacter } from "@/lib/types";
import type { AffiliateMetadata } from "@/lib/types/affiliate";
import { logger } from "@/lib/utils/logger";

// Get message limit from env or default to 5 (matching auth-anonymous.ts)
const ANON_MESSAGE_LIMIT = Number.parseInt(
  process.env.ANON_MESSAGE_LIMIT || "5",
  10,
);

// Custom validator for URL or base64 data URL
const urlOrBase64 = z.string().refine(
  (val) => {
    // Accept base64 data URLs
    if (val.startsWith("data:image/")) return true;
    // Accept valid HTTP(S) URLs
    try {
      const url = new URL(val);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "Must be a valid URL or base64 data URL" },
);

// Schema validation for incoming character data
const CreateCharacterSchema = z.object({
  character: z.object({
    name: z.string().min(1).max(50),
    bio: z.union([z.string(), z.array(z.string())]),
    lore: z.array(z.string()).optional(),
    messageExamples: z.array(z.any()).optional(),
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
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.record(z.string(), z.unknown()),
        ]),
      )
      .optional(),
    secrets: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    avatar_url: urlOrBase64.optional(),
  }),
  affiliateId: z.string(),
  sessionId: z.string().uuid().optional(),
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

// In-memory rate limiting (simple implementation)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(
  apiKeyId: string,
  limit = 100,
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const hourInMs = 60 * 60 * 1000;

  let usage = rateLimitMap.get(apiKeyId);

  if (!usage || usage.resetAt < now) {
    usage = { count: 0, resetAt: now + hourInMs };
    rateLimitMap.set(apiKeyId, usage);
  }

  if (usage.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  usage.count++;
  return { allowed: true, remaining: limit - usage.count };
}

/**
 * POST /api/affiliate/create-character
 * Affiliate API endpoint for creating characters without requiring user signup.
 * Requires affiliate API key with "affiliate:create-character" permission.
 *
 * @param request - Request body with character data, affiliateId, optional sessionId, and metadata.
 * @returns Created character ID, session ID, and redirect URL.
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // 1. AUTHENTICATE - Extract and validate API key
    const authHeader = request.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("[Affiliate API] Missing or invalid authorization header");
      return NextResponse.json(
        {
          success: false,
          error:
            "Missing or invalid Authorization header. Expected: Bearer <api_key>",
        },
        { status: 401 },
      );
    }

    const apiKeyValue = authHeader.substring(7); // Remove "Bearer "
    const apiKey = await apiKeysService.validateApiKey(apiKeyValue);

    if (!apiKey) {
      logger.warn("[Affiliate API] Invalid API key provided");
      return NextResponse.json(
        {
          success: false,
          error: "Invalid API key",
        },
        { status: 401 },
      );
    }

    // 2. CHECK PERMISSIONS - Ensure API key has affiliate permissions
    if (!apiKey.permissions.includes("affiliate:create-character")) {
      logger.warn(
        `[Affiliate API] API key ${apiKey.key_prefix} lacks affiliate permissions`,
      );
      return NextResponse.json(
        {
          success: false,
          error:
            "This API key does not have permission to create characters via affiliate API",
        },
        { status: 403 },
      );
    }

    // 3. RATE LIMITING - Check if affiliate has exceeded rate limit
    const rateLimit = checkRateLimit(apiKey.id);
    if (!rateLimit.allowed) {
      logger.warn(
        `[Affiliate API] Rate limit exceeded for key ${apiKey.key_prefix}`,
      );
      return NextResponse.json(
        {
          success: false,
          error: "Rate limit exceeded. Maximum 100 requests per hour.",
        },
        {
          status: 429,
          headers: { "X-RateLimit-Remaining": "0" },
        },
      );
    }

    // 4. PARSE AND VALIDATE REQUEST BODY
    const body = await request.json();

    let validatedData;
    try {
      validatedData = CreateCharacterSchema.parse(body);
    } catch (error) {
      logger.error("[Affiliate API] Invalid request body", error);
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request body",
          details: error instanceof z.ZodError ? error.issues : undefined,
        },
        { status: 400 },
      );
    }

    const {
      character,
      affiliateId,
      sessionId: providedSessionId,
      metadata,
    } = validatedData;

    logger.info(
      `[Affiliate API] Creating character for affiliate: ${affiliateId}`,
      {
        characterName: character.name,
        hasSessionId: !!providedSessionId,
        hasImageUrls: !!(metadata?.imageUrls && metadata.imageUrls.length > 0),
        imageCount: metadata?.imageUrls?.length || 0,
      },
    );

    // 5. GET OR CREATE AFFILIATE ORGANIZATION
    // We use a special organization for all affiliate-created characters
    let affiliateOrg;
    try {
      // Try to find existing affiliate organization by slug
      affiliateOrg = await organizationsService.getBySlug(
        "affiliate-characters",
      );

      if (!affiliateOrg) {
        // Create affiliate organization if it doesn't exist
        affiliateOrg = await organizationsService.create({
          name: "Affiliate Characters",
          slug: "affiliate-characters",
          credit_balance: "1000000", // Large balance for affiliate characters
        });
        logger.info("[Affiliate API] Created new affiliate organization", {
          id: affiliateOrg.id,
        });
      }
    } catch (error) {
      logger.error(
        "[Affiliate API] Failed to get/create affiliate organization",
        error,
      );
      return NextResponse.json(
        {
          success: false,
          error: "Internal server error while setting up affiliate account",
        },
        { status: 500 },
      );
    }

    // 6. CREATE ANONYMOUS USER
    // Each character gets its own anonymous user (can be migrated to real user later)
    let anonymousUser;
    try {
      anonymousUser = await usersService.create({
        name: character.name,
        email: `affiliate-${randomUUID()}@anonymous.elizacloud.ai`, // Placeholder email
        organization_id: affiliateOrg.id,
        is_anonymous: true, // CRITICAL: Mark as anonymous so migration can find them
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      });

      logger.info("[Affiliate API] Created anonymous user", {
        userId: anonymousUser.id,
        isAnonymous: true,
      });
    } catch (error) {
      logger.error("[Affiliate API] Failed to create anonymous user", error);
      return NextResponse.json(
        {
          success: false,
          error: "Internal server error while creating user",
        },
        { status: 500 },
      );
    }

    // 7. CREATE ANONYMOUS SESSION
    const sessionId = providedSessionId || randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    try {
      await anonymousSessionsService.create({
        session_token: sessionId,
        user_id: anonymousUser.id,
        expires_at: expiresAt,
        messages_limit: ANON_MESSAGE_LIMIT, // Free tier: 5 messages before soft signup
        ip_address:
          request.headers.get("x-forwarded-for") ||
          request.headers.get("x-real-ip") ||
          undefined,
        user_agent: request.headers.get("user-agent") || undefined,
      });

      logger.info("[Affiliate API] Created anonymous session", { sessionId });
    } catch (error) {
      logger.error("[Affiliate API] Failed to create anonymous session", error);
      // Continue anyway - session is optional for initial character creation
    }

    // 8. PROCESS AFFILIATE IMAGES - Convert base64/external URLs to Vercel Blob
    // This is CRITICAL to prevent Next.js Image hostname errors and token bloat
    const tempCharacterId = randomUUID();
    let processedImages = {
      avatarUrl: null as string | null,
      referenceImageUrls: [] as string[],
      failedUploads: 0,
    };

    if (metadata) {
      try {
        const affiliateMetadata: AffiliateMetadata = {
          source: metadata.source,
          vibe: metadata.vibe,
          backstory: metadata.backstory,
          instagram: metadata.instagram,
          twitter: metadata.twitter,
          socialContent: metadata.socialContent,
          imageUrls: metadata.imageUrls,
          imageBase64s: metadata.imageBase64s,
          images: metadata.images,
          avatarBase64: metadata.avatarBase64,
        };

        processedImages = await processAffiliateImages(
          affiliateMetadata,
          tempCharacterId,
        );

        logger.info("[Affiliate API] Processed affiliate images", {
          avatarUrl: processedImages.avatarUrl
            ? processedImages.avatarUrl.substring(0, 60) + "..."
            : null,
          referenceCount: processedImages.referenceImageUrls.length,
          failedCount: processedImages.failedUploads,
        });
      } catch (error) {
        logger.error(
          "[Affiliate API] Failed to process affiliate images",
          error,
        );
      }
    }

    // 9. CREATE CHARACTER
    let createdCharacter;
    try {
      const resolvedAvatarUrl =
        processedImages.avatarUrl || character.avatar_url || null;

      if (resolvedAvatarUrl) {
        logger.info("[Affiliate API] Avatar URL resolved", {
          source: processedImages.avatarUrl
            ? "processedImages.avatarUrl (blob storage)"
            : "character.avatar_url (fallback)",
          url: resolvedAvatarUrl.substring(0, 80) + "...",
        });
      } else {
        logger.warn("[Affiliate API] No avatar URL available for character");
      }

      // Convert affiliate character format to elizaOS character format
      const elizaCharacter: ElizaCharacter = {
        name: character.name,
        bio: character.bio,
        messageExamples: character.messageExamples,
        style: character.style,
        topics: character.topics,
        adjectives: character.adjectives,
        settings: character.settings,
        secrets: character.secrets,
        avatar_url: resolvedAvatarUrl ?? undefined, // Use resolved avatar URL
      };

      createdCharacter = await charactersService.create({
        organization_id: affiliateOrg.id,
        user_id: anonymousUser.id,
        name: elizaCharacter.name,
        bio: elizaCharacter.bio,
        message_examples: (elizaCharacter.messageExamples || []) as Record<
          string,
          unknown
        >[][],
        post_examples: [],
        topics: elizaCharacter.topics || [],
        adjectives: elizaCharacter.adjectives || [],
        knowledge: [],
        plugins: [],
        settings: (elizaCharacter.settings || {}) as Record<
          string,
          string | number | boolean | Record<string, unknown>
        >,
        secrets: (elizaCharacter.secrets || {}) as Record<
          string,
          string | number | boolean
        >,
        style: elizaCharacter.style || {},
        character_data: {
          ...elizaCharacter,
          // IMPORTANT: Include lore separately so affiliate-context provider can access it
          lore: character.lore || [],
          affiliate: {
            affiliateId,
            source: metadata?.source,
            vibe: metadata?.vibe,
            backstory: metadata?.backstory,
            instagram: metadata?.instagram,
            twitter: metadata?.twitter,
            socialContent: metadata?.socialContent,
            imageUrls:
              processedImages.referenceImageUrls.length > 0
                ? processedImages.referenceImageUrls
                : metadata?.imageUrls || [],
            createdAt: new Date().toISOString(),
          },
        } as Record<string, unknown>,
        is_template: false,
        is_public: false,
        avatar_url: resolvedAvatarUrl,
      });

      logger.info("[Affiliate API] Character created successfully", {
        characterId: createdCharacter.id,
        characterName: createdCharacter.name,
      });
    } catch (error) {
      logger.error("[Affiliate API] Failed to create character", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create character",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }

    // 10. INCREMENT API KEY USAGE
    try {
      await apiKeysService.incrementUsage(apiKey.id);
    } catch (error) {
      logger.error("[Affiliate API] Failed to increment API key usage", error);
      // Non-critical, continue
    }

    // 11. BUILD REDIRECT URL
    // Always use /chat route - theming is now dynamic based on source param
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    const redirectUrl = new URL(`${baseUrl}/chat/${createdCharacter.id}`);
    redirectUrl.searchParams.set("source", affiliateId);
    redirectUrl.searchParams.set("session", sessionId);
    if (metadata?.vibe) {
      redirectUrl.searchParams.set("vibe", metadata.vibe);
    }

    logger.info(
      `[Affiliate API] Generated redirect URL for affiliate ${affiliateId}: ${redirectUrl.toString()}`,
    );

    // 12. RETURN SUCCESS RESPONSE
    const duration = Date.now() - startTime;
    logger.info(`[Affiliate API] ✅ Request completed in ${duration}ms`, {
      characterId: createdCharacter.id,
      sessionId,
      affiliateId,
    });

    return NextResponse.json(
      {
        success: true,
        characterId: createdCharacter.id,
        sessionId,
        redirectUrl: redirectUrl.toString(),
        message: "Character created successfully",
      },
      {
        status: 201,
        headers: {
          "X-RateLimit-Remaining": rateLimit.remaining.toString(),
        },
      },
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      `[Affiliate API] ❌ Request failed after ${duration}ms`,
      error,
    );

    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// OPTIONS handler for CORS preflight
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*", // Adjust in production
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}

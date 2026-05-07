import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Voice TTS API (v1)
 *
 * POST /api/v1/voice/tts
 * Converts text to speech using the voice synthesis service.
 * Supports both session and API key authentication.
 *
 * WHY THIS EXISTS:
 * ----------------
 * 1. PROVIDER AGNOSTIC: Uses generic `/api/v1/voice/` path instead of provider-specific
 *    paths like `/api/elevenlabs/`. This allows switching voice providers without
 *    breaking client integrations. The underlying ElevenLabs implementation is hidden.
 *
 * 2. API KEY SUPPORT: Enables developers and AI agents to generate speech programmatically.
 *    Voice-enabled applications (chatbots, accessibility tools, content creation) need
 *    server-side TTS without browser sessions.
 *
 * 3. AUTONOMOUS AGENTS: AI agents can speak autonomously - generating audio responses,
 *    creating podcasts, or handling voice interactions without human intervention.
 *
 * BACKWARDS COMPATIBILITY:
 * The legacy `/api/elevenlabs/tts` endpoint remains active for existing integrations.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { dbRead } from "@/db/client";
import { userVoices } from "@/db/schemas/user-voices";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { CUSTOM_VOICE_TTS_MARKUP } from "@/lib/pricing-constants";
import { billFlatUsage } from "@/lib/services/ai-billing";
import { calculateTTSCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { usageService } from "@/lib/services/usage";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";

const MAX_TEXT_LENGTH = 5000;

const TtsBody = z.object({
  text: z.string(),
  voiceId: z.string().optional(),
  modelId: z.string().optional(),
});

/**
 * POST /api/v1/voice/tts
 * Converts text to speech using the voice synthesis service.
 * Supports custom user voices and tracks usage statistics.
 * Includes 20% platform markup on all TTS costs.
 *
 * @param request - Request body with text, voiceId, and optional modelId.
 * @returns Streaming audio response (audio/mpeg).
 */
async function __hono_POST(request: Request) {
  let reservation: CreditReservation | undefined;

  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

    const rawBody = await request.json();
    const parsed = TtsBody.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { text, voiceId, modelId } = parsed.data;

    if (!text) {
      return Response.json({ error: "No text provided" }, { status: 400 });
    }

    if (text.length === 0) {
      return Response.json({ error: "Text cannot be empty" }, { status: 400 });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return Response.json(
        {
          error: `Text too long. Maximum length is ${MAX_TEXT_LENGTH} characters`,
        },
        { status: 400 },
      );
    }

    logger.info(`[Voice TTS API] Generating speech for user ${user.id}: ${text.length} chars`);

    let userVoiceId: string | null = null;
    let voiceName: string | null = null;
    let isCustomVoice = false;

    if (voiceId) {
      const [voice] = await dbRead
        .select({
          id: userVoices.id,
          name: userVoices.name,
          organizationId: userVoices.organizationId,
        })
        .from(userVoices)
        .where(eq(userVoices.elevenlabsVoiceId, voiceId))
        .limit(1);

      if (voice && voice.organizationId === user.organization_id) {
        userVoiceId = voice.id;
        voiceName = voice.name;
        isCustomVoice = true;

        voiceCloningService.incrementUsageCount(voice.id).catch((err) =>
          logger.error("[Voice TTS API] Failed to increment voice usage", {
            voiceId: voice.id,
            voiceName: voice.name,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

        logger.info("[Voice TTS API] Tracking custom voice usage", {
          userVoiceId: voice.id,
          voiceName: voice.name,
        });
      }
    }

    const ttsCost = await calculateTTSCostFromCatalog({
      model: `elevenlabs/${modelId || "eleven_flash_v2_5"}`,
      characterCount: text.length,
    });
    const estimatedCost = isCustomVoice
      ? Math.round(ttsCost.totalCost * CUSTOM_VOICE_TTS_MARKUP * 1_000_000) / 1_000_000
      : ttsCost.totalCost;

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        amount: estimatedCost,
        userId: user.id,
        description: `TTS generation: ${text.length} chars${isCustomVoice ? " (custom voice)" : ""}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return Response.json(
          {
            error: "Insufficient credits for text-to-speech",
            required: error.required,
          },
          { status: 402 },
        );
      }
      throw error;
    }

    const elevenlabs = getElevenLabsService();

    const startTime = Date.now();
    const audioStream = await elevenlabs.textToSpeech({
      text,
      voiceId,
      modelId,
    });
    const duration = Date.now() - startTime;

    logger.info(`[Voice TTS API] Stream started in ${duration}ms`);

    const billing = await billFlatUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id ?? null,
        model: `elevenlabs/${modelId || "eleven_flash_v2_5"}`,
        provider: "elevenlabs",
        billingSource: "elevenlabs",
        description: `TTS generation: ${text.length} chars${isCustomVoice ? " (custom voice)" : ""}`,
      },
      {
        totalCost: estimatedCost,
        baseTotalCost: isCustomVoice
          ? Math.round(ttsCost.baseTotalCost * CUSTOM_VOICE_TTS_MARKUP * 1_000_000) / 1_000_000
          : ttsCost.baseTotalCost,
        platformMarkup: isCustomVoice
          ? Math.round(ttsCost.platformMarkup * CUSTOM_VOICE_TTS_MARKUP * 1_000_000) / 1_000_000
          : ttsCost.platformMarkup,
      },
      reservation,
    );

    (async () => {
      try {
        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id ?? null,
          type: "tts",
          model: modelId || "eleven_flash_v2_5",
          provider: "elevenlabs",
          input_tokens: Math.ceil(text.length / 4),
          output_tokens: 0,
          input_cost: String(billing.totalCost),
          output_cost: String(0),
          markup: String(billing.platformMarkup),
          duration_ms: duration,
          is_successful: true,
          metadata: {
            voiceId: voiceId || "default",
            userVoiceId: userVoiceId,
            voiceName: voiceName,
            textLength: text.length,
            characterCount: text.length,
            isCustomVoice,
            baseTotalCost: billing.baseTotalCost,
            billingSource: "elevenlabs",
          },
        });
      } catch (error) {
        logger.error("[Voice TTS API] Failed to create usage record", {
          error: error instanceof Error ? error.message : String(error),
          userVoiceId,
        });
      }
    })();

    return new Response(audioStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    logger.error("[Voice TTS API] Error:", error);

    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[Voice TTS API] Refunded credits after error");
    }

    const errorMessage =
      error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === "string"
          ? error.toLowerCase()
          : "";

    if (
      errorMessage.includes("invalid or expired api key") ||
      errorMessage.includes("invalid or expired token") ||
      errorMessage.includes("api key is inactive") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("authentication required") ||
      errorMessage.includes("forbidden")
    ) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (errorMessage.includes("rate limit")) {
      return Response.json(
        { error: "Rate limit exceeded. Please try again in a moment." },
        { status: 429 },
      );
    }

    if (errorMessage.includes("quota")) {
      return Response.json(
        {
          error:
            "Voice service is temporarily unavailable due to high demand. Please try again in a few moments.",
          type: "service_unavailable",
          retryAfter: "5 minutes",
        },
        { status: 503 },
      );
    }

    if (errorMessage.includes("voice")) {
      return Response.json(
        { error: "Invalid voice ID. Please select a different voice." },
        { status: 400 },
      );
    }

    if (errorMessage.includes("elevenlabs_api_key")) {
      return Response.json({ error: "Service not configured" }, { status: 500 });
    }

    return Response.json(
      { error: "Failed to generate speech. Please try again." },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;

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

import {
  FIRST_SENTENCE_SNIP_VERSION,
  firstSentenceSnip,
} from "@elizaos/shared/voice/first-sentence-snip";
import { z } from "zod";
import { userVoicesRepository } from "@/db/repositories/user-voices";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { CUSTOM_VOICE_TTS_MARKUP } from "@/lib/pricing-constants";
import { billFlatUsage } from "@/lib/services/ai-billing";
import { calculateTTSCostFromCatalog } from "@/lib/services/ai-pricing";
import { contentSafetyService } from "@/lib/services/content-safety";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import {
  fingerprintCloudVoiceSettings,
  getCloudFirstLineCacheService,
  shouldBypassCloudFirstLineCache,
} from "@/lib/services/tts-first-line-cache";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";

/**
 * Default ElevenLabs output format. Must stay in sync with the ElevenLabs
 * service so cached bytes match what fresh synthesis returns.
 */
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

/**
 * Resolve a stable `voiceRevision` token for the ElevenLabs path. The real
 * impl could query `client.voices.get(voiceId).voice_settings` and hash it;
 * for the v1 cache we pin a static revision per voice/format and let a future
 * voice-settings change bump it manually.
 */
function resolveElevenLabsVoiceRevision(voiceId: string, modelId: string): string {
  return `elevenlabs:${voiceId}:${modelId}:${DEFAULT_OUTPUT_FORMAT}`;
}

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

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: `TTS text: ${text}`,
      metadata: { type: "tts", model: modelId || "eleven_flash_v2_5", voiceId },
    });

    logger.info(`[Voice TTS API] Generating speech for user ${user.id}: ${text.length} chars`);

    let userVoiceId: string | null = null;
    let voiceName: string | null = null;
    let isCustomVoice = false;

    if (voiceId) {
      const voice = await userVoicesRepository.findByElevenLabsVoiceId(voiceId);

      if (voice && voice.organizationId === user.organization_id) {
        userVoiceId = voice.id;
        voiceName = voice.name;
        isCustomVoice = true;

        userVoicesRepository.incrementUsageCount(voice.id).catch((err) =>
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

    // ---------------------------------------------------------------------
    // First-line cache hit path.
    //
    // Try to serve the request entirely from the first-line cache when the
    // whole input is a single short opener (e.g. "Got it.", "No problem!").
    // For longer messages we currently fall through to fresh synthesis but
    // still populate the cache in the background — concat-with-remainder is
    // a follow-up.
    // ---------------------------------------------------------------------
    const resolvedVoiceId = voiceId || "EXAVITQu4vr4xnSDxMaL";
    const resolvedModelId = modelId || "eleven_flash_v2_5";
    const snipResult = firstSentenceSnip(text);
    const cacheBypass = shouldBypassCloudFirstLineCache({ modelId: resolvedModelId });
    const cacheScope = isCustomVoice ? `org:${user.organization_id}` : "global";
    const voiceSettingsFingerprint = fingerprintCloudVoiceSettings({
      outputFormat: DEFAULT_OUTPUT_FORMAT,
    });

    if (
      snipResult &&
      !cacheBypass &&
      // Cache currently only serves WHOLE-input hits to avoid mp3 stream
      // alignment hazards on the concat path.
      snipResult.endOffset === text.trimEnd().length
    ) {
      try {
        const cacheService = getCloudFirstLineCacheService();
        const cached = await cacheService.get({
          algoVersion: FIRST_SENTENCE_SNIP_VERSION,
          provider: "elevenlabs",
          voiceId: resolvedVoiceId,
          voiceRevision: resolveElevenLabsVoiceRevision(resolvedVoiceId, resolvedModelId),
          sampleRate: 44100,
          codec: "mp3",
          voiceSettingsFingerprint,
          normalizedText: snipResult.normalized,
          scope: cacheScope,
        });
        if (cached) {
          logger.info(
            `[Voice TTS API] first-line cache HIT (${cacheScope}, ${cached.byteSize}B, hits=${cached.hitCount})`,
          );
          return new Response(cached.bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": cached.contentType,
              "Cache-Control": "no-cache",
              "X-TTS-Cache": "hit; first-sentence",
            },
          });
        }
      } catch (err) {
        // Cache failure is non-fatal — fall through to normal synthesis.
        logger.warn?.(
          `[Voice TTS API] first-line cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

    // ---------------------------------------------------------------------
    // First-line cache populate path.
    //
    // Re-synthesise JUST the snipped first sentence and store it (the
    // already-streamed-out bytes can't be sliced reliably at sentence
    // boundaries — mp3 frames aren't aligned). The fan-out is bounded by
    // the ≤ 10-word snip cap and skipped entirely on bypass / no-snip.
    // ---------------------------------------------------------------------
    if (snipResult && !cacheBypass) {
      void (async () => {
        try {
          const cacheService = getCloudFirstLineCacheService();
          const cacheKey = {
            algoVersion: FIRST_SENTENCE_SNIP_VERSION,
            provider: "elevenlabs",
            voiceId: resolvedVoiceId,
            voiceRevision: resolveElevenLabsVoiceRevision(resolvedVoiceId, resolvedModelId),
            sampleRate: 44100,
            codec: "mp3" as const,
            voiceSettingsFingerprint,
            normalizedText: snipResult.normalized,
            scope: cacheScope,
          };
          if (await cacheService.has(cacheKey)) return;
          const snipStream = await elevenlabs.textToSpeech({
            text: snipResult.raw,
            voiceId,
            modelId,
          });
          const reader = snipStream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            const chunk = r.value as Uint8Array;
            chunks.push(chunk);
            total += chunk.byteLength;
          }
          if (total === 0) return;
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          await cacheService.put({
            ...cacheKey,
            bytes: merged,
            rawText: snipResult.raw,
            contentType: "audio/mpeg",
            durationMs: 0,
            wordCount: snipResult.wordCount,
          });
          logger.info(
            `[Voice TTS API] first-line cache POPULATE ok (${cacheScope}, ${total}B, "${snipResult.normalized}")`,
          );
        } catch (err) {
          logger.warn?.(
            `[Voice TTS API] first-line cache populate failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }

    return new Response(audioStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "X-TTS-Cache": "miss",
      },
    });
  } catch (error) {
    logger.error("[Voice TTS API] Error:", error);

    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[Voice TTS API] Refunded credits after error");
    }

    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
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

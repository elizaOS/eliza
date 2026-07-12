// Handles v1 cloud API v1 voice tts route traffic with route-local auth expectations.
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
import { drainPcm16Stream, pcm16ToWav } from "@/lib/services/pcm16-wav";
import {
  fingerprintCloudVoiceSettings,
  getCloudFirstLineCacheService,
  shouldBypassCloudFirstLineCache,
} from "@/lib/services/tts-first-line-cache";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import { synthesizeCartesiaWav } from "./cartesia-synthesis";
import {
  buildKokoroCacheKey,
  isKokoroFirstLineCacheEnabled,
} from "./kokoro-first-line-cache";
import {
  LEGACY_DEFAULT_ELEVENLABS_VOICE_ID,
  selectTtsProvider,
  type TtsProvider,
} from "./provider-selection";

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
function resolveElevenLabsVoiceRevision(
  voiceId: string,
  modelId: string,
): string {
  return `elevenlabs:${voiceId}:${modelId}:${DEFAULT_OUTPUT_FORMAT}`;
}

const MAX_TEXT_LENGTH = 5000;

const TtsBody = z.object({
  text: z.string(),
  voiceId: z.string().optional(),
  modelId: z.string().optional(),
  // Optional container format. Default (unset) = MP3, unchanged for every
  // existing caller. `"wav"` returns PCM16 WAV for clients whose audio stack has
  // no MP3 decoder (e.g. the Light Phone III / LightOS WebView), which need an
  // uncompressed container that decodes without a codec.
  format: z.enum(["mp3", "wav"]).optional(),
});

interface TtsTimings {
  authMs?: number;
  admissionMs?: number;
  synthesisMs?: number;
}

function buildTtsObservabilityHeaders(
  // "cartesia" is a synthesis ENGINE substitution inside the elevenlabs
  // selection branch, not a third selectable provider — hence the widening
  // here rather than in TtsProvider.
  provider: TtsProvider | "cartesia",
  timings: TtsTimings,
): Record<string, string> {
  const serverTiming = [
    timings.authMs !== undefined ? `auth;dur=${timings.authMs}` : null,
    timings.admissionMs !== undefined
      ? `admission;dur=${timings.admissionMs}`
      : null,
    timings.synthesisMs !== undefined
      ? `synthesis;dur=${timings.synthesisMs}`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return {
    "X-Eliza-TTS-Provider": provider,
    ...(serverTiming.length > 0
      ? { "Server-Timing": serverTiming.join(", ") }
      : {}),
  };
}

/** ElevenLabs PCM sample rate we request for the WAV path (Hz). */
const WAV_PCM_SAMPLE_RATE = 24_000;
const MAX_WAV_PCM_BYTES = 64 * 1024 * 1024;

/**
 * Default Cartesia voice for un-pinned WAV requests ("Skylar — Friendly
 * Guide", verified live). Override per-environment with
 * CARTESIA_DEFAULT_VOICE_ID; callers that pin any voice identity (custom
 * voices, explicit ElevenLabs ids) never reach the Cartesia engine.
 */
const DEFAULT_CARTESIA_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

/**
 * PCM byte cap for a Cartesia synthesis. The synthesis buffers frames + a
 * merged copy + the WAV in Worker memory, so the cap must reflect the real
 * ceiling, not a generic 64 MiB: MAX_TEXT_LENGTH (5000 chars) synthesizes to
 * roughly 3-5 minutes of 24 kHz 16-bit mono ≈ 9-14 MiB. 16 MiB covers that
 * with headroom; anything larger indicates a runaway stream and falls back to
 * ElevenLabs (the synthesis throws rather than truncating).
 */
const MAX_CARTESIA_PCM_BYTES = 16 * 1024 * 1024;

/**
 * POST /api/v1/voice/tts
 * Converts text to speech using the voice synthesis service.
 * Supports custom user voices and tracks usage statistics.
 * Includes 20% platform markup on all TTS costs.
 *
 * @param request - Request body with text, voiceId, and optional modelId.
 * @returns Streaming audio response (audio/mpeg).
 */
async function __hono_POST(request: Request, env: AppEnv["Bindings"]) {
  let reservation: CreditReservation | undefined;
  const requestStart = Date.now();
  const timings: TtsTimings = {};

  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    timings.authMs = Date.now() - requestStart;
    const admissionStart = Date.now();

    const rawBody = await request.json();
    const parsed = TtsBody.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { text, voiceId, modelId } = parsed.data;
    const kokoroBaseUrl = env.KOKORO_TTS_URL?.trim();
    const providerSelection = selectTtsProvider({
      voiceId,
      kokoroConfigured: Boolean(kokoroBaseUrl),
    });
    // WAV output is opt-in and bypasses the MP3-shaped first-line cache (a
    // different codec); billing/usage are identical to the MP3 path.
    const wantWav = parsed.data.format === "wav";

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

    if (!providerSelection.ok) {
      timings.admissionMs = Date.now() - admissionStart;
      logger.warn?.("[Voice TTS API] TTS provider selection failed", {
        provider: providerSelection.provider,
        fallbackReason: providerSelection.fallbackReason,
        code: providerSelection.code,
      });
      return Response.json(
        {
          error: providerSelection.error,
          code: providerSelection.code,
        },
        {
          status: providerSelection.status,
          headers: buildTtsObservabilityHeaders(
            providerSelection.provider,
            timings,
          ),
        },
      );
    }

    await contentSafetyService.assertSafeForPublicUse({
      surface: "media_generation_prompt",
      organizationId: user.organization_id,
      userId: user.id,
      text: `TTS text: ${text}`,
      metadata: { type: "tts", model: modelId || "eleven_flash_v2_5", voiceId },
    });

    logger.info(
      `[Voice TTS API] Generating speech for user ${user.id}: ${text.length} chars`,
    );
    logger.info("[Voice TTS API] Selected TTS provider", {
      provider: providerSelection.provider,
      fallbackReason: providerSelection.fallbackReason,
      voiceId: providerSelection.voiceId ?? "default",
    });

    // -------------------------------------------------------------------------
    // Free default voice: self-hosted Kokoro TTS. When KOKORO_TTS_URL is set this
    // is the product default — no credit reservation, no billing. Explicit
    // custom/ElevenLabs voice ids continue down the paid provider path.
    // -------------------------------------------------------------------------
    if (providerSelection.provider === "kokoro") {
      const kokoroVoice = providerSelection.voiceId;
      timings.admissionMs = Date.now() - admissionStart;

      // First-line cache (#14375), gated on the #14370 TTFB benchmark and off by
      // default. Only WHOLE-input short openers ("Got it.") are cacheable — the
      // same whole-input-only rule the ElevenLabs path uses (no concat).
      const kokoroCacheEnabled = isKokoroFirstLineCacheEnabled(
        env.KOKORO_FIRST_LINE_CACHE,
      );
      const kokoroSnip = kokoroCacheEnabled ? firstSentenceSnip(text) : null;
      const kokoroCacheable =
        kokoroSnip !== null && kokoroSnip.endOffset === text.trimEnd().length;
      const kokoroCacheKey =
        kokoroCacheEnabled && kokoroCacheable && kokoroSnip
          ? buildKokoroCacheKey({
              kokoroVoice,
              normalizedText: kokoroSnip.normalized,
              imageTag: env.KOKORO_SERVICE_IMAGE_TAG,
            })
          : null;

      if (kokoroCacheKey) {
        try {
          const cacheStart = Date.now();
          const cached =
            await getCloudFirstLineCacheService().get(kokoroCacheKey);
          if (cached) {
            timings.synthesisMs = Date.now() - cacheStart;
            logger.info(
              `[Voice TTS API] Kokoro first-line cache HIT (${cached.byteSize}B, hits=${cached.hitCount}, voice=${kokoroVoice}) — no upstream request`,
            );
            return new Response(cached.bytes as unknown as BodyInit, {
              status: 200,
              headers: {
                "Content-Type": cached.contentType,
                "Cache-Control": "no-cache",
                ...buildTtsObservabilityHeaders("kokoro", timings),
                "X-TTS-Cache": "hit; kokoro; first-sentence",
              },
            });
          }
        } catch (err) {
          // error-policy:J4 cache lookup failure degrades to fresh synthesis;
          // the upstream Railway request below is the source of truth.
          logger.warn?.(
            "[Voice TTS API] Kokoro first-line cache lookup failed",
            {
              errorType: err instanceof Error ? err.name : "unknown",
            },
          );
        }
      }

      const kokoroStart = Date.now();
      const kokoroResponse = await fetch(
        `${kokoroBaseUrl!.replace(/\/+$/, "")}/api/tts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: kokoroVoice, speed: 1 }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      timings.synthesisMs = Date.now() - kokoroStart;
      if (!kokoroResponse.ok || !kokoroResponse.body) {
        logger.error(
          `[Voice TTS API] Kokoro synthesis failed (${kokoroResponse.status})`,
        );
        return Response.json(
          { error: "TTS synthesis failed" },
          { status: 502 },
        );
      }
      const kokoroContentType =
        kokoroResponse.headers.get("Content-Type") ?? "audio/wav";
      logger.info(
        `[Voice TTS API] Kokoro stream started in ${Date.now() - kokoroStart}ms (voice=${kokoroVoice}, free)`,
      );

      // Cacheable opener MISS: buffer the (tiny, ≤10-word) WAV so we can serve
      // it AND populate the cache. Non-cacheable text streams straight through
      // to preserve time-to-first-byte on long responses.
      if (kokoroCacheKey && kokoroSnip) {
        const bytes = new Uint8Array(await kokoroResponse.arrayBuffer());
        void getCloudFirstLineCacheService()
          .put({
            ...kokoroCacheKey,
            bytes,
            rawText: kokoroSnip.raw,
            contentType: kokoroContentType,
            durationMs: 0,
            wordCount: kokoroSnip.wordCount,
          })
          .then((ok) => {
            if (ok) {
              logger.info(
                `[Voice TTS API] Kokoro first-line cache POPULATE ok (${bytes.byteLength}B, words=${kokoroSnip.wordCount})`,
              );
            }
          })
          .catch((err) => {
            // error-policy:J7 populate is a background write; a failure must not
            // affect the response the user already receives below.
            logger.warn?.(
              "[Voice TTS API] Kokoro first-line cache populate failed",
              {
                errorType: err instanceof Error ? err.name : "unknown",
              },
            );
          });

        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": kokoroContentType,
            "Cache-Control": "no-store",
            ...buildTtsObservabilityHeaders("kokoro", timings),
            "X-TTS-Cache": "miss; kokoro",
          },
        });
      }

      return new Response(kokoroResponse.body, {
        status: 200,
        headers: {
          "Content-Type": kokoroContentType,
          "Cache-Control": "no-store",
          ...buildTtsObservabilityHeaders("kokoro", timings),
        },
      });
    }

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
            errorType: err instanceof Error ? err.name : "unknown",
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
    const cacheBypass = shouldBypassCloudFirstLineCache({
      modelId: resolvedModelId,
    });
    const cacheScope = isCustomVoice ? `org:${user.organization_id}` : "global";
    const voiceSettingsFingerprint = fingerprintCloudVoiceSettings({
      outputFormat: DEFAULT_OUTPUT_FORMAT,
    });
    timings.admissionMs = Date.now() - admissionStart;

    if (
      !wantWav &&
      snipResult &&
      !cacheBypass &&
      // Cache currently only serves WHOLE-input hits to avoid mp3 stream
      // alignment hazards on the concat path.
      snipResult.endOffset === text.trimEnd().length
    ) {
      try {
        const cacheStart = Date.now();
        const cacheService = getCloudFirstLineCacheService();
        const cached = await cacheService.get({
          algoVersion: FIRST_SENTENCE_SNIP_VERSION,
          provider: "elevenlabs",
          voiceId: resolvedVoiceId,
          voiceRevision: resolveElevenLabsVoiceRevision(
            resolvedVoiceId,
            resolvedModelId,
          ),
          sampleRate: 44100,
          codec: "mp3",
          voiceSettingsFingerprint,
          normalizedText: snipResult.normalized,
          scope: cacheScope,
        });
        if (cached) {
          timings.synthesisMs = Date.now() - cacheStart;
          logger.info(
            `[Voice TTS API] first-line cache HIT (${cacheScope}, ${cached.byteSize}B, hits=${cached.hitCount})`,
          );
          return new Response(cached.bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": cached.contentType,
              "Cache-Control": "no-cache",
              ...buildTtsObservabilityHeaders("elevenlabs", timings),
              "X-TTS-Cache": "hit; first-sentence",
            },
          });
        }
      } catch (err) {
        // error-policy:J4 cache lookup failure degrades to fresh synthesis; the
        // ElevenLabs request below remains the source of truth.
        logger.warn?.("[Voice TTS API] first-line cache lookup failed", {
          errorType: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    // WAV/Cartesia first-line cache twin: the MP3 cache above never serves
    // WAV callers, so codec-less clients paid full synthesis for every short
    // opener. Same whole-input gate; key is codec/provider/rate-specific so
    // MP3 and WAV entries can never collide.
    const cartesiaApiKey = env.CARTESIA_API_KEY?.trim();
    const callerPinnedVoice =
      Boolean(voiceId) && voiceId !== LEGACY_DEFAULT_ELEVENLABS_VOICE_ID;
    const cartesiaVoiceId =
      env.CARTESIA_DEFAULT_VOICE_ID?.trim() || DEFAULT_CARTESIA_VOICE_ID;
    const cartesiaEligible =
      wantWav &&
      Boolean(cartesiaApiKey) &&
      !isCustomVoice &&
      !callerPinnedVoice;
    const wavCacheKey =
      cartesiaEligible &&
      snipResult &&
      !cacheBypass &&
      snipResult.endOffset === text.trimEnd().length
        ? {
            algoVersion: FIRST_SENTENCE_SNIP_VERSION,
            provider: "cartesia",
            voiceId: cartesiaVoiceId,
            voiceRevision: `cartesia:${cartesiaVoiceId}:sonic-3.5:pcm${WAV_PCM_SAMPLE_RATE}`,
            sampleRate: WAV_PCM_SAMPLE_RATE,
            codec: "wav" as const,
            voiceSettingsFingerprint: fingerprintCloudVoiceSettings({
              outputFormat: `pcm_${WAV_PCM_SAMPLE_RATE}`,
            }),
            normalizedText: snipResult.normalized,
            scope: "global",
          }
        : null;
    if (wavCacheKey) {
      try {
        const cacheStart = Date.now();
        const cached = await getCloudFirstLineCacheService().get(wavCacheKey);
        if (cached) {
          timings.synthesisMs = Date.now() - cacheStart;
          logger.info(
            `[Voice TTS API] WAV first-line cache HIT (${cached.byteSize}B, hits=${cached.hitCount})`,
          );
          return new Response(cached.bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": "audio/wav",
              "Cache-Control": "no-cache",
              ...buildTtsObservabilityHeaders("cartesia", timings),
              "X-TTS-Cache": "hit; first-sentence; wav",
            },
          });
        }
      } catch (err) {
        // error-policy:J4 cache lookup failure degrades to fresh synthesis; the
        // Cartesia request below remains the source of truth.
        logger.warn?.(
          `[Voice TTS API] WAV first-line cache lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const ttsCost = await calculateTTSCostFromCatalog({
      model: `elevenlabs/${modelId || "eleven_flash_v2_5"}`,
      characterCount: text.length,
    });
    const estimatedCost = isCustomVoice
      ? Math.round(ttsCost.totalCost * CUSTOM_VOICE_TTS_MARKUP * 1_000_000) /
        1_000_000
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
    timings.admissionMs = Date.now() - admissionStart;

    const elevenlabs = getElevenLabsService(env);

    const startTime = Date.now();
    // WAV fast path: Cartesia Sonic streams raw PCM (~150 ms to first audio,
    // ~0.6 s total, measured live) where the buffered ElevenLabs PCM
    // round-trip takes ~3 s — and WAV requests can't use the MP3 first-line
    // cache. The engine is only substitutable when the caller did NOT pin a
    // voice identity: custom voices and explicit (non-proxy-default)
    // ElevenLabs voice ids keep ElevenLabs. Billing below charges the same
    // ElevenLabs catalog rate either way, so the engine choice never changes
    // the user's price (Cartesia's upstream cost is lower, not higher).
    let wav: Uint8Array | undefined;
    let synthesisEngine: "elevenlabs" | "cartesia" = "elevenlabs";
    if (cartesiaEligible && cartesiaApiKey) {
      try {
        const cartesia = await synthesizeCartesiaWav({
          apiKey: cartesiaApiKey,
          voiceId: cartesiaVoiceId,
          text,
          sampleRate: WAV_PCM_SAMPLE_RATE,
          maxPcmBytes: MAX_CARTESIA_PCM_BYTES,
        });
        wav = cartesia.wav;
        synthesisEngine = "cartesia";
        if (wavCacheKey) {
          const wavBytes = cartesia.wav;
          void (async () => {
            try {
              await getCloudFirstLineCacheService().put({
                ...wavCacheKey,
                bytes: wavBytes,
                rawText: snipResult?.raw ?? text,
                contentType: "audio/wav",
                durationMs: 0,
                wordCount: snipResult?.wordCount ?? 0,
              });
              logger.info(
                `[Voice TTS API] WAV first-line cache POPULATE ok (${wavBytes.byteLength}B)`,
              );
            } catch (err) {
              // error-policy:J7 cache populate is diagnostics-adjacent decoration;
              // a failed put must not affect the served reply.
              logger.warn?.(
                `[Voice TTS API] WAV first-line cache populate failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })();
        }
        logger.info("[Voice TTS API] Cartesia WAV synthesis", {
          firstAudioMs: cartesia.firstAudioMs,
          totalMs: cartesia.totalMs,
          pcmBytes: cartesia.pcmBytes,
        });
      } catch (error) {
        // error-policy:J4 designed engine degrade — a Cartesia outage must not
        // drop voice: the ElevenLabs synthesis below is the fallback engine at
        // the identical billed rate, and the failure is surfaced here.
        logger.warn(
          "[Voice TTS API] Cartesia synthesis failed; falling back to ElevenLabs",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    let audioStream: ReadableStream<Uint8Array> | undefined;
    if (wav === undefined) {
      audioStream = await elevenlabs.textToSpeech({
        text,
        voiceId,
        modelId,
        // WAV path requests raw PCM (wrapped in a WAV header below); default
        // callers get the service's MP3 default.
        ...(wantWav ? { outputFormat: `pcm_${WAV_PCM_SAMPLE_RATE}` } : {}),
      });
      if (wantWav) {
        wav = pcm16ToWav(
          await drainPcm16Stream(audioStream, MAX_WAV_PCM_BYTES),
          WAV_PCM_SAMPLE_RATE,
        );
      }
    }
    const duration = Date.now() - startTime;
    timings.synthesisMs = duration;

    logger.info("[Voice TTS API] Stream started", {
      provider: synthesisEngine,
      fallbackReason: providerSelection.fallbackReason,
      durationMs: duration,
    });

    const billing = await billFlatUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id ?? null,
        model: `elevenlabs/${modelId || "eleven_flash_v2_5"}`,
        provider: "elevenlabs",
        billingSource: "elevenlabs",
        // Affiliate revenue-share via X-Affiliate-Code (existing billFlatUsage branch).
        affiliateCode: request.headers.get("X-Affiliate-Code"),
        description: `TTS generation: ${text.length} chars${isCustomVoice ? " (custom voice)" : ""}`,
      },
      {
        totalCost: estimatedCost,
        baseTotalCost: isCustomVoice
          ? Math.round(
              ttsCost.baseTotalCost * CUSTOM_VOICE_TTS_MARKUP * 1_000_000,
            ) / 1_000_000
          : ttsCost.baseTotalCost,
        platformMarkup: isCustomVoice
          ? Math.round(
              ttsCost.platformMarkup * CUSTOM_VOICE_TTS_MARKUP * 1_000_000,
            ) / 1_000_000
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
          // Attribute the engine that actually synthesized; the CHARGE always
          // comes from the ElevenLabs catalog rate (billingSource below), so a
          // Cartesia-served request costs the user exactly what the
          // ElevenLabs-served one would.
          model:
            synthesisEngine === "cartesia"
              ? "sonic-3.5"
              : modelId || "eleven_flash_v2_5",
          provider: synthesisEngine,
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
            synthesisEngine,
          },
        });
      } catch (error) {
        logger.error("[Voice TTS API] Failed to create usage record", {
          errorType: error instanceof Error ? error.name : "unknown",
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
    if (!wantWav && snipResult && !cacheBypass) {
      void (async () => {
        try {
          const cacheService = getCloudFirstLineCacheService();
          const cacheKey = {
            algoVersion: FIRST_SENTENCE_SNIP_VERSION,
            provider: "elevenlabs",
            voiceId: resolvedVoiceId,
            voiceRevision: resolveElevenLabsVoiceRevision(
              resolvedVoiceId,
              resolvedModelId,
            ),
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
            `[Voice TTS API] first-line cache POPULATE ok (${cacheScope}, ${total}B, words=${snipResult.wordCount})`,
          );
        } catch (err) {
          logger.warn?.("[Voice TTS API] first-line cache populate failed", {
            errorType: err instanceof Error ? err.name : "unknown",
          });
        }
      })();
    }

    // WAV path: raw PCM (Cartesia frames or the ElevenLabs PCM stream)
    // buffered and wrapped in a WAV header so codec-less clients can decode
    // it. (Buffered, not streamed — fine for short TTS replies; the MP3 path
    // keeps its chunked streaming below.)
    if (wav !== undefined) {
      return new Response(wav as unknown as BodyInit, {
        headers: {
          "Content-Type": "audio/wav",
          "Cache-Control": "no-cache",
          ...buildTtsObservabilityHeaders(synthesisEngine, timings),
          "X-TTS-Cache": "miss",
        },
      });
    }

    return new Response(audioStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        ...buildTtsObservabilityHeaders("elevenlabs", timings),
        "X-TTS-Cache": "miss",
      },
    });
  } catch (error) {
    // Redaction boundary: provider SDK errors can embed the synthesis text or
    // provider response bodies in their message — log only the error type.
    logger.error("[Voice TTS API] Request failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });

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
      return Response.json(
        { error: "Service not configured" },
        { status: 500 },
      );
    }

    return Response.json(
      { error: "Failed to generate speech. Please try again." },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw, c.env));
export default __hono_app;

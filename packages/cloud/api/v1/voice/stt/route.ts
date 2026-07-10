// Handles v1 cloud API v1 voice stt route traffic with route-local auth expectations.
import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Voice STT API (v1)
 *
 * POST /api/v1/voice/stt
 * Converts speech to text using the voice transcription service.
 * Supports both session and API key authentication.
 *
 * WHY THIS EXISTS:
 * ----------------
 * 1. PROVIDER AGNOSTIC: Generic `/api/v1/voice/stt` path allows provider switching
 *    without breaking integrations. Decouples clients from ElevenLabs specifics.
 *
 * 2. PROGRAMMATIC TRANSCRIPTION: Developers building voice apps, meeting transcription
 *    tools, or accessibility features need server-side STT via API keys.
 *
 * 3. AUTONOMOUS AGENTS: Enables AI agents to process voice input - understanding
 *    voice commands, transcribing conversations, or handling voice-based workflows.
 *
 * SECURITY:
 * - File type validation via magic numbers (not just MIME headers) prevents spoofing
 * - Max file size limits prevent abuse
 * - Credit reservation before processing ensures payment
 */

import { fileTypeFromBuffer } from "file-type";
import { parseBuffer } from "music-metadata";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { billFlatUsage } from "@/lib/services/ai-billing";
import { calculateSTTCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import {
  elapsedMs,
  readVoiceTraceId,
  type VoiceTimingComponent,
  voiceJsonResponse,
} from "../trace";
import { resolveWhisperSttModel } from "./whisper-model";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const SUPPORTED_MIME_TYPES = [
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
];

const ALLOWED_AUDIO_SIGNATURES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "video/webm", // Safari/macOS creates this for audio recordings
]);

function estimateAudioDurationMinutes(
  fileSizeBytes: number,
  mimeType: string,
): number {
  const bitratesKbps: Record<string, number> = {
    "audio/mpeg": 128,
    "audio/mp3": 128,
    "audio/mp4": 128,
    "audio/m4a": 128,
    "audio/wav": 1411,
    "audio/webm": 96,
    "audio/ogg": 96,
    "video/webm": 96,
  };

  const bitrate = bitratesKbps[mimeType] || 128;
  const bytesPerMinute = ((bitrate * 1000) / 8) * 60;
  const estimatedMinutes = fileSizeBytes / bytesPerMinute;

  return Math.max(0.1, estimatedMinutes);
}

/**
 * POST /api/v1/voice/stt
 * Converts speech to text using the voice transcription service.
 * Validates file type using magic numbers for security.
 * Includes 20% platform markup on all STT costs.
 *
 * @param request - Form data with audio file and optional languageCode.
 * @returns Transcript and processing duration.
 */
async function __hono_POST(request: Request, env: AppEnv["Bindings"]) {
  const routeStartMs = Date.now();
  const traceId = readVoiceTraceId(request);
  let reservation: CreditReservation | undefined;
  const timings = (): VoiceTimingComponent[] => [
    { name: "admission", durationMs: elapsedMs(routeStartMs) },
  ];
  const json = (body: unknown, status = 200, extra = timings()) =>
    voiceJsonResponse(body, { status, traceId, timings: extra });

  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return json(
        { error: "Expected multipart form data with audio field" },
        400,
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const languageCode = formData.get("languageCode") as string | undefined;

    if (!audioFile) {
      return json({ error: "No audio file provided" }, 400);
    }

    if (audioFile.size > MAX_FILE_SIZE) {
      return json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        400,
      );
    }

    const baseMimeType = audioFile.type.split(";")[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(baseMimeType)) {
      return json(
        {
          error: `Unsupported audio format: ${audioFile.type}. Supported: mp3, mp4, m4a, wav, webm, ogg`,
        },
        400,
      );
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const fileTypeResult = await fileTypeFromBuffer(buffer);

    if (!fileTypeResult) {
      logger.warn("[Voice STT API] Unable to detect file type - rejecting", {
        traceId,
        audioFileName: audioFile.name,
        audioSizeBytes: audioFile.size,
      });
      return json(
        {
          error:
            "Unable to verify file type. The file may be corrupted or of an unsupported format.",
        },
        400,
      );
    }

    if (!ALLOWED_AUDIO_SIGNATURES.has(fileTypeResult.mime)) {
      logger.warn("[Voice STT API] File signature mismatch", {
        traceId,
        audioFileName: audioFile.name,
        claimedMimeType: baseMimeType,
        actualMimeType: fileTypeResult.mime,
      });
      return json(
        {
          error: `File content does not match the declared format. Detected: ${fileTypeResult.mime}, Expected audio format.`,
        },
        400,
      );
    }

    let finalMimeType = fileTypeResult.mime;
    if (fileTypeResult.mime === "video/webm") {
      logger.info(
        "[Voice STT API] Converting video/webm container to audio/webm",
        {
          traceId,
        },
      );
      finalMimeType = "audio/webm";
    }

    logger.info("[Voice STT API] Processing audio", {
      traceId,
      userId: user.id,
      audioFileName: audioFile.name,
      audioSizeBytes: audioFile.size,
      verifiedMimeType: fileTypeResult.mime,
      finalMimeType,
    });

    // -------------------------------------------------------------------------
    // Free default STT: self-hosted Whisper (OpenAI-compatible
    // `/v1/audio/transcriptions`). When WHISPER_STT_URL is set this is the
    // default — no credit reservation, no billing. ElevenLabs STT is the path
    // below. Inert when WHISPER_STT_URL is unset.
    // -------------------------------------------------------------------------
    const whisperBaseUrl = env.WHISPER_STT_URL?.trim();
    if (whisperBaseUrl) {
      const whisperStart = Date.now();
      const admissionMs = elapsedMs(routeStartMs);
      const form = new FormData();
      form.append(
        "file",
        new File([buffer], audioFile.name, { type: finalMimeType }),
      );
      const whisperModel = resolveWhisperSttModel(env.WHISPER_STT_MODEL);
      form.append("model", whisperModel);
      if (languageCode) form.append("language", languageCode);
      const whisperResponse = await fetch(
        `${whisperBaseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
        { method: "POST", body: form },
      );
      if (!whisperResponse.ok) {
        const transcribeMs = elapsedMs(whisperStart);
        logger.error("[Voice STT API] Whisper failed", {
          traceId,
          status: whisperResponse.status,
          transcribeMs,
        });
        return json({ error: "Speech-to-text failed" }, 502, [
          { name: "admission", durationMs: admissionMs },
          { name: "transcribe", durationMs: transcribeMs },
          { name: "provider", durationMs: transcribeMs },
          { name: "error", durationMs: transcribeMs },
        ]);
      }
      const whisperJson = (await whisperResponse.json()) as { text?: string };
      const transcript = (whisperJson.text ?? "").trim();
      const whisperDuration = Date.now() - whisperStart;
      logger.info("[Voice STT API] Whisper completed", {
        traceId,
        model: whisperModel,
        durationMs: whisperDuration,
        transcriptLength: transcript.length,
        billing: "free",
      });
      return json({ transcript, duration_ms: whisperDuration }, 200, [
        { name: "admission", durationMs: admissionMs },
        { name: "transcribe", durationMs: whisperDuration },
        { name: "provider", durationMs: whisperDuration },
      ]);
    }

    const metadata = await parseBuffer(buffer, { mimeType: finalMimeType });
    const parsedDurationSeconds = metadata.format?.duration;
    const durationSeconds = Number.isFinite(parsedDurationSeconds)
      ? Math.max(parsedDurationSeconds ?? 0, 1)
      : Math.max(
          estimateAudioDurationMinutes(audioFile.size, finalMimeType) * 60,
          1,
        );
    const estimatedDurationMinutes = durationSeconds / 60;
    const sttCost = await calculateSTTCostFromCatalog({
      model: "elevenlabs/scribe_v1",
      durationSeconds,
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        amount: sttCost.totalCost,
        userId: user.id,
        description: `STT transcription: ~${estimatedDurationMinutes.toFixed(1)} min`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return json(
          {
            error: "Insufficient credits for speech-to-text",
            required: error.required,
          },
          402,
        );
      }
      throw error;
    }

    const elevenlabs = getElevenLabsService(env);

    const startTime = Date.now();
    const admissionMs = elapsedMs(routeStartMs);
    const validatedFile = new File([buffer], audioFile.name, {
      type: finalMimeType,
    });
    const transcript = await elevenlabs.speechToText({
      audioFile: validatedFile,
      languageCode,
    });
    const duration = Date.now() - startTime;

    const billing = await billFlatUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId: apiKey?.id ?? null,
        model: "elevenlabs/scribe_v1",
        provider: "elevenlabs",
        billingSource: "elevenlabs",
        // Affiliate revenue-share via X-Affiliate-Code (existing billFlatUsage branch).
        affiliateCode: request.headers.get("X-Affiliate-Code"),
        description: `STT transcription: ${estimatedDurationMinutes.toFixed(2)} min`,
      },
      sttCost,
      reservation,
    );

    logger.info("[Voice STT API] Completed", {
      traceId,
      durationMs: duration,
      transcriptLength: transcript.length,
    });

    (async () => {
      try {
        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id ?? null,
          type: "stt",
          model: "elevenlabs-stt",
          provider: "elevenlabs",
          input_tokens: 0,
          output_tokens: transcript.length,
          input_cost: String(billing.totalCost),
          output_cost: String(0),
          markup: String(billing.platformMarkup),
          duration_ms: duration,
          is_successful: true,
          metadata: {
            audioFileName: audioFile.name,
            audioSizeBytes: audioFile.size,
            estimatedDurationMinutes,
            durationSeconds,
            languageCode,
            transcriptLength: transcript.length,
            baseTotalCost: billing.baseTotalCost,
            billingSource: "elevenlabs",
          },
        });
      } catch (error) {
        logger.error("[Voice STT API] Failed to create usage record", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return json({ transcript, duration_ms: duration }, 200, [
      { name: "admission", durationMs: admissionMs },
      { name: "transcribe", durationMs: duration },
      { name: "provider", durationMs: duration },
    ]);
  } catch (error) {
    logger.error("[Voice STT API] Error", {
      traceId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[Voice STT API] Refunded credits after error", { traceId });
    }

    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      const errorWithBody = error as Error & {
        body?: { detail?: { message?: string } };
        statusCode?: number;
      };
      const errorBody = errorWithBody.body?.detail?.message || "";

      if (
        errorMessage.includes("invalid or expired api key") ||
        errorMessage.includes("invalid or expired token") ||
        errorMessage.includes("api key is inactive") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("authentication required") ||
        errorMessage.includes("forbidden")
      ) {
        return json({ error: "Unauthorized" }, 401);
      }

      if (errorMessage.includes("rate limit")) {
        return json(
          { error: "Rate limit exceeded. Please try again in a moment." },
          429,
        );
      }

      if (errorMessage.includes("quota") || errorWithBody.statusCode === 403) {
        if (
          errorBody.includes("enterprise") ||
          errorBody.includes("trial tier") ||
          errorBody.includes("ZRM mode")
        ) {
          return json(
            {
              error:
                "Speech-to-Text requires a paid plan. Please upgrade to continue.",
            },
            402,
          );
        }
        return json(
          {
            error:
              "Speech-to-text service is temporarily unavailable due to high demand. Please try again shortly.",
            type: "service_unavailable",
            retryAfter: "5 minutes",
          },
          503,
        );
      }

      if (errorMessage.includes("elevenlabs_api_key")) {
        return json({ error: "Service not configured" }, 500);
      }
    }

    return json(
      { error: "Failed to transcribe audio. Please try again." },
      500,
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw, c.env));
export default __hono_app;

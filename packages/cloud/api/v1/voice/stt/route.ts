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
import { resolveWhisperSttModel } from "./whisper-model";
import {
  parseWhisperTimestamps,
  type SttTimedSpan,
} from "./whisper-timestamps";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const DEEPGRAM_PRERECORDED_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_PRERECORDED_MODEL = "nova-3";
const STT_PRICING_PROXY_MODEL = "elevenlabs/scribe_v1";

const SUPPORTED_MIME_TYPES = [
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  // Windows clients (and Bun's multipart layer) commonly declare WAV as the
  // legacy x- form; the magic-number allowlist below already accepts it.
  "audio/x-wav",
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

interface DeepgramTranscription {
  transcript: string;
  segments?: SttTimedSpan[];
  words?: SttTimedSpan[];
}

interface SttBillingEstimate {
  durationSeconds: number;
  estimatedDurationMinutes: number;
}

function deepgramSpan(
  text: unknown,
  start: unknown,
  end: unknown,
): SttTimedSpan | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) {
    return null;
  }
  if (typeof end !== "number" || !Number.isFinite(end) || end < start) {
    return null;
  }
  return {
    text: text.trim(),
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  };
}

function parseDeepgramArray(
  value: unknown,
  textKey: "transcript" | "word",
): { spans: SttTimedSpan[]; invalid: boolean } {
  if (value === undefined) return { spans: [], invalid: false };
  if (!Array.isArray(value)) return { spans: [], invalid: true };

  const spans: SttTimedSpan[] = [];
  let invalid = false;
  for (const entry of value) {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : null;
    const span = row ? deepgramSpan(row[textKey], row.start, row.end) : null;
    if (span) {
      spans.push(span);
    } else {
      invalid = true;
    }
  }
  return { spans, invalid };
}

function parseDeepgramTranscription(
  payload: unknown,
): DeepgramTranscription | null {
  const root =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const results =
    root?.results &&
    typeof root.results === "object" &&
    !Array.isArray(root.results)
      ? (root.results as Record<string, unknown>)
      : null;
  const channels = Array.isArray(results?.channels)
    ? results.channels
    : undefined;
  const firstChannel =
    channels?.[0] &&
    typeof channels[0] === "object" &&
    !Array.isArray(channels[0])
      ? (channels[0] as Record<string, unknown>)
      : null;
  const alternatives = Array.isArray(firstChannel?.alternatives)
    ? firstChannel.alternatives
    : undefined;
  const firstAlternative =
    alternatives?.[0] &&
    typeof alternatives[0] === "object" &&
    !Array.isArray(alternatives[0])
      ? (alternatives[0] as Record<string, unknown>)
      : null;
  if (!firstAlternative || typeof firstAlternative.transcript !== "string") {
    return null;
  }

  const transcript = firstAlternative.transcript.trim();
  const words = parseDeepgramArray(firstAlternative.words, "word");
  const segments = parseDeepgramArray(results?.utterances, "transcript");
  if (words.invalid || segments.invalid) return null;

  return {
    transcript,
    ...(segments.spans.length > 0 ? { segments: segments.spans } : {}),
    ...(words.spans.length > 0 ? { words: words.spans } : {}),
  };
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
  let reservation: CreditReservation | undefined;

  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json(
        { error: "Expected multipart form data with audio field" },
        { status: 400 },
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const languageCodeValue = formData.get("languageCode");
    const languageCode =
      typeof languageCodeValue === "string" && languageCodeValue.trim()
        ? languageCodeValue.trim()
        : undefined;

    if (!audioFile) {
      return Response.json(
        { error: "No audio file provided" },
        { status: 400 },
      );
    }

    if (audioFile.size > MAX_FILE_SIZE) {
      return Response.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        { status: 400 },
      );
    }

    const baseMimeType = audioFile.type.split(";")[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(baseMimeType)) {
      return Response.json(
        {
          error: `Unsupported audio format: ${audioFile.type}. Supported: mp3, mp4, m4a, wav, webm, ogg`,
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const fileTypeResult = await fileTypeFromBuffer(buffer);

    if (!fileTypeResult) {
      logger.warn("[Voice STT API] Unable to detect audio file type", {
        audioSizeBytes: audioFile.size,
      });
      return Response.json(
        {
          error:
            "Unable to verify file type. The file may be corrupted or of an unsupported format.",
        },
        { status: 400 },
      );
    }

    if (!ALLOWED_AUDIO_SIGNATURES.has(fileTypeResult.mime)) {
      logger.warn("[Voice STT API] Audio file signature mismatch", {
        actualMimeType: fileTypeResult.mime,
        claimedMimeType: baseMimeType,
      });
      return Response.json(
        {
          error: `File content does not match the declared format. Detected: ${fileTypeResult.mime}, Expected audio format.`,
        },
        { status: 400 },
      );
    }

    let finalMimeType = fileTypeResult.mime;
    if (fileTypeResult.mime === "video/webm") {
      logger.info(
        "[Voice STT API] Converting video/webm container to audio/webm (Safari/macOS audio recording)",
      );
      finalMimeType = "audio/webm";
    }

    logger.info("[Voice STT API] Processing verified audio", {
      audioSizeBytes: audioFile.size,
      finalMimeType,
      userId: user.id,
      verifiedMimeType: fileTypeResult.mime,
    });

    let billingEstimate: SttBillingEstimate | undefined;
    const getBillingEstimate = async (): Promise<SttBillingEstimate> => {
      if (billingEstimate) return billingEstimate;
      const metadata = await parseBuffer(buffer, { mimeType: finalMimeType });
      const parsedDurationSeconds = metadata.format?.duration;
      const durationSeconds = Number.isFinite(parsedDurationSeconds)
        ? Math.max(parsedDurationSeconds ?? 0, 1)
        : Math.max(
            estimateAudioDurationMinutes(audioFile.size, finalMimeType) * 60,
            1,
          );
      billingEstimate = {
        durationSeconds,
        estimatedDurationMinutes: durationSeconds / 60,
      };
      return billingEstimate;
    };

    const reserveOr402 = async (
      estimate: SttBillingEstimate,
      sttCost: Awaited<ReturnType<typeof calculateSTTCostFromCatalog>>,
    ): Promise<Response | CreditReservation> => {
      try {
        return await creditsService.reserve({
          organizationId: user.organization_id,
          amount: sttCost.totalCost,
          userId: user.id,
          description: `STT transcription: ~${estimate.estimatedDurationMinutes.toFixed(1)} min`,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return Response.json(
            {
              error: "Insufficient credits for speech-to-text",
              required: error.required,
            },
            { status: 402 },
          );
        }
        throw error;
      }
    };

    const batchSttProvider = env.VOICE_BATCH_STT_PROVIDER?.trim().toLowerCase();
    const deepgramApiKey = env.DEEPGRAM_API_KEY?.trim();
    if (batchSttProvider === "deepgram" && !deepgramApiKey) {
      logger.error(
        "[Voice STT API] Deepgram batch provider selected but not configured",
      );
      return Response.json(
        { error: "Speech-to-text service is not configured" },
        { status: 503 },
      );
    }
    // Deepgram prerecorded is opt-in because the same key also powers realtime
    // Flux sessions. Key presence alone must not silently move every paid batch
    // transcription onto Deepgram in production without an explicit rollout.
    if (batchSttProvider === "deepgram" && deepgramApiKey) {
      const estimate = await getBillingEstimate();
      const sttCost = await calculateSTTCostFromCatalog({
        model: STT_PRICING_PROXY_MODEL,
        durationSeconds: estimate.durationSeconds,
      });
      const deepgramReservation = await reserveOr402(estimate, sttCost);
      if (deepgramReservation instanceof Response) return deepgramReservation;
      reservation = deepgramReservation;

      const refundDeepgramReservation = async () => {
        if (!reservation) return;
        await reservation.reconcile(0);
        reservation = undefined;
      };

      const deepgramStart = Date.now();
      const deepgramUrl = new URL(DEEPGRAM_PRERECORDED_URL);
      deepgramUrl.searchParams.set("model", DEEPGRAM_PRERECORDED_MODEL);
      deepgramUrl.searchParams.set("smart_format", "true");
      deepgramUrl.searchParams.set("utterances", "true");
      deepgramUrl.searchParams.set("words", "true");
      if (languageCode) deepgramUrl.searchParams.set("language", languageCode);

      let deepgramResponse: Response;
      try {
        deepgramResponse = await fetch(deepgramUrl, {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramApiKey}`,
            "Content-Type": finalMimeType,
          },
          body: buffer,
        });
      } catch (error) {
        // error-policy:J1 provider transport failures translate at the route boundary.
        await refundDeepgramReservation();
        logger.error("[Voice STT API] Deepgram request failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }
      if (!deepgramResponse.ok) {
        await deepgramResponse.body?.cancel().catch(() => {
          // error-policy:J6 response-body drain is best-effort after upstream failure.
          return undefined;
        });
        await refundDeepgramReservation();
        logger.error("[Voice STT API] Deepgram request failed", {
          status: deepgramResponse.status,
        });
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      let deepgramPayload: unknown;
      try {
        deepgramPayload = await deepgramResponse.json();
      } catch {
        // error-policy:J3 provider JSON is untrusted input at the HTTP boundary.
        await refundDeepgramReservation();
        logger.error("[Voice STT API] Deepgram returned unparseable JSON");
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      const transcription = parseDeepgramTranscription(deepgramPayload);
      if (!transcription) {
        await refundDeepgramReservation();
        logger.error("[Voice STT API] Deepgram returned a malformed payload");
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      const deepgramDuration = Date.now() - deepgramStart;
      const billing = await billFlatUsage(
        {
          organizationId: user.organization_id,
          userId: user.id,
          apiKeyId: apiKey?.id ?? null,
          model: DEEPGRAM_PRERECORDED_MODEL,
          provider: "deepgram",
          billingSource: "elevenlabs",
          affiliateCode: request.headers.get("X-Affiliate-Code"),
          description: `STT transcription: ${estimate.estimatedDurationMinutes.toFixed(2)} min`,
          metadata: {
            pricingProxyProvider: "elevenlabs",
            pricingProxyModel: STT_PRICING_PROXY_MODEL,
          },
        },
        sttCost,
        reservation,
      );
      reservation = undefined;

      logger.info("[Voice STT API] Deepgram completed", {
        billing: "paid",
        durationMs: deepgramDuration,
        model: DEEPGRAM_PRERECORDED_MODEL,
        pricingProxyModel: STT_PRICING_PROXY_MODEL,
        provider: "deepgram",
        segmentCount: transcription.segments?.length,
        transcriptLength: transcription.transcript.length,
        wordCount: transcription.words?.length,
      });
      (async () => {
        try {
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id ?? null,
            type: "stt",
            model: DEEPGRAM_PRERECORDED_MODEL,
            provider: "deepgram",
            input_tokens: 0,
            output_tokens: transcription.transcript.length,
            input_cost: String(billing.totalCost),
            output_cost: String(0),
            markup: String(billing.platformMarkup),
            duration_ms: deepgramDuration,
            is_successful: true,
            metadata: {
              audioSizeBytes: audioFile.size,
              estimatedDurationMinutes: estimate.estimatedDurationMinutes,
              durationSeconds: estimate.durationSeconds,
              languageCode,
              transcriptLength: transcription.transcript.length,
              baseTotalCost: billing.baseTotalCost,
              billingSource: "elevenlabs",
              pricingProxyProvider: "elevenlabs",
              pricingProxyModel: STT_PRICING_PROXY_MODEL,
              provider: "deepgram",
              model: DEEPGRAM_PRERECORDED_MODEL,
            },
          });
        } catch (error) {
          logger.error("[Voice STT API] Failed to create usage record", {
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
      })();

      return Response.json({
        transcript: transcription.transcript,
        duration_ms: deepgramDuration,
        ...(transcription.segments ? { segments: transcription.segments } : {}),
        ...(transcription.words ? { words: transcription.words } : {}),
      });
    }

    // -------------------------------------------------------------------------
    // Free default STT: self-hosted Whisper (OpenAI-compatible
    // `/v1/audio/transcriptions`). When WHISPER_STT_URL is set this is the
    // default — no credit reservation, no billing. ElevenLabs STT is the path
    // below. Inert when WHISPER_STT_URL is unset.
    // -------------------------------------------------------------------------
    const whisperBaseUrl = env.WHISPER_STT_URL?.trim();
    if (whisperBaseUrl) {
      const whisperStart = Date.now();
      const form = new FormData();
      form.append(
        "file",
        new File([buffer], audioFile.name, { type: finalMimeType }),
      );
      const whisperModel = resolveWhisperSttModel(env.WHISPER_STT_MODEL);
      form.append("model", whisperModel);
      if (languageCode) form.append("language", languageCode);
      // verbose_json + word/segment granularities (#14806): downstream
      // consumers (transcript fragments, PII audio redaction) need ms spans,
      // and a server that ignores these OpenAI-spec fields still returns
      // `text`, so the plain-transcript contract is unchanged.
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      const whisperResponse = await fetch(
        `${whisperBaseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
        { method: "POST", body: form },
      );
      if (!whisperResponse.ok) {
        await whisperResponse.body?.cancel().catch(() => undefined);
        logger.error("[Voice STT API] Whisper request failed", {
          status: whisperResponse.status,
        });
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }
      // Boundary validation (J3): a 200 whose body is not JSON, not an object,
      // or lacks the required `text` string is an upstream failure — translate
      // it to a structured 502, never a healthy empty transcript.
      let whisperPayload: unknown;
      try {
        whisperPayload = await whisperResponse.json();
      } catch {
        logger.error("[Voice STT API] Whisper returned unparseable JSON");
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }
      const whisperRecord =
        whisperPayload !== null &&
        typeof whisperPayload === "object" &&
        !Array.isArray(whisperPayload)
          ? (whisperPayload as Record<string, unknown>)
          : null;
      if (!whisperRecord || typeof whisperRecord.text !== "string") {
        logger.error(
          `[Voice STT API] Whisper returned a malformed transcription payload (${whisperRecord ? "missing text field" : "non-object body"})`,
        );
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }
      const transcript = whisperRecord.text.trim();
      const { segments, words, invalidFields } =
        parseWhisperTimestamps(whisperRecord);
      if (invalidFields.length > 0) {
        logger.error("[Voice STT API] Whisper returned malformed timestamps", {
          invalidFields,
          model: whisperModel,
        });
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }
      const whisperDuration = Date.now() - whisperStart;
      // "timestamps absent" (plain-text response shape) and "zero timed spans"
      // are different states — log them distinguishably.
      logger.info("[Voice STT API] Whisper completed", {
        billing: "free",
        durationMs: whisperDuration,
        model: whisperModel,
        segmentCount: segments?.length,
        transcriptLength: transcript.length,
        wordCount: words?.length,
      });
      return Response.json({
        transcript,
        duration_ms: whisperDuration,
        ...(segments ? { segments } : {}),
        ...(words ? { words } : {}),
      });
    }

    const { durationSeconds, estimatedDurationMinutes } =
      await getBillingEstimate();
    const sttCost = await calculateSTTCostFromCatalog({
      model: STT_PRICING_PROXY_MODEL,
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
        return Response.json(
          {
            error: "Insufficient credits for speech-to-text",
            required: error.required,
          },
          { status: 402 },
        );
      }
      throw error;
    }

    const elevenlabs = getElevenLabsService(env);

    const startTime = Date.now();
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
            // audioFileName removed: user-supplied filenames can carry PII
            // (e.g. "john-therapy-session.wav"). languageCode is a BCP-47 enum,
            // not sensitive content, so it stays.
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
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    })();

    return Response.json({
      transcript,
      duration_ms: duration,
    });
  } catch (error) {
    // Redaction boundary: provider SDK errors can embed request/response
    // bodies (transcripts, tokens) in their message — log only the error type.
    logger.error("[Voice STT API] Request failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });

    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[Voice STT API] Refunded credits after error");
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
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (errorMessage.includes("rate limit")) {
        return Response.json(
          { error: "Rate limit exceeded. Please try again in a moment." },
          { status: 429 },
        );
      }

      if (errorMessage.includes("quota") || errorWithBody.statusCode === 403) {
        if (
          errorBody.includes("enterprise") ||
          errorBody.includes("trial tier") ||
          errorBody.includes("ZRM mode")
        ) {
          return Response.json(
            {
              error:
                "Speech-to-Text requires a paid plan. Please upgrade to continue.",
            },
            { status: 402 },
          );
        }
        return Response.json(
          {
            error:
              "Speech-to-text service is temporarily unavailable due to high demand. Please try again shortly.",
            type: "service_unavailable",
            retryAfter: "5 minutes",
          },
          { status: 503 },
        );
      }

      if (errorMessage.includes("elevenlabs_api_key")) {
        return Response.json(
          { error: "Service not configured" },
          { status: 500 },
        );
      }
    }

    return Response.json(
      { error: "Failed to transcribe audio. Please try again." },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw, c.env));
export default __hono_app;

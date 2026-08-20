/**
 * Cloud voice transcription route for multipart audio uploads. The request
 * body is size-gated before auth and multipart parsing so rejected uploads do
 * not spend provider, billing, or signature-parsing work.
 */
import { Hono } from "hono";

import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

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
import {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  getGenerativePricingCacheOptions,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { type BillingContext, billFlatUsage } from "@/lib/services/ai-billing";
import { calculateSTTCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  type CreditReservation,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import {
  calculateCartesiaSttCost,
  parseCartesiaUsdPerCredit,
} from "./cartesia-pricing";
import { resolveWhisperSttModel } from "./whisper-model";
import {
  parseWhisperTimestamps,
  type SttTimedSpan,
} from "./whisper-timestamps";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const DEEPGRAM_PRERECORDED_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_PRERECORDED_MODEL = "nova-3";
const CARTESIA_BATCH_STT_URL = "https://api.cartesia.ai/stt";
const CARTESIA_BATCH_STT_MODEL = "ink-whisper";
const CARTESIA_BATCH_STT_API_VERSION = "2026-03-01";
const DEFAULT_CARTESIA_BATCH_STT_TIMEOUT_MS = 120_000;
const MAX_CARTESIA_BATCH_STT_TIMEOUT_MS = 300_000;
const STT_PRICING_PROXY_MODEL = "elevenlabs/scribe_v1";
const DEFAULT_MAX_MULTIPART_BODY_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES_ENV = "VOICE_STT_MAX_MULTIPART_BYTES";
const OVERSIZED_MULTIPART_RESPONSE = {
  error: "STT multipart request body too large",
  maxBytes: DEFAULT_MAX_MULTIPART_BODY_BYTES,
};

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

interface CartesiaTranscription {
  durationSeconds: number;
  transcript: string;
  words?: SttTimedSpan[];
}

/**
 * Boundary validation (J3) for Cartesia's batch `/stt` response. Word entries
 * share Deepgram's `{word, start, end}` seconds shape, so the span parser is
 * reused; the batch endpoint emits no utterances/segments.
 */
function parseCartesiaTranscription(
  payload: unknown,
): CartesiaTranscription | null {
  const root =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (
    !root ||
    typeof root.text !== "string" ||
    typeof root.duration !== "number" ||
    !Number.isFinite(root.duration) ||
    root.duration <= 0
  ) {
    return null;
  }

  const words = parseDeepgramArray(root.words, "word");
  if (words.invalid) return null;

  return {
    durationSeconds: root.duration,
    transcript: root.text.trim(),
    ...(words.spans.length > 0 ? { words: words.spans } : {}),
  };
}

type BatchSttProvider = "cartesia" | "deepgram" | "elevenlabs" | "whisper";

function parseBatchSttProvider(
  value: string | undefined,
): BatchSttProvider | undefined {
  if (value === undefined) return undefined;
  const provider = value.trim().toLowerCase();
  if (
    provider === "cartesia" ||
    provider === "deepgram" ||
    provider === "elevenlabs" ||
    provider === "whisper"
  ) {
    return provider;
  }
  throw new Error("VOICE_BATCH_STT_PROVIDER is not a supported provider");
}

function parseCartesiaTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CARTESIA_BATCH_STT_TIMEOUT_MS;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_CARTESIA_BATCH_STT_TIMEOUT_MS
  ) {
    throw new Error(
      `CARTESIA_BATCH_STT_TIMEOUT_MS must be an integer from 1 to ${MAX_CARTESIA_BATCH_STT_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

function parseSttMultipartBodyLimit(env: AppEnv["Bindings"]): number {
  const configured = env.VOICE_STT_MAX_MULTIPART_BYTES;
  if (configured === undefined) {
    return DEFAULT_MAX_MULTIPART_BODY_BYTES;
  }

  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${MAX_MULTIPART_BODY_BYTES_ENV} must be a positive integer`,
    );
  }
  return parsed;
}

function oversizedMultipartResponse(maxBytes: number): Response {
  return Response.json(
    {
      ...OVERSIZED_MULTIPART_RESPONSE,
      maxBytes,
    },
    { status: 413 },
  );
}

function parseTrustworthyContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function headersForBufferedRequest(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return headers;
}

function cancelUploadBodyBestEffort(
  body: ReadableStream<Uint8Array>,
  label: string,
): void {
  const reportFailure = (error: unknown) => {
    // error-policy:J6 best-effort teardown for an upload already rejected.
    logger.warn("[Voice STT API] Failed to cancel oversized upload body", {
      errorType: error instanceof Error ? error.name : "unknown",
      label,
    });
  };
  try {
    body.cancel().catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

function cancelUploadReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  const reportFailure = (error: unknown) => {
    // error-policy:J6 best-effort teardown for an upload already rejected.
    logger.warn("[Voice STT API] Failed to cancel oversized upload reader", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  };
  try {
    reader.cancel().catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

async function readRequestWithMultipartLimit(
  request: Request,
  maxBytes: number,
): Promise<Request | Response> {
  const declaredLength = parseTrustworthyContentLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (request.body) {
      cancelUploadBodyBestEffort(request.body, "content-length-precheck");
    }
    return oversizedMultipartResponse(maxBytes);
  }

  const bufferedHeaders = headersForBufferedRequest(request);

  if (!request.body) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return oversizedMultipartResponse(maxBytes);
    }
    return new Request(request.url, {
      body: buffer,
      headers: bufferedHeaders,
      method: request.method,
    });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      cancelUploadReaderBestEffort(reader);
      return oversizedMultipartResponse(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request.url, {
    body,
    headers: bufferedHeaders,
    method: request.method,
  });
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
async function __hono_POST(c: AppContext) {
  let reservation: CreditReservation | undefined;
  let settleUnknown: (() => Promise<unknown>) | undefined;
  let request = c.req.raw;
  const env = c.env;

  try {
    let multipartBodyLimit: number;
    try {
      multipartBodyLimit = parseSttMultipartBodyLimit(env);
    } catch (error) {
      // error-policy:J1 boundary translation for pre-auth operator config.
      logger.error(
        "[Voice STT API] Invalid multipart body limit configuration",
        {
          errorType: error instanceof Error ? error.name : "unknown",
        },
      );
      return Response.json(
        { error: "Speech-to-text service is misconfigured" },
        { status: 500 },
      );
    }

    const sizeCheckedRequest = await readRequestWithMultipartLimit(
      request,
      multipartBodyLimit,
    );
    if (sizeCheckedRequest instanceof Response) {
      return sizeCheckedRequest;
    }
    request = sizeCheckedRequest;

    const { user, apiKeyId, admissionSnapshot } =
      await requireGenerativeRouteCaller(c, {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 1500,
      });
    const affiliateCode = request.headers.get("X-Affiliate-Code");
    const billingRequestId = `voice-stt:${crypto.randomUUID()}`;

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
      billingContext: BillingContext,
      sttCost: Awaited<ReturnType<typeof calculateSTTCostFromCatalog>>,
    ): Promise<
      Response | Awaited<ReturnType<typeof admitFlatGenerativeOperation>>
    > => {
      try {
        return await admitFlatGenerativeOperation({
          c,
          context: billingContext,
          apiKeyId,
          cost: sttCost,
          admissionSnapshot,
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

    let batchSttProvider: BatchSttProvider | undefined;
    try {
      batchSttProvider = parseBatchSttProvider(env.VOICE_BATCH_STT_PROVIDER);
    } catch {
      // error-policy:J1 invalid deployment configuration fails closed at the route boundary.
      logger.error("[Voice STT API] Invalid batch provider configuration");
      return Response.json(
        { error: "Speech-to-text service is not configured" },
        { status: 503 },
      );
    }
    const deepgramApiKey = env.DEEPGRAM_API_KEY?.trim();
    const cartesiaApiKey = env.CARTESIA_API_KEY?.trim();
    if (batchSttProvider === "deepgram" && !deepgramApiKey) {
      logger.error(
        "[Voice STT API] Deepgram batch provider selected but not configured",
      );
      return Response.json(
        { error: "Speech-to-text service is not configured" },
        { status: 503 },
      );
    }
    // Explicit overrides fail closed (SEC): a pinned provider must never
    // silently degrade to a different upstream because its binding is absent.
    if (batchSttProvider === "cartesia" && !cartesiaApiKey) {
      logger.error(
        "[Voice STT API] Cartesia batch provider selected but not configured",
      );
      return Response.json(
        { error: "Speech-to-text service is not configured" },
        { status: 503 },
      );
    }
    if (batchSttProvider === "whisper" && !env.WHISPER_STT_URL?.trim()) {
      logger.error(
        "[Voice STT API] Whisper batch provider selected but not configured",
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
        ...(getGenerativePricingCacheOptions(c).cacheOnly
          ? { cache: getGenerativePricingCacheOptions(c) }
          : {}),
      });
      const deepgramBillingContext: BillingContext = {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId,
        model: DEEPGRAM_PRERECORDED_MODEL,
        provider: "deepgram",
        billingSource: "elevenlabs",
        requestId: billingRequestId,
        affiliateCode,
        description: `STT transcription: ${estimate.estimatedDurationMinutes.toFixed(2)} min`,
        metadata: {
          pricingProxyProvider: "elevenlabs",
          pricingProxyModel: STT_PRICING_PROXY_MODEL,
        },
      };
      const deepgramReservation = await reserveOr402(
        deepgramBillingContext,
        sttCost,
      );
      if (deepgramReservation instanceof Response) return deepgramReservation;
      reservation = deepgramReservation.reservation;
      settleUnknown = deepgramReservation.settleUnknown;

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
        await deepgramReservation.markProviderDispatched?.();
        // Bound the upstream STT hop so a stalled Deepgram API cannot hang
        // the request path while the credit reservation is held.
        deepgramResponse = await fetch(deepgramUrl, {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramApiKey}`,
            "Content-Type": finalMimeType,
          },
          body: buffer,
          signal: AbortSignal.timeout(30_000),
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
      const billingReservation = reservation;
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
      let billingApplied = false;
      const billingTask = (async () => {
        try {
          const billing = await billFlatUsage(
            deepgramBillingContext,
            sttCost,
            billingReservation,
          );
          billingApplied = true;
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKeyId,
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
          if (!billingApplied) await settleUnknown?.();
          // error-policy:J7 billing persistence is detached from transcript
          // latency; conservative settlement remains observable on failure.
          logger.error("[Voice STT API] Failed to create usage record", {
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
      })();
      const executionCtx = getGenerativeExecutionContext(c);
      if (executionCtx) executionCtx.waitUntil(billingTask);
      else void billingTask;

      return Response.json({
        transcript: transcription.transcript,
        duration_ms: deepgramDuration,
        ...(transcription.segments ? { segments: transcription.segments } : {}),
        ...(transcription.words ? { words: transcription.words } : {}),
      });
    }

    // -------------------------------------------------------------------------
    // Cartesia batch lane: prerecorded transcription on Cartesia's batch `/stt`
    // endpoint (ink-whisper). Opt-in via VOICE_BATCH_STT_PROVIDER=cartesia, for
    // the same two reasons the Deepgram lane above is opt-in: CARTESIA_API_KEY
    // also powers realtime Ink sessions, so key presence alone must not move
    // every batch transcription onto a paid upstream without an explicit
    // rollout — and unlike TTS, batch STT has a *free* default today
    // (WHISPER_STT_URL), so an un-pinned flip would silently convert working
    // zero-credit transcription into 402s.
    // -------------------------------------------------------------------------
    if (cartesiaApiKey && batchSttProvider === "cartesia") {
      const estimate = await getBillingEstimate();
      let cartesiaUsdPerCredit: number;
      let cartesiaTimeoutMs: number;
      try {
        cartesiaUsdPerCredit = parseCartesiaUsdPerCredit(
          env.CARTESIA_STT_USD_PER_CREDIT,
        );
        cartesiaTimeoutMs = parseCartesiaTimeoutMs(
          env.CARTESIA_BATCH_STT_TIMEOUT_MS,
        );
      } catch {
        // error-policy:J1 invalid deployment configuration fails closed at the route boundary.
        logger.error("[Voice STT API] Invalid Cartesia batch configuration");
        return Response.json(
          { error: "Speech-to-text service is not configured" },
          { status: 503 },
        );
      }
      const estimatedSttCost = calculateCartesiaSttCost({
        durationSeconds: estimate.durationSeconds,
        usdPerCredit: cartesiaUsdPerCredit,
      });
      const cartesiaBillingContext: BillingContext = {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId,
        model: CARTESIA_BATCH_STT_MODEL,
        provider: "cartesia",
        billingSource: "cartesia",
        requestId: billingRequestId,
        affiliateCode,
        description: `STT transcription: ${estimate.estimatedDurationMinutes.toFixed(2)} min`,
        metadata: { pricingSource: "cartesia_account_credit_rate" },
      };
      const cartesiaAdmission = await reserveOr402(
        cartesiaBillingContext,
        estimatedSttCost,
      );
      if (cartesiaAdmission instanceof Response) return cartesiaAdmission;
      reservation = cartesiaAdmission.reservation;
      settleUnknown = cartesiaAdmission.settleUnknown;

      const refundCartesiaReservation = async () => {
        if (!reservation) return;
        await reservation.reconcile(0);
        reservation = undefined;
      };

      const cartesiaStart = Date.now();
      const cartesiaForm = new FormData();
      cartesiaForm.append(
        "file",
        new File([buffer], audioFile.name, { type: finalMimeType }),
      );
      cartesiaForm.append("model", CARTESIA_BATCH_STT_MODEL);
      // Cartesia batch STT accepts ISO-639-1 languages; callers may send
      // BCP-47 region tags (en-US), so only the primary subtag is forwarded.
      if (languageCode) {
        cartesiaForm.append(
          "language",
          languageCode.split("-")[0].toLowerCase(),
        );
      }
      cartesiaForm.append("timestamp_granularities[]", "word");

      const cartesiaTimeoutSignal = AbortSignal.timeout(cartesiaTimeoutMs);
      let cartesiaResponse: Response;
      try {
        await cartesiaAdmission.markProviderDispatched?.();
        cartesiaResponse = await fetch(CARTESIA_BATCH_STT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cartesiaApiKey}`,
            "Cartesia-Version": CARTESIA_BATCH_STT_API_VERSION,
          },
          body: cartesiaForm,
          signal: cartesiaTimeoutSignal,
        });
      } catch (error) {
        // error-policy:J1 provider transport failures translate at the route boundary.
        await refundCartesiaReservation();
        logger.error("[Voice STT API] Cartesia request failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        return Response.json(
          {
            error: timedOut
              ? "Speech-to-text timed out"
              : "Speech-to-text failed",
          },
          { status: timedOut ? 504 : 502 },
        );
      }
      if (!cartesiaResponse.ok) {
        await cartesiaResponse.body?.cancel().catch(() => {
          // error-policy:J6 response-body drain is best-effort after upstream failure.
          return undefined;
        });
        await refundCartesiaReservation();
        logger.error("[Voice STT API] Cartesia request failed", {
          status: cartesiaResponse.status,
        });
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      let cartesiaPayload: unknown;
      try {
        cartesiaPayload = await cartesiaResponse.json();
      } catch {
        // error-policy:J3 provider JSON is untrusted input at the HTTP boundary.
        await refundCartesiaReservation();
        if (cartesiaTimeoutSignal.aborted) {
          logger.error("[Voice STT API] Cartesia response body timed out");
          return Response.json(
            { error: "Speech-to-text timed out" },
            { status: 504 },
          );
        }
        logger.error("[Voice STT API] Cartesia returned unparseable JSON");
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      const transcription = parseCartesiaTranscription(cartesiaPayload);
      if (!transcription) {
        await refundCartesiaReservation();
        logger.error("[Voice STT API] Cartesia returned a malformed payload");
        return Response.json(
          { error: "Speech-to-text failed" },
          { status: 502 },
        );
      }

      const cartesiaDuration = Date.now() - cartesiaStart;
      const actualSttCost = calculateCartesiaSttCost({
        durationSeconds: transcription.durationSeconds,
        usdPerCredit: cartesiaUsdPerCredit,
      });
      const billingReservation = reservation;
      reservation = undefined;

      logger.info("[Voice STT API] Cartesia completed", {
        billing: "paid",
        durationMs: cartesiaDuration,
        model: CARTESIA_BATCH_STT_MODEL,
        provider: "cartesia",
        transcriptionDurationSeconds: transcription.durationSeconds,
        transcriptLength: transcription.transcript.length,
        wordCount: transcription.words?.length,
      });
      let billingApplied = false;
      const billingTask = (async () => {
        try {
          const billing = await billFlatUsage(
            cartesiaBillingContext,
            actualSttCost,
            billingReservation,
          );
          billingApplied = true;
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKeyId,
            type: "stt",
            model: CARTESIA_BATCH_STT_MODEL,
            provider: "cartesia",
            input_tokens: 0,
            output_tokens: transcription.transcript.length,
            input_cost: String(billing.totalCost),
            output_cost: String(0),
            markup: String(billing.platformMarkup),
            duration_ms: cartesiaDuration,
            is_successful: true,
            metadata: {
              audioSizeBytes: audioFile.size,
              estimatedDurationMinutes: estimate.estimatedDurationMinutes,
              estimatedDurationSeconds: estimate.durationSeconds,
              durationSeconds: transcription.durationSeconds,
              languageCode,
              transcriptLength: transcription.transcript.length,
              baseTotalCost: billing.baseTotalCost,
              billingSource: "cartesia",
              pricingSource: "cartesia_account_credit_rate",
              provider: "cartesia",
              model: CARTESIA_BATCH_STT_MODEL,
            },
          });
        } catch (error) {
          if (!billingApplied) await settleUnknown?.();
          // error-policy:J7 billing persistence is detached from transcript
          // latency; conservative settlement remains observable on failure.
          logger.error("[Voice STT API] Failed to create usage record", {
            errorType: error instanceof Error ? error.name : "unknown",
          });
        }
      })();
      const executionCtx = getGenerativeExecutionContext(c);
      if (executionCtx) executionCtx.waitUntil(billingTask);
      else void billingTask;

      return Response.json({
        transcript: transcription.transcript,
        duration_ms: cartesiaDuration,
        ...(transcription.words ? { words: transcription.words } : {}),
      });
    }

    // -------------------------------------------------------------------------
    // Free default STT: self-hosted Whisper (OpenAI-compatible
    // `/v1/audio/transcriptions`). When WHISPER_STT_URL is set this remains the
    // un-pinned default — no credit reservation, no billing. ElevenLabs STT is
    // the path below. Inert when WHISPER_STT_URL is unset or the operator
    // pinned `elevenlabs`.
    // -------------------------------------------------------------------------
    const whisperBaseUrl = env.WHISPER_STT_URL?.trim();
    if (whisperBaseUrl && batchSttProvider !== "elevenlabs") {
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
        {
          method: "POST",
          body: form,
          // Bound the upstream STT hop so a stalled Whisper server cannot
          // hang the request path.
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!whisperResponse.ok) {
        await whisperResponse.body?.cancel().catch((cancelError) => {
          // error-policy:J6 response-body drain is best-effort after upstream failure.
          logger.warn(
            "[Voice STT API] Failed to cancel Whisper response body",
            {
              errorType:
                cancelError instanceof Error ? cancelError.name : "unknown",
            },
          );
        });
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
      ...(getGenerativePricingCacheOptions(c).cacheOnly
        ? { cache: getGenerativePricingCacheOptions(c) }
        : {}),
    });
    const elevenLabsBillingContext: BillingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId,
      model: "elevenlabs/scribe_v1",
      provider: "elevenlabs",
      billingSource: "elevenlabs",
      requestId: billingRequestId,
      affiliateCode,
      description: `STT transcription: ${estimatedDurationMinutes.toFixed(2)} min`,
    };

    try {
      const admission = await admitFlatGenerativeOperation({
        c,
        context: elevenLabsBillingContext,
        apiKeyId,
        cost: sttCost,
        admissionSnapshot,
      });
      reservation = admission.reservation;
      settleUnknown = admission.settleUnknown;
      await admission.markProviderDispatched?.();
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

    const billingReservation = reservation;
    reservation = undefined;

    logger.info("[Voice STT API] Completed", {
      durationMs: duration,
      transcriptLength: transcript.length,
    });

    let billingApplied = false;
    const billingTask = (async () => {
      try {
        const billing = await billFlatUsage(
          elevenLabsBillingContext,
          sttCost,
          billingReservation,
        );
        billingApplied = true;
        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKeyId,
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
        if (!billingApplied) await settleUnknown?.();
        // error-policy:J7 billing persistence is detached from transcript
        // latency; conservative settlement remains observable on failure.
        logger.error("[Voice STT API] Failed to create usage record", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    })();
    const executionCtx = getGenerativeExecutionContext(c);
    if (executionCtx) executionCtx.waitUntil(billingTask);
    else void billingTask;

    return Response.json({
      transcript,
      duration_ms: duration,
    });
  } catch (error) {
    // error-policy:J1 translate provider, billing, and validation failures at
    // the authenticated HTTP boundary without leaking provider response data.
    // Redaction boundary: provider SDK errors can embed request/response
    // bodies (transcripts, tokens) in their message — log only the error type.
    logger.error("[Voice STT API] Request failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });

    if (reservation) {
      const release = reservation.reconcile(0);
      const executionCtx = getGenerativeExecutionContext(c);
      if (executionCtx) executionCtx.waitUntil(release);
      else await release;
      logger.info("[Voice STT API] Released credits after error");
    }

    const apiError =
      error instanceof ApiError ? error : asGenerativeCacheApiError(error);
    if (apiError) {
      const serialized =
        "toJSON" in apiError && typeof apiError.toJSON === "function"
          ? apiError.toJSON()
          : { error: apiError.message };
      return Response.json(serialized, { status: apiError.status ?? 500 });
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
__hono_app.post("/", __hono_POST);
export default __hono_app;

/**
 * Voice STT API (v1)
 *
 * POST /api/v1/voice/stt
 * Converts speech to text using the voice transcription service.
 * Supports both Privy session and API key authentication.
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

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { usageService } from "@/lib/services/usage";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { calculateSTTCost } from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import { fileTypeFromBuffer } from "file-type";

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
export async function POST(request: NextRequest) {
  let reservation: CreditReservation | undefined;

  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const languageCode = formData.get("languageCode") as string | undefined;

    if (!audioFile) {
      return NextResponse.json(
        { error: "No audio file provided" },
        { status: 400 },
      );
    }

    if (audioFile.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        { status: 400 },
      );
    }

    const baseMimeType = audioFile.type.split(";")[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(baseMimeType)) {
      return NextResponse.json(
        {
          error: `Unsupported audio format: ${audioFile.type}. Supported: mp3, mp4, m4a, wav, webm, ogg`,
        },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const fileTypeResult = await fileTypeFromBuffer(buffer);

    if (!fileTypeResult) {
      logger.warn(
        `[Voice STT API] Unable to detect file type for ${audioFile.name} - rejecting`,
      );
      return NextResponse.json(
        {
          error:
            "Unable to verify file type. The file may be corrupted or of an unsupported format.",
        },
        { status: 400 },
      );
    }

    if (!ALLOWED_AUDIO_SIGNATURES.has(fileTypeResult.mime)) {
      logger.warn(
        `[Voice STT API] File signature mismatch for ${audioFile.name}: claimed=${baseMimeType}, actual=${fileTypeResult.mime}`,
      );
      return NextResponse.json(
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

    logger.info(
      `[Voice STT API] Processing for user ${user.id}: ${audioFile.name} (${audioFile.size} bytes, verified: ${fileTypeResult.mime}, final: ${finalMimeType})`,
    );

    const estimatedDurationMinutes = estimateAudioDurationMinutes(
      audioFile.size,
      finalMimeType,
    );
    const estimatedCost = calculateSTTCost(estimatedDurationMinutes);

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        amount: estimatedCost,
        userId: user.id,
        description: `STT transcription: ~${estimatedDurationMinutes.toFixed(1)} min`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return NextResponse.json(
          {
            error: "Insufficient credits for speech-to-text",
            required: error.required,
          },
          { status: 402 },
        );
      }
      throw error;
    }

    const elevenlabs = getElevenLabsService();

    const startTime = Date.now();
    const validatedFile = new File([buffer], audioFile.name, {
      type: finalMimeType,
    });
    const transcript = await elevenlabs.speechToText({
      audioFile: validatedFile,
      languageCode,
    });
    const duration = Date.now() - startTime;

    await reservation.reconcile(estimatedCost);

    logger.info(
      `[Voice STT API] Completed in ${duration}ms: "${transcript.substring(0, 100)}..."`,
    );

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
          input_cost: String(estimatedCost),
          output_cost: String(0),
          duration_ms: duration,
          is_successful: true,
          metadata: {
            audioFileName: audioFile.name,
            audioSizeBytes: audioFile.size,
            estimatedDurationMinutes,
            languageCode,
            transcriptLength: transcript.length,
          },
        });
      } catch (error) {
        logger.error("[Voice STT API] Failed to create usage record", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return NextResponse.json({
      transcript,
      duration_ms: duration,
    });
  } catch (error) {
    logger.error("[Voice STT API] Error:", error);

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
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (errorMessage.includes("rate limit")) {
        return NextResponse.json(
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
          return NextResponse.json(
            {
              error:
                "Speech-to-Text requires a paid plan. Please upgrade to continue.",
            },
            { status: 402 },
          );
        }
        return NextResponse.json(
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
        return NextResponse.json(
          { error: "Service not configured" },
          { status: 500 },
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to transcribe audio. Please try again." },
      { status: 500 },
    );
  }
}

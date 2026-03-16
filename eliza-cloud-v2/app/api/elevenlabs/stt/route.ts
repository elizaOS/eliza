import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
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

// Magic number validation - map expected file signatures
// Note: Safari/macOS may create video/webm containers for audio-only recordings
// These are valid and contain audio data, so we accept them
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

// Estimate audio duration from file size and format
// This is a rough approximation for cost estimation
function estimateAudioDurationMinutes(
  fileSizeBytes: number,
  mimeType: string,
): number {
  // Average bitrates by format (conservative estimates)
  const bitratesKbps: Record<string, number> = {
    "audio/mpeg": 128, // MP3 at 128kbps
    "audio/mp3": 128,
    "audio/mp4": 128,
    "audio/m4a": 128,
    "audio/wav": 1411, // Uncompressed WAV at 16-bit 44.1kHz stereo
    "audio/webm": 96,
    "audio/ogg": 96,
    "video/webm": 96,
  };

  const bitrate = bitratesKbps[mimeType] || 128;
  const bytesPerMinute = ((bitrate * 1000) / 8) * 60;
  const estimatedMinutes = fileSizeBytes / bytesPerMinute;

  // Return at least 0.1 minutes (6 seconds) for very short clips
  return Math.max(0.1, estimatedMinutes);
}

/**
 * POST /api/elevenlabs/stt
 * Converts speech to text using ElevenLabs STT API.
 * Validates file type using magic numbers for security.
 * Includes 20% platform markup on all STT costs.
 *
 * @param request - Form data with audio file and optional languageCode.
 * @returns Transcript and processing duration.
 */
export async function POST(request: NextRequest) {
  let reservation: CreditReservation | undefined;

  try {
    // Authenticate user with organization
    const user = await requireAuthWithOrg();

    // Parse form data
    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const languageCode = formData.get("languageCode") as string | undefined;

    if (!audioFile) {
      return NextResponse.json(
        { error: "No audio file provided" },
        { status: 400 },
      );
    }

    // Validate file size
    if (audioFile.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        { status: 400 },
      );
    }

    // Validate MIME type (check base type without codec parameters)
    const baseMimeType = audioFile.type.split(";")[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(baseMimeType)) {
      return NextResponse.json(
        {
          error: `Unsupported audio format: ${audioFile.type}. Supported: mp3, mp4, m4a, wav, webm, ogg`,
        },
        { status: 400 },
      );
    }

    // SECURITY FIX: Validate actual file content using magic numbers
    // MIME type headers can be spoofed, so we need to check the actual file signature
    const buffer = Buffer.from(await audioFile.arrayBuffer());

    // Check magic numbers (file signature)
    const fileTypeResult = await fileTypeFromBuffer(buffer);

    if (!fileTypeResult) {
      logger.warn(
        `[STT API] Unable to detect file type for ${audioFile.name} - rejecting`,
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
        `[STT API] File signature mismatch for ${audioFile.name}: claimed=${baseMimeType}, actual=${fileTypeResult.mime}`,
      );
      return NextResponse.json(
        {
          error: `File content does not match the declared format. Detected: ${fileTypeResult.mime}, Expected audio format.`,
        },
        { status: 400 },
      );
    }

    // Handle video/webm containers (Safari/macOS audio recordings)
    // Convert to audio/webm for processing
    let finalMimeType = fileTypeResult.mime;
    if (fileTypeResult.mime === "video/webm") {
      logger.info(
        "[STT API] Converting video/webm container to audio/webm (Safari/macOS audio recording)",
      );
      finalMimeType = "audio/webm";
    }

    logger.info(
      `[STT API] Processing for user ${user.id}: ${audioFile.name} (${audioFile.size} bytes, verified: ${fileTypeResult.mime}, final: ${finalMimeType})`,
    );

    // Estimate audio duration and calculate cost (includes 20% platform markup)
    const estimatedDurationMinutes = estimateAudioDurationMinutes(
      audioFile.size,
      finalMimeType,
    );
    const estimatedCost = calculateSTTCost(estimatedDurationMinutes);

    // Reserve credits BEFORE transcription
    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id!,
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

    // Get ElevenLabs service
    const elevenlabs = getElevenLabsService();

    // Transcribe audio (convert buffer back to File for the service)
    const startTime = Date.now();
    const validatedFile = new File([buffer], audioFile.name, {
      type: finalMimeType,
    });
    const transcript = await elevenlabs.speechToText({
      audioFile: validatedFile,
      languageCode,
    });
    const duration = Date.now() - startTime;

    // Reconcile with estimated cost (STT pricing is duration-based, we estimated earlier)
    await reservation.reconcile(estimatedCost);

    logger.info(
      `[STT API] Completed in ${duration}ms: "${transcript.substring(0, 100)}..."`,
    );

    // Track usage (background, non-blocking)
    (async () => {
      try {
        await usageService.create({
          organization_id: user.organization_id!,
          user_id: user.id,
          api_key_id: null,
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
        logger.error("[STT API] Failed to create usage record", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return NextResponse.json({
      transcript,
      duration_ms: duration,
    });
  } catch (error) {
    logger.error("[STT API] Error:", error);

    // Refund reserved credits if STT failed
    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[STT API] Refunded credits after error");
    }

    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      const errorWithBody = error as Error & {
        body?: { detail?: { message?: string } };
        statusCode?: number;
      };
      const errorBody = errorWithBody.body?.detail?.message || "";

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
                "Speech-to-Text requires a paid ElevenLabs plan (Starter tier or higher). The free tier does not support STT API access. Please upgrade at https://elevenlabs.io/pricing",
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
          { status: 503 }, // Service Unavailable
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

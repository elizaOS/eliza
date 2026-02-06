import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/elevenlabs/voices/[id]
 * Gets details for a specific voice by its internal UUID.
 * Validates UUID format and verifies ownership.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Voice details including ElevenLabs voice ID and metadata.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuthWithOrg();
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice API] Getting voice ${voiceId} for user ${user.id}`);

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(voiceId)) {
      logger.warn(
        `[Voice API] Invalid voice ID format: ${voiceId}. Expected UUID format.`,
      );
      return NextResponse.json(
        {
          error: "Invalid voice ID format",
          message:
            "Please use the internal voice ID (UUID format) from the 'List User Voices' endpoint, not the ElevenLabs voice ID. Example: Get your voice list first, then use the 'id' field (not 'elevenlabsVoiceId').",
          hint: "Call GET /api/elevenlabs/voices/user to get your voice IDs",
        },
        { status: 400 },
      );
    }

    const voice = await voiceCloningService.getVoiceById(
      voiceId,
      user.organization_id!,
    );

    if (!voice) {
      return NextResponse.json(
        {
          error: "Voice not found",
          message:
            "Voice not found in your organization. Make sure you're using the correct voice ID from 'List User Voices'.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      voice,
    });
  } catch (error) {
    logger.error("[Voice API] Error:", error);

    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check for UUID format errors
    if (
      error instanceof Error &&
      (error.message.includes("invalid input syntax for type uuid") ||
        error.message.includes("uuid"))
    ) {
      return NextResponse.json(
        {
          error: "Invalid voice ID format",
          message:
            "The voice ID must be in UUID format. Use the 'id' field from 'List User Voices' response, not the 'elevenlabsVoiceId'.",
          hint: "Call GET /api/elevenlabs/voices/user to get your voice IDs",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch voice. Please try again." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/elevenlabs/voices/[id]
 * Deletes a voice by its internal UUID.
 * Validates UUID format and verifies ownership before deletion.
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the voice ID parameter.
 * @returns Success confirmation.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuthWithOrg();
    const params = await context.params;
    const voiceId = params.id;

    logger.info(`[Voice API] Deleting voice ${voiceId} for user ${user.id}`);

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(voiceId)) {
      logger.warn(
        `[Voice API] Invalid voice ID format for deletion: ${voiceId}`,
      );
      return NextResponse.json(
        {
          error: "Invalid voice ID format",
          message:
            "Please use the internal voice ID (UUID format) from the 'List User Voices' endpoint, not the ElevenLabs voice ID.",
          hint: "Call GET /api/elevenlabs/voices/user to get your voice IDs",
        },
        { status: 400 },
      );
    }

    await voiceCloningService.deleteVoice(voiceId, user.organization_id!);

    return NextResponse.json({
      success: true,
      message: "Voice deleted successfully",
    });
  } catch (error) {
    logger.error("[Voice API] Delete error:", error);

    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return NextResponse.json(
          {
            error: "Voice not found",
            message:
              "Voice not found in your organization. Make sure you're using the correct voice ID from 'List User Voices'.",
          },
          { status: 404 },
        );
      }

      if (error.message.includes("Unauthorized")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Check for UUID format errors
      if (
        error.message.includes("invalid input syntax for type uuid") ||
        error.message.includes("uuid")
      ) {
        return NextResponse.json(
          {
            error: "Invalid voice ID format",
            message:
              "The voice ID must be in UUID format. Use the 'id' field from 'List User Voices' response, not the 'elevenlabsVoiceId'.",
            hint: "Call GET /api/elevenlabs/voices/user to get your voice IDs",
          },
          { status: 400 },
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to delete voice. Please try again." },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/elevenlabs/voices/[id]
 * Updates a voice's metadata (name, description, settings, active status).
 * Validates UUID format and verifies ownership.
 *
 * Request Body:
 * - `name`: Optional voice name.
 * - `description`: Optional voice description.
 * - `settings`: Optional settings object.
 * - `isActive`: Optional boolean for active status.
 *
 * @param request - Request body with fields to update.
 * @param context - Route context containing the voice ID parameter.
 * @returns Updated voice details.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuthWithOrg();
    const params = await context.params;
    const voiceId = params.id;
    const body = await request.json();

    logger.info(`[Voice API] Updating voice ${voiceId} for user ${user.id}`);

    const { name, description, settings, isActive } = body;

    const updatedVoice = await voiceCloningService.updateVoice(
      voiceId,
      user.organization_id!,
      {
        name,
        description,
        settings,
        isActive,
      },
    );

    return NextResponse.json({
      success: true,
      voice: updatedVoice,
    });
  } catch (error) {
    logger.error("[Voice API] Update error:", error);

    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return NextResponse.json({ error: "Voice not found" }, { status: 404 });
      }

      if (error.message.includes("Unauthorized")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    return NextResponse.json(
      { error: "Failed to update voice. Please try again." },
      { status: 500 },
    );
  }
}

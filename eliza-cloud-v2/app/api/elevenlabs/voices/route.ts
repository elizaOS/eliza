import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/elevenlabs/voices
 * Lists all public/premade ElevenLabs voices available for text-to-speech.
 * Filters out custom cloned or generated voices.
 *
 * @returns Array of public voice objects.
 */
export async function GET() {
  try {
    // Authenticate user
    const user = await requireAuth();

    logger.info(`[Voices API] Fetching public voices for user ${user.id}`);

    // Get ElevenLabs service
    const elevenlabs = getElevenLabsService();

    // Fetch all voices
    const allVoices = await elevenlabs.getVoices();

    // Filter to only show pre-built/public ElevenLabs voices
    // Exclude custom cloned voices (category: "cloned" or "generated")
    // Only show premade voices that everyone can use
    const publicVoices = allVoices.filter((voice) => {
      const category = voice.category;
      // Only include premade voices, exclude cloned/generated/custom voices
      return category === "premade" || category === "professional";
    });

    logger.info(
      `[Voices API] Returning ${publicVoices.length} public voices (filtered from ${allVoices.length} total)`,
    );

    return NextResponse.json({
      voices: publicVoices,
    });
  } catch (error) {
    logger.error("[Voices API] Error:", error);

    if (
      error instanceof Error &&
      error.message.includes("ELEVENLABS_API_KEY")
    ) {
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch voices. Please try again." },
      { status: 500 },
    );
  }
}

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/elevenlabs/voices/user
 * Lists all voices owned by the authenticated user's organization.
 * Supports filtering by clone type and pagination.
 *
 * Query Parameters:
 * - `includeInactive`: If "true", includes inactive voices (default: false).
 * - `cloneType`: Filter by "instant" | "professional".
 * - `limit`: Maximum number of results (default: 50).
 * - `offset`: Offset for pagination (default: 0).
 *
 * @param request - Request with optional filtering and pagination query parameters.
 * @returns Paginated list of user voices with metadata.
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const user = await requireAuthWithOrg();

    // Parse query parameters with bounds validation
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get("includeInactive") === "true";
    const cloneType = searchParams.get("cloneType") as
      | "instant"
      | "professional"
      | undefined;
    const MAX_LIMIT = 100;
    const rawLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
    const rawOffset = Number.parseInt(searchParams.get("offset") || "0", 10);
    const limit = Math.min(
      Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);

    logger.info(`[User Voices API] Fetching voices for user ${user.id}`, {
      organizationId: user.organization_id!!,
      includeInactive,
      cloneType,
      limit,
      offset,
    });

    // Get user's voices
    const allVoices = await voiceCloningService.getUserVoices({
      organizationId: user.organization_id!!,
      includeInactive,
      cloneType,
    });

    // Apply pagination
    const paginatedVoices = allVoices.slice(offset, offset + limit);

    // Format response
    const voices = paginatedVoices.map((voice) => ({
      id: voice.id,
      elevenlabsVoiceId: voice.elevenlabsVoiceId,
      name: voice.name,
      description: voice.description,
      cloneType: voice.cloneType,
      sampleCount: voice.sampleCount,
      totalAudioDurationSeconds: voice.totalAudioDurationSeconds,
      audioQualityScore: voice.audioQualityScore,
      usageCount: voice.usageCount,
      lastUsedAt: voice.lastUsedAt,
      isActive: voice.isActive,
      isPublic: voice.isPublic,
      createdAt: voice.createdAt,
      updatedAt: voice.updatedAt,
    }));

    return NextResponse.json({
      success: true,
      voices,
      total: allVoices.length,
      limit,
      offset,
      hasMore: offset + limit < allVoices.length,
    });
  } catch (error) {
    logger.error("[User Voices API] Error:", error);

    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to fetch voices. Please try again." },
      { status: 500 },
    );
  }
}

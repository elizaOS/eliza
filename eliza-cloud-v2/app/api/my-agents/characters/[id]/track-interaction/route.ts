import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/my-agents/characters/[id]/track-interaction
 * Tracks an interaction with a character.
 * Note: This is a no-op after marketplace removal.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuthWithOrg();
    const { id } = await params;

    logger.debug("[My Agents API] Track interaction:", { characterId: id });

    // No-op - interaction tracking was part of marketplace service
    return NextResponse.json({
      success: true,
      data: { message: "Interaction tracked" },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Failed to track interaction" },
      { status: 500 },
    );
  }
}

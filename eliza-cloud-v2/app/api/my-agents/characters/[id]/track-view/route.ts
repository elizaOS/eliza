import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/my-agents/characters/[id]/track-view
 * Tracks a view of a character.
 * Note: This is a no-op after marketplace removal.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    logger.debug("[My Agents API] Track view:", { characterId: id });

    // No-op - view tracking was part of marketplace service
    return NextResponse.json({
      success: true,
      data: { message: "View tracked" },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Failed to track view" },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-agents/characters/[id]/stats
 * Get statistics for a character.
 * Supports both Privy session and API key authentication.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return NextResponse.json(
        { success: false, error: "Character not found" },
        { status: 404 },
      );
    }

    // Return basic stats. These are placeholders and follow the
    // documented field names: `views`, `interactions`, `messageCount`.
    const stats = {
      views: 0,
      interactions: 0,
      messageCount: 0,
    };
    return NextResponse.json({
      success: true,
      data: {
        stats,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Failed to get stats" },
      { status: 500 },
    );
  }
}

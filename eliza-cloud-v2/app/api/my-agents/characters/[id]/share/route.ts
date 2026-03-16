import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

const ShareSchema = z.object({
  isPublic: z.boolean(),
});

/**
 * GET /api/my-agents/characters/[id]/share
 * Get the current sharing status of a character.
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

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

    return NextResponse.json({
      success: true,
      data: {
        isPublic: character.is_public,
        shareUrl: character.is_public
          ? `${baseUrl}/chat/${character.id}`
          : null,
        // Additional info for shared characters
        shareInfo: character.is_public
          ? {
              chatUrl: `${baseUrl}/chat/${character.id}`,
              dashboardChatUrl: `${baseUrl}/dashboard/chat?characterId=${character.id}`,
              a2aEndpoint: `${baseUrl}/api/agents/${character.id}/a2a`,
              mcpEndpoint: `${baseUrl}/api/agents/${character.id}/mcp`,
            }
          : null,
      },
    });
  } catch (error) {
    logger.error("[Share API] Error getting share status:", error);
    return NextResponse.json(
      { success: false, error: "Failed to get share status" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/my-agents/characters/[id]/share
 * Toggle the public sharing status of a character.
 * Supports both Privy session and API key authentication.
 *
 * This is a simpler alternative to the full /api/v1/agents/[agentId]/publish
 * endpoint which also handles monetization settings.
 *
 * Use this endpoint for basic sharing (make character accessible via share link).
 * Use /publish for full marketplace publishing with monetization.
 *
 * Privacy notes:
 * - Character secrets are NEVER exposed publicly
 * - Only "shared" knowledge items are accessible to public users
 * - User billing is based on who chats (not the character owner)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    // Verify ownership
    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return NextResponse.json(
        { success: false, error: "Character not found or access denied" },
        { status: 404 },
      );
    }

    // Parse request body
    const body = await request.json();
    const validation = ShareSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request body",
          details: validation.error.issues,
        },
        { status: 400 },
      );
    }

    const { isPublic } = validation.data;

    logger.info("[Share API] Toggling character share status:", {
      characterId: id,
      userId: user.id,
      characterName: character.name,
      previousStatus: character.is_public,
      newStatus: isPublic,
    });

    // Update the character's public status
    const updated = await charactersService.update(id, {
      is_public: isPublic,
    });

    if (!updated) {
      return NextResponse.json(
        { success: false, error: "Failed to update character" },
        { status: 500 },
      );
    }

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/my-agents");
    revalidatePath("/dashboard/build");

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

    return NextResponse.json({
      success: true,
      data: {
        characterId: id,
        characterName: updated.name,
        isPublic: updated.is_public,
        shareUrl: updated.is_public ? `${baseUrl}/chat/${updated.id}` : null,
        message: updated.is_public
          ? `"${updated.name}" is now publicly shareable! Anyone with the link can chat with this character.`
          : `"${updated.name}" is now private. Only you can chat with this character.`,
        // Additional info for shared characters
        shareInfo: updated.is_public
          ? {
              chatUrl: `${baseUrl}/chat/${updated.id}`,
              dashboardChatUrl: `${baseUrl}/dashboard/chat?characterId=${updated.id}`,
            }
          : null,
      },
    });
  } catch (error) {
    logger.error("[Share API] Error toggling share status:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update share status",
      },
      { status: 500 },
    );
  }
}

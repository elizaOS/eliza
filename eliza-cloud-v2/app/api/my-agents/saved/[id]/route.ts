import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-agents/saved/[id]
 * Get details about a specific saved agent including confirmation info for deletion.
 * Supports both Privy session and API key authentication.
 *
 * @param request - The request object.
 * @param params - Route params containing the agent ID.
 * @returns Agent details with conversation stats.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: agentId } = await params;

    logger.debug("[Saved Agents API] Getting saved agent details:", {
      userId: user.id,
      agentId,
    });

    const result = await charactersService.getSavedAgentDetails(
      user.id,
      agentId,
    );

    if (!result) {
      return NextResponse.json(
        {
          success: false,
          error: "Agent not found or not accessible",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        agent: result.agent,
        stats: result.stats,
        // Warning message for UI
        deletion_warning:
          "Removing this agent will permanently delete your conversation history with it.",
      },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error getting saved agent:", error);

    const status =
      error instanceof Error && error.message.includes("auth") ? 401 : 500;

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get saved agent",
      },
      { status },
    );
  }
}

/**
 * DELETE /api/my-agents/saved/[id]
 * Remove a saved agent from the user's list.
 * Supports both Privy session and API key authentication.
 *
 * This permanently deletes:
 * - All conversation history (memories) between user and agent
 * - Room associations for user with this agent
 *
 * @param request - The request object.
 * @param params - Route params containing the agent ID.
 * @returns Success status and deletion stats.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id: agentId } = await params;

    logger.info("[Saved Agents API] Removing saved agent:", {
      userId: user.id,
      agentId,
    });

    const result = await charactersService.removeSavedAgent(user.id, agentId);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
        },
        { status: 404 },
      );
    }

    logger.info("[Saved Agents API] Removed saved agent:", {
      userId: user.id,
      agentId,
      deleted: result.deleted,
    });

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/my-agents");

    return NextResponse.json({
      success: true,
      data: {
        message: "Saved agent removed successfully",
        deleted: result.deleted,
      },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error removing saved agent:", error);

    const status =
      error instanceof Error && error.message.includes("auth") ? 401 : 500;

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to remove saved agent",
      },
      { status },
    );
  }
}

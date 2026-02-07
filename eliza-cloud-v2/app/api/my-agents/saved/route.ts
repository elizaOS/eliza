import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-agents/saved
 * Lists public agents the user has chatted with but doesn't own.
 * Supports both Privy session and API key authentication.
 *
 * Data is derived from the memories table - finds distinct agent_ids
 * where entity_id = current user, excluding agents owned by the user,
 * and only including public agents.
 *
 * @returns List of saved agents with their details and last interaction time.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    logger.debug("[Saved Agents API] Fetching saved agents for user:", {
      userId: user.id,
    });

    const savedAgents = await charactersService.getSavedAgentsForUser(user.id);

    logger.debug("[Saved Agents API] Found saved agents:", {
      userId: user.id,
      count: savedAgents.length,
    });

    return NextResponse.json({
      success: true,
      data: {
        agents: savedAgents,
        count: savedAgents.length,
      },
    });
  } catch (error) {
    logger.error("[Saved Agents API] Error fetching saved agents:", error);

    const status =
      error instanceof Error && error.message.includes("auth") ? 401 : 500;

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch saved agents",
      },
      { status },
    );
  }
}

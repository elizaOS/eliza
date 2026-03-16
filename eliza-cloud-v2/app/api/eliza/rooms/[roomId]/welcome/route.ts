import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getAnonymousUser } from "@/lib/auth-anonymous";
import { roomsService } from "@/lib/services/agents/rooms";
import { memoriesRepository, entitiesRepository } from "@/db/repositories";
import { v4 as uuidv4 } from "uuid";

// Default agent ID for Eliza builder
const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

/**
 * POST /api/eliza/rooms/[roomId]/welcome
 *
 * Stores a welcome message as the first message in the room.
 * This allows the agent to see the welcome context.
 *
 * Body: { text: string }
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const body = await request.json();
  const { text } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Support both authenticated and anonymous users
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
  } catch {
    const anonData = await getAnonymousUser();
    if (!anonData) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    userId = anonData.user.id;
  }

  // Verify user has access to this room
  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Ensure the default agent entity exists before creating memory
  await entitiesRepository.create({
    id: DEFAULT_AGENT_ID,
    agentId: DEFAULT_AGENT_ID,
    names: ["Eliza"],
  });

  // Store welcome message directly in memoryTable
  const messageId = uuidv4();

  const memory = await memoriesRepository.create({
    id: messageId,
    roomId,
    entityId: DEFAULT_AGENT_ID, // Message is from Eliza
    agentId: DEFAULT_AGENT_ID,
    type: "messages",
    content: {
      text,
      source: "agent",
    },
  });

  logger.info(
    `[Welcome API] Stored welcome message: ${messageId} in room ${roomId}`,
  );

  return NextResponse.json({
    success: true,
    messageId: memory.id,
  });
}

/**
 * DELETE /api/eliza/rooms/[roomId]/welcome
 *
 * Clears all messages from a room (used to reset edit mode rooms).
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;

  // Support both authenticated and anonymous users
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
  } catch {
    const anonData = await getAnonymousUser();
    if (!anonData) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    userId = anonData.user.id;
  }

  // Verify user has access to this room
  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Delete all messages from the room
  await memoriesRepository.deleteMessages(roomId);

  logger.info(`[Welcome API] Cleared all messages from room ${roomId}`);

  return NextResponse.json({
    success: true,
  });
}

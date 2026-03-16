import { NextResponse } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getAnonymousUser } from "@/lib/auth-anonymous";
import type { NextRequest } from "next/server";
import { roomsService } from "@/lib/services/agents/rooms";
import { agentsService } from "@/lib/services/agents/agents";
import { conversationsRepository, roomsRepository } from "@/db/repositories";
import { logger } from "@/lib/utils/logger";
import {
  parseMessageContent,
  type MessageContent,
} from "@/lib/types/message-content";
import type { Memory } from "@elizaos/core";

/**
 * GET /api/eliza/rooms/[roomId] - Get room details and messages
 *
 * Pure database operation - no runtime needed
 * Uses agentsService to get agent display info
 * Requires the authenticated user to be a participant of the room
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  // Get authenticated user ID
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
  } catch {
    // Fallback to anonymous user
    const anonData = await getAnonymousUser();
    if (!anonData) {
      // Create new anonymous session if none exists
      const { getOrCreateAnonymousUser } = await import("@/lib/auth-anonymous");
      const newAnonData = await getOrCreateAnonymousUser();
      userId = newAnonData.user.id;
    } else {
      userId = anonData.user.id;
    }
  }

  const { roomId } = await ctx.params;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit");

  if (!roomId) {
    return NextResponse.json({ error: "roomId is required" }, { status: 400 });
  }

  // Access control: verify user is a participant of the room
  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) {
    logger.warn(
      `[Eliza Room API] Access denied: User ${userId} attempted to access room ${roomId}`,
    );
    return NextResponse.json(
      { error: "You don't have permission to access this room" },
      { status: 403 },
    );
  }

  // Use rooms service to get room with messages (pure DB query)
  // Service handles filtering (hidden/action_result) and deduplication
  const roomData = await roomsService.getRoomWithMessages(
    roomId,
    limit ? parseInt(limit) : 50,
  );

  // If room doesn't exist in Eliza tables, check if it's a conversation
  // that hasn't had any messages yet (room is created on first message)
  if (!roomData) {
    const conversation = await conversationsRepository.findById(roomId);
    if (conversation) {
      // Room exists as a conversation but no Eliza room yet - return empty messages
      logger.info(
        `[Eliza Room API] Room ${roomId} not found in Eliza tables, but conversation exists - returning empty messages`,
      );
      return NextResponse.json(
        {
          success: true,
          roomId,
          messages: [],
          count: 0,
          characterId: undefined,
          agent: {
            id: "default",
            name: "Eliza",
            avatarUrl: undefined,
          },
          metadata: {},
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Get character ID from room agentId (single source of truth)
  const characterId = roomData.room.agentId || undefined;

  if (characterId) {
    logger.info("[Eliza Room API] Loading room with character:", characterId);
  } else {
    logger.info("[Eliza Room API] Loading room with default character");
  }

  // Transform messages for API response
  const messages = roomData.messages.map((msg: Memory) => {
    const content = parseMessageContent(msg.content);

    // Debug: Log attachment info for agent messages
    if (content?.source === "agent" && content?.attachments) {
      logger.info(
        `[Eliza Room API] 📎 Message ${msg.id?.substring(0, 8)} has ${content.attachments.length} attachment(s)`,
      );
    }

    // Determine isAgent based on content.source field (most reliable)
    // Fallback to entityId comparison for backward compatibility
    const isAgentBySource = content?.source === "agent";
    const isAgentByEntityId = msg.entityId === msg.agentId;
    const isAgent = content?.source ? isAgentBySource : isAgentByEntityId;

    return {
      id: msg.id,
      entityId: msg.entityId,
      agentId: msg.agentId,
      content,
      createdAt: msg.createdAt || Date.now(),
      isAgent,
    };
  });

  logger.info(
    `[Eliza Room API] ✅ Returning ${messages.length} messages for room ${roomId}`,
  );

  // Get agent display info from database (no runtime needed!)
  // PERFORMANCE: Try character ID first, fallback to room's agentId
  const agentIdToLookup = characterId || roomData.room.agentId;
  const agentInfo = agentIdToLookup
    ? (await agentsService.getDisplayInfo(agentIdToLookup)) || {
        id: agentIdToLookup,
        name: "Eliza",
        avatarUrl: undefined,
      }
    : {
        id: "default",
        name: "Eliza",
        avatarUrl: undefined,
      };

  return NextResponse.json(
    {
      success: true,
      roomId,
      messages,
      count: messages.length,
      characterId,
      agent: agentInfo,
      metadata: roomData.room.metadata || {},
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PATCH /api/eliza/rooms/[roomId] - Update room metadata
 *
 * Pure database operation - no runtime needed
 * Requires the authenticated user to be a participant of the room
 */
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  // Get authenticated user ID
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
  } catch {
    // Fallback to anonymous user
    const anonData = await getAnonymousUser();
    if (!anonData) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    userId = anonData.user.id;
  }

  const { roomId } = await ctx.params;

  if (!roomId) {
    return NextResponse.json({ error: "roomId is required" }, { status: 400 });
  }

  // Access control: verify user is a participant of the room
  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) {
    logger.warn(
      `[Eliza Room API] Access denied: User ${userId} attempted to update room ${roomId}`,
    );
    return NextResponse.json(
      { error: "You don't have permission to update this room" },
      { status: 403 },
    );
  }

  const body = (await request.json()) as {
    metadata?: Record<string, unknown>;
    name?: string;
  };

  if (!body.metadata && !body.name) {
    return NextResponse.json(
      { error: "metadata or name is required" },
      { status: 400 },
    );
  }

  if (body.metadata && typeof body.metadata !== "object") {
    return NextResponse.json(
      { error: "metadata must be an object" },
      { status: 400 },
    );
  }

  if (body.metadata) {
    await roomsService.updateMetadata(roomId, body.metadata);
  }

  if (body.name) {
    await roomsRepository.update(roomId, { name: body.name });
  }

  const updatedFields = [
    body.metadata && "metadata",
    body.name && "name",
  ].filter(Boolean);

  logger.info("[Eliza Room API] ✓ Room updated successfully:", roomId);

  return NextResponse.json({
    success: true,
    message: `Room ${updatedFields.join(" and ")} updated successfully`,
    roomId,
  });
}

/**
 * DELETE /api/eliza/rooms/[roomId] - Delete a room and all related data
 *
 * Pure database operation - no runtime needed
 * Requires the authenticated user to be a participant of the room
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  // Get authenticated user ID
  let userId: string;

  try {
    const authResult = await requireAuthOrApiKey(request);
    userId = authResult.user.id;
  } catch {
    // Fallback to anonymous user
    const anonData = await getAnonymousUser();
    if (!anonData) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    userId = anonData.user.id;
  }

  const { roomId } = await ctx.params;

  if (!roomId) {
    return NextResponse.json({ error: "roomId is required" }, { status: 400 });
  }

  // Access control: verify user is a participant of the room
  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) {
    logger.warn(
      `[Eliza Room API] Access denied: User ${userId} attempted to delete room ${roomId}`,
    );
    return NextResponse.json(
      { error: "You don't have permission to delete this room" },
      { status: 403 },
    );
  }

  logger.info("[Eliza Room API] Deleting room:", roomId, "by user:", userId);

  // Use rooms service to delete room and all related data
  await roomsService.deleteRoom(roomId);

  logger.info("[Eliza Room API] ✓ Room deleted successfully:", roomId);

  return NextResponse.json({
    success: true,
    message: "Room deleted successfully",
    roomId,
  });
}

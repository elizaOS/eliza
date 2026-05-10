/**
 * Rooms Service - Business logic for agent rooms
 * Uses direct DB access via repositories instead of spinning up runtime
 */

import type { Memory } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { dbWrite } from "@/db/client";
import {
  conversationsRepository,
  entitiesRepository,
  memoriesRepository,
  participantsRepository,
  type Room,
  roomsRepository,
} from "@/db/repositories";
import { entityTable, participantTable, roomTable } from "@/db/schemas/eliza";
import { isVisibleDialogueMessage, parseMessageContent } from "@/lib/types/message-content";

/**
 * Input for creating a room.
 */
export interface CreateRoomInput {
  id?: string; // Allow passing a pre-generated room ID
  agentId?: string; // Optional - will be set when runtime initializes
  entityId: string;
  source?: string;
  type?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Room with associated messages.
 */
export interface RoomWithMessages {
  room: Room;
  messages: Memory[];
  participants: string[];
}

/**
 * Room preview for sidebar/list views
 * Transformed from repository `RoomWithPreview` for API response.
 */
export interface RoomPreview {
  id: string;
  title?: string; // room name or generated title
  characterId?: string; // agentId from room
  characterName?: string; // character name from user_characters
  characterAvatarUrl?: string; // avatar_url from user_characters
  lastTime?: number; // from last message createdAt (ms timestamp)
  lastText?: string; // from last message content.text (truncated)
  isLocked?: boolean; // Whether the room is locked (character was created/saved)
  isBuildRoom?: boolean; // Whether this is a legacy builder room
}

export class RoomsService {
  /**
   * Get room by ID with messages
   *
   * Automatically filters out:
   * - Hidden messages (metadata.visibility === 'hidden')
   * - Action result messages (internal system messages)
   * - Duplicate messages (same text within 5 second window)
   */
  async getRoomWithMessages(
    roomId: string,
    limit = 50,
    afterTimestamp?: number,
  ): Promise<RoomWithMessages | null> {
    const room = await roomsRepository.findById(roomId);
    if (!room) {
      return null;
    }

    const rawMessages = await memoriesRepository.findMessages(roomId, { limit, afterTimestamp });
    const participantIds = await participantsRepository.getEntityIdsByRoomId(roomId);

    // Reverse to get chronological order
    const messagesInOrder = rawMessages.reverse();

    // Filter out hidden and action result messages
    const visibleMessages = messagesInOrder.filter((msg) => {
      const content = parseMessageContent(msg.content);
      const metadata = msg.metadata as Record<string, unknown> | undefined;

      // Check if message should be visible using helper
      const isVisible = isVisibleDialogueMessage(metadata, content);

      return isVisible;
    });

    // Deduplicate messages: Remove duplicate agent responses that might have been
    // stored twice (once by action callback, once by handler). Keep the one with
    // attachments or the first one if both/neither have attachments.
    const seenTexts = new Map<
      string,
      {
        index: number;
        hasAttachments: boolean;
        isAgent: boolean;
        message: Memory;
      }
    >();
    const indicesToRemove = new Set<number>();

    visibleMessages.forEach((msg, index) => {
      const content = parseMessageContent(msg.content);
      const text = content?.text?.trim();
      if (!text) return;

      // Create a key based on text and approximate timestamp (within 5 seconds)
      const createdAt = msg.createdAt || Date.now();
      const timeWindow = Math.floor(createdAt / 5000);
      const key = `${text}:${timeWindow}`;

      const existing = seenTexts.get(key);
      if (existing) {
        const currentHasAttachments =
          Array.isArray(content?.attachments) && content.attachments.length > 0;
        const isAgentBySource = content?.source === "agent";
        const isAgentByEntityId = msg.entityId === msg.agentId;
        const isAgent = content?.source ? isAgentBySource : isAgentByEntityId;

        if (currentHasAttachments && !existing.hasAttachments) {
          // Current has attachments, existing doesn't - keep current
          indicesToRemove.add(existing.index);
          seenTexts.set(key, {
            index,
            hasAttachments: currentHasAttachments,
            isAgent,
            message: msg,
          });
        } else if (isAgent && !existing.isAgent) {
          // Current is from agent, existing isn't - keep current
          indicesToRemove.add(existing.index);
          seenTexts.set(key, {
            index,
            hasAttachments: currentHasAttachments,
            isAgent,
            message: msg,
          });
        } else {
          // Keep existing, remove current
          indicesToRemove.add(index);
        }
      } else {
        const hasAttachments =
          Array.isArray(content?.attachments) && content.attachments.length > 0;
        const isAgentBySource = content?.source === "agent";
        const isAgentByEntityId = msg.entityId === msg.agentId;
        const isAgent = content?.source ? isAgentBySource : isAgentByEntityId;
        seenTexts.set(key, { index, hasAttachments, isAgent, message: msg });
      }
    });

    const cleanMessages = visibleMessages.filter((_, index) => !indicesToRemove.has(index));

    return {
      room,
      messages: cleanMessages,
      participants: participantIds,
    };
  }

  /**
   * Get rooms for an entity (user) with last message preview
   * Uses a single optimized query - no N+1 problem
   *
   * By default, filters out:
   * - Locked rooms (where a character was created/saved)
   * - legacy builder rooms
   *
   * @param entityId - The user's ID (from auth)
   * @param options.includeBuildRooms - Include legacy builder rooms in results
   * @returns Room previews sorted by most recent activity
   */
  async getRoomsForEntity(
    entityId: string,
    options?: { includeBuildRooms?: boolean },
  ): Promise<RoomPreview[]> {
    // Single query: participants → rooms → last message → user_characters
    const roomsWithPreview = await roomsRepository.findRoomsWithPreviewForEntity(entityId);

    const includeBuildRooms = options?.includeBuildRooms ?? false;

    // Transform to API response format and filter out locked/legacy builder rooms
    return roomsWithPreview
      .map((room) => {
        const metadata = room.metadata as { locked?: boolean } | null;
        const isLocked = metadata?.locked === true;
        const isBuildRoom =
          room.name?.startsWith("[BUILD]") || room.name?.startsWith("[CREATOR]") || false;

        return {
          id: room.id,
          title: room.name || undefined,
          characterId: room.characterId || undefined,
          characterName: room.characterName || undefined,
          characterAvatarUrl: room.characterAvatarUrl || undefined,
          lastTime: room.lastMessageTime?.getTime() || room.createdAt?.getTime(),
          lastText: room.lastMessageText?.substring(0, 100) || undefined,
          isLocked,
          isBuildRoom,
        };
      })
      .filter((room) => {
        if (room.isLocked) return false;
        if (room.isBuildRoom && !includeBuildRooms) return false;
        return true;
      });
  }

  /**
   * Create a new room with entity as participant
   * If agentId is not provided, we create a minimal room that will be
   * fully initialized when the first message is sent (runtime handles it)
   *
   * When agentId is provided, uses a database transaction to ensure
   * room + entity + participant are created atomically.
   */
  async createRoom(input: CreateRoomInput): Promise<Room> {
    const roomId = input.id || uuidv4();

    // Create room with agentId - required for elizaOS room lookup
    // The API route ensures agent exists before calling this
    // elizaOS's ensureConnection creates entity/participant when first message is sent
    const roomResult = (await dbWrite
      .insert(roomTable)
      .values({
        id: roomId,
        agentId: input.agentId || null,
        source: input.source || "web",
        type: input.type || "DM",
        name: input.name,
        metadata: input.metadata,
        createdAt: new Date(),
      } as typeof roomTable.$inferInsert)
      .returning()) as Room[];

    return roomResult[0];
  }

  /**
   * Atomically create a room with entity and participant in a single transaction.
   * Prevents race condition where room creation succeeds but participant addition fails,
   * leaving the system in an inconsistent state.
   */
  async createRoomWithParticipant(roomInput: CreateRoomInput, entityId: string): Promise<Room> {
    const roomId = roomInput.id || uuidv4();
    const agentId = roomInput.agentId;

    if (!agentId) {
      throw new Error("agentId is required for createRoomWithParticipant");
    }

    return await dbWrite.transaction(async (tx): Promise<Room> => {
      // Create room
      const rows = await tx
        .insert(roomTable)
        .values({
          id: roomId,
          agentId,
          source: roomInput.source || "web",
          type: roomInput.type || "DM",
          name: roomInput.name,
          metadata: roomInput.metadata,
          createdAt: new Date(),
        } as typeof roomTable.$inferInsert)
        .returning();
      const room = rows[0] as Room;

      // Create entity (upsert - ignore if exists)
      // Must use tx so the insert is visible within this transaction
      await tx
        .insert(entityTable)
        .values({
          id: entityId,
          agentId,
          names: [entityId],
          createdAt: new Date(),
        })
        .onConflictDoNothing();

      // Add participant
      // Must use tx so it can see the room created above
      await tx
        .insert(participantTable)
        .values({
          roomId,
          entityId,
          agentId,
          createdAt: new Date(),
        })
        .returning();

      return room;
    });
  }

  /**
   * Update room metadata
   */
  async updateMetadata(roomId: string, metadata: Record<string, unknown>): Promise<void> {
    await roomsRepository.updateMetadata(roomId, metadata);
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    await roomsRepository.update(roomId, { name });
  }

  /**
   * Delete room and all related data
   */
  async deleteRoom(roomId: string): Promise<void> {
    // Delete in order: messages, participants, then room
    // (CASCADE should handle most of this, but explicit is better)
    await Promise.all([
      memoriesRepository.deleteMessages(roomId),
      participantsRepository.deleteByRoomId(roomId),
    ]);

    await roomsRepository.delete(roomId);
  }

  /**
   * Get room summary with message count and last message
   */
  async getRoomSummary(roomId: string): Promise<{
    roomId: string;
    messageCount: number;
    participantCount: number;
    lastMessage?: { time: number; text: string };
  } | null> {
    const [room, messageCount, participantCount, lastMessage] = await Promise.all([
      roomsRepository.findById(roomId),
      memoriesRepository.countMessages(roomId),
      participantsRepository.countByRoomId(roomId),
      memoriesRepository.findLastMessageForRoom(roomId),
    ]);

    if (!room) {
      return null;
    }

    return {
      roomId: room.id,
      messageCount,
      participantCount,
      lastMessage: lastMessage
        ? {
            time: lastMessage.createdAt || Date.now(),
            text: ((lastMessage.content?.text as string) || "").substring(0, 100),
          }
        : undefined,
    };
  }

  /**
   * Check if entity has access to room
   * Grants access if:
   * 1. Entity is a participant in the room, OR
   * 2. Entity is the room creator (stored in metadata), OR
   * 3. Entity owns the conversation (for rooms created via conversations API)
   */
  async hasAccess(roomId: string, entityId: string): Promise<boolean> {
    // First check if user is a participant
    const isParticipant = await participantsRepository.isParticipant(roomId, entityId);
    if (isParticipant) {
      return true;
    }

    // If not a participant, check if user is the room creator
    const room = await roomsRepository.findById(roomId);
    if (room) {
      interface RoomMetadata {
        creatorUserId?: string;
        [key: string]: unknown;
      }
      const metadata = (room.metadata as RoomMetadata | null) ?? {};
      const isCreator = metadata.creatorUserId === entityId;
      if (isCreator) {
        return true;
      }
    }

    // Fallback: Check if this is a conversation the user owns
    // This handles the case where a conversation was created but the Eliza room
    // hasn't been created yet (e.g., no messages sent yet)
    const conversation = await conversationsRepository.findById(roomId);
    if (conversation && conversation.user_id === entityId) {
      return true;
    }

    return false;
  }

  /**
   * Add participant to room
   */
  async addParticipant(roomId: string, entityId: string, agentId: string): Promise<void> {
    // Ensure entity exists
    await entitiesRepository.create({
      id: entityId,
      agentId,
      names: [entityId],
    });

    // Add as participant
    await participantsRepository.create({
      roomId,
      entityId,
      agentId,
    });
  }

  /**
   * Get rooms by agent (for analytics)
   */
  async getRoomsByAgent(agentId: string, limit = 50): Promise<Room[]> {
    return await roomsRepository.findByAgentId(agentId, limit);
  }
}

export const roomsService = new RoomsService();

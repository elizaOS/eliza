/**
 * Room management tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { roomsService } from "@/lib/services/agents/rooms";
import { charactersService } from "@/lib/services/characters/characters";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerRoomTools(server: McpServer): void {
  server.registerTool(
    "list_rooms",
    {
      description: "List chat rooms. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const rooms = await roomsService.getRoomsForEntity(user.id);

        return jsonResponse({
          success: true,
          rooms: rooms.map((r) => ({
            id: r.id,
            characterId: r.characterId,
            lastMessage: r.lastText,
          })),
          total: rooms.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list rooms",
        );
      }
    },
  );

  server.registerTool(
    "create_room",
    {
      description: "Create a new chat room. FREE tool.",
      inputSchema: {
        characterId: z.string().optional().describe("Character/agent ID"),
      },
    },
    async ({ characterId }) => {
      try {
        const { user } = getAuthContext();
        const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

        if (characterId && characterId !== DEFAULT_AGENT_ID) {
          const character = await charactersService.getById(characterId);
          if (!character) {
            return errorResponse("Character not found");
          }

          const isOwner = character.user_id === user.id;
          const isPublic = character.is_public === true;
          const claimCheck =
            await charactersService.isClaimableAffiliateCharacter(characterId);

          if (!isPublic && !isOwner && !claimCheck.claimable) {
            return errorResponse("Access denied - this character is private");
          }
        }

        const room = await roomsService.createRoom({
          entityId: user.id,
          agentId: characterId || DEFAULT_AGENT_ID,
          name: "New Chat",
        });

        return jsonResponse({
          success: true,
          roomId: room.id,
          characterId: room.agentId,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to create room",
        );
      }
    },
  );
}

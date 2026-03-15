/**
 * List rooms action for Matrix plugin.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { MatrixService } from "../service.js";
import { MATRIX_SERVICE_NAME } from "../types.js";

export const listRooms: Action = {
  name: "MATRIX_LIST_ROOMS",
  similes: [
    "LIST_MATRIX_ROOMS",
    "SHOW_ROOMS",
    "GET_ROOMS",
    "MY_ROOMS",
  ],
  description: "List all Matrix rooms the bot has joined",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    return message.content.source === "matrix";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const matrixService = (await runtime.getService(MATRIX_SERVICE_NAME)) as MatrixService | undefined;

    if (!matrixService || !matrixService.isConnected()) {
      if (callback) {
        await callback({ text: "Matrix service is not available.", source: "matrix" });
      }
      return { success: false, error: "Matrix service not available" };
    }

    const rooms = await matrixService.getJoinedRooms();

    // Format room list
    const roomList = rooms.map((room) => {
      const name = room.name || room.canonicalAlias || room.roomId;
      const members = `${room.memberCount} members`;
      const encrypted = room.isEncrypted ? " (encrypted)" : "";
      return `- ${name} (${members})${encrypted}`;
    });

    const responseText =
      rooms.length > 0
        ? `Joined ${rooms.length} room(s):\n\n${roomList.join("\n")}`
        : "Not currently in any rooms.";

    if (callback) {
      await callback({
        text: responseText,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        roomCount: rooms.length,
        rooms: rooms.map((r) => ({
          roomId: r.roomId,
          name: r.name,
          alias: r.canonicalAlias,
          memberCount: r.memberCount,
          isEncrypted: r.isEncrypted,
        })),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What rooms are you in?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list the rooms I've joined.",
          actions: ["MATRIX_LIST_ROOMS"],
        },
      },
    ],
  ],
};

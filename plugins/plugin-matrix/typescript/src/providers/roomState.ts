/**
 * Room state provider for Matrix plugin.
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { MatrixService } from "../service.js";
import { MATRIX_SERVICE_NAME, getMatrixLocalpart } from "../types.js";

/**
 * Provider that gives the agent information about the current Matrix room context.
 */
export const roomStateProvider: Provider = {
  name: "matrixRoomState",
  description: "Provides information about the current Matrix room context",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    // Only provide context for Matrix messages
    if (message.content.source !== "matrix") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const matrixService = (await runtime.getService(MATRIX_SERVICE_NAME)) as MatrixService | undefined;

    if (!matrixService || !matrixService.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    // Get room from state if available
    const room = state?.data?.room as Record<string, unknown> | undefined;
    const roomId = room?.roomId as string | undefined;
    const roomName = room?.name as string | undefined;
    const isEncrypted = room?.isEncrypted as boolean | undefined;
    const isDirect = room?.isDirect as boolean | undefined;
    const memberCount = room?.memberCount as number | undefined;

    const userId = matrixService.getUserId();
    const displayName = getMatrixLocalpart(userId);

    let responseText = "";

    if (isDirect) {
      responseText = `${agentName} is in a direct message conversation on Matrix.`;
    } else {
      const roomLabel = roomName || roomId || "a Matrix room";
      responseText = `${agentName} is currently in Matrix room "${roomLabel}".`;
      
      if (memberCount) {
        responseText += ` The room has ${memberCount} members.`;
      }
    }

    if (isEncrypted) {
      responseText += " This room has end-to-end encryption enabled.";
    }

    responseText += `\n\nMatrix is a decentralized communication protocol. ${agentName} is logged in as ${userId}.`;

    return {
      data: {
        roomId,
        roomName,
        isEncrypted: isEncrypted || false,
        isDirect: isDirect || false,
        memberCount: memberCount || 0,
        userId,
        displayName,
        homeserver: matrixService.getHomeserver(),
        connected: true,
      },
      values: {
        roomId,
        roomName,
        isEncrypted: isEncrypted || false,
        isDirect: isDirect || false,
        memberCount: memberCount || 0,
        userId,
      },
      text: responseText,
    };
  },
};

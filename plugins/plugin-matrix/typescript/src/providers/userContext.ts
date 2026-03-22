/**
 * User context provider for Matrix plugin.
 */

import type { Provider, ProviderResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { MatrixService } from "../service.js";
import {
  MATRIX_SERVICE_NAME,
  getMatrixLocalpart,
  getMatrixUserDisplayName,
  type MatrixUserInfo,
} from "../types.js";

/**
 * Provider that gives the agent information about the Matrix user context.
 */
export const userContextProvider: Provider = {
  name: "matrixUserContext",
  description: "Provides information about the Matrix user in the current conversation",

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
        data: {},
        values: {},
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";

    // Try to get sender info from message metadata
    const metadata = message.content.metadata as Record<string, unknown> | undefined;
    const senderInfo = metadata?.senderInfo as MatrixUserInfo | undefined;

    if (!senderInfo) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const displayName = getMatrixUserDisplayName(senderInfo);
    const localpart = getMatrixLocalpart(senderInfo.userId);

    const responseText = `${agentName} is talking to ${displayName} (${senderInfo.userId}) on Matrix.`;

    return {
      data: {
        userId: senderInfo.userId,
        displayName,
        localpart,
        avatarUrl: senderInfo.avatarUrl,
      },
      values: {
        userId: senderInfo.userId,
        displayName,
        localpart,
      },
      text: responseText,
    };
  },
};

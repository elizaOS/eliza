import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { SignalService } from "../service";
import { getSignalContactDisplayName, ServiceType } from "../types";

/**
 * Provider for retrieving Signal conversation state information.
 */
export const conversationStateProvider: Provider = {
  name: "signalConversationState",
  description: "Provides information about the current Signal conversation context",
  descriptionCompressed: "Current Signal conversation context.",
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    // If message source is not signal, return empty
    if (message.content.source !== "signal") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const agentName = String(state?.agentName || "The agent");
    const senderName = String(state?.senderName || "someone");

    let responseText = "";
    let conversationType = "";
    let contactName = "";
    let groupName = "";
    const channelId = room.channelId ?? "";

    const signalService = runtime.getService(ServiceType.SIGNAL) as SignalService;
    if (!signalService || !signalService.isServiceConnected()) {
      return {
        data: {
          room,
          conversationType: "unknown",
          channelId,
        },
        values: {
          conversationType: "unknown",
          channelId,
        },
        text: "",
      };
    }

    const isGroup = room.metadata?.isGroup || false;

    if (isGroup) {
      conversationType = "GROUP";
      const groupId = room.metadata?.groupId as string;
      const group = signalService.getCachedGroup(groupId);
      groupName = group?.name || room.name || "Unknown Group";

      responseText = `${agentName} is currently in a Signal group chat: "${groupName}".`;
      responseText += `\n${agentName} should be aware that multiple people can see this conversation and should participate when relevant.`;

      if (group?.description) {
        responseText += `\nGroup description: ${group.description}`;
      }
    } else {
      conversationType = "DM";
      const contact = signalService.getContact(channelId);
      contactName = contact ? String(getSignalContactDisplayName(contact)) : senderName;

      responseText = `${agentName} is currently in a direct message conversation with ${contactName} on Signal.`;
      responseText += `\n${agentName} should engage naturally in conversation, responding to messages addressed to them.`;
    }

    responseText +=
      "\n\nSignal is an encrypted messaging platform, so all messages are secure and private.";

    return {
      data: {
        room,
        conversationType,
        contactName,
        groupName,
        channelId,
        isGroup,
        accountNumber: signalService.getAccountNumber(),
      },
      values: {
        conversationType,
        contactName,
        groupName,
        channelId,
        isGroup,
      },
      text: responseText,
    };
  },
};

export default conversationStateProvider;

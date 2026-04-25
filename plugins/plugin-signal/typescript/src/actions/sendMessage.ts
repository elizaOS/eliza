import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { isValidGroupId, normalizeE164 } from "../types";
import {
  getMessageText,
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

const sendMessageTemplate = `You are helping to extract send message parameters for Signal.

The user wants to send a message to a Signal contact or group.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. recipient: The phone number (E.164 format like +1234567890) or group ID to send to (default: "current" for current conversation)

Respond with a JSON object like:
{
  "text": "The message to send",
  "recipient": "current"
}

Only respond with the JSON object, no other text.`;

export const sendMessage: Action = {
  name: "SIGNAL_SEND_MESSAGE",
  similes: ["SEND_SIGNAL_MESSAGE", "TEXT_SIGNAL", "MESSAGE_SIGNAL", "SIGNAL_TEXT"],
  description: "Send a message to a Signal contact or group",
  descriptionCompressed: "Send Signal message.",
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }

    if (isSignalConversation(message)) {
      return true;
    }

    if (hasStructuredSignalInvocation(message, "SIGNAL_SEND_MESSAGE", ["recipient", "text"])) {
      return true;
    }

    const text = getMessageText(message);
    return /\bsignal\b/i.test(text) && /\b(reply|send|message|text)\b/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const signalService = getSignalService(runtime);

    if (!signalService || !signalService.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const composedState: State = state ?? {
      values: {},
      data: {},
      text: "",
    };
    const prompt = composePromptFromState({
      state: composedState,
      template: sendMessageTemplate,
    });

    let messageInfo: { text: string; recipient?: string } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.text) {
        messageInfo = {
          text: String(parsedResponse.text),
          recipient: parsedResponse.recipient ? String(parsedResponse.recipient) : "current",
        };
        break;
      }
    }

    if (!messageInfo || !messageInfo.text) {
      await callback?.({
        text: "I couldn't understand what message you want me to send. Please try again with a clearer request.",
        source: "signal",
      });
      return { success: false, error: "Could not extract message parameters" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));

    if (!room) {
      await callback?.({
        text: "I couldn't determine the current conversation.",
        source: "signal",
      });
      return { success: false, error: "Could not determine conversation" };
    }

    let targetRecipient = room.channelId || "";
    const isGroup = room.metadata?.isGroup || false;

    // If a specific recipient was provided
    if (messageInfo.recipient && messageInfo.recipient !== "current") {
      const normalized = normalizeE164(messageInfo.recipient);
      if (normalized) {
        targetRecipient = normalized;
      } else if (isValidGroupId(messageInfo.recipient)) {
        targetRecipient = messageInfo.recipient;
      }
    }

    let result: { timestamp: number };
    if (isGroup || isValidGroupId(targetRecipient)) {
      result = await signalService.sendGroupMessage(targetRecipient, messageInfo.text);
    } else {
      result = await signalService.sendMessage(targetRecipient, messageInfo.text);
    }

    const response: Content = {
      text: "Message sent successfully.",
      source: message.content.source || "signal",
    };

    runtime.logger.debug(
      {
        src: "plugin:signal:action:send-message",
        timestamp: result.timestamp,
        recipient: targetRecipient,
      },
      "[SIGNAL_SEND_MESSAGE] Message sent successfully"
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        timestamp: result.timestamp,
        recipient: targetRecipient,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a message to +1234567890 saying 'Hello!'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message for you.",
          actions: ["SIGNAL_SEND_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default sendMessage;

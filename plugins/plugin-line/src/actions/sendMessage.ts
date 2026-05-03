/**
 * Send message action for the LINE plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import type { LineService } from "../service.js";
import { isValidLineId, LINE_SERVICE_NAME, normalizeLineTarget } from "../types.js";

const SEND_MESSAGE_TEMPLATE = `# Task: Extract LINE message parameters

Based on the conversation, determine what message to send and to whom.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message content to send
2. to: The target user/group/room ID (or "current" to reply to the current chat)

Respond with a JSON object:
\`\`\`json
{
  "text": "message to send",
  "to": "target ID or 'current'"
}
\`\`\`
`;

interface SendMessageParams {
  text: string;
  to: string;
}

export const sendMessage: Action = {
  name: "LINE_SEND_MESSAGE",
  similes: ["SEND_LINE_MESSAGE", "LINE_MESSAGE", "LINE_TEXT", "MESSAGE_LINE"],
  description: "Send a text message via LINE",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["line", "send", "message"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:line|send|message)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "line";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State
    ): Promise<boolean> => {
      return message.content.source === "line";
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const lineService = runtime.getService(LINE_SERVICE_NAME) as unknown as LineService | undefined;

    if (!lineService?.isConnected()) {
      if (callback) {
        callback({ text: "LINE service is not available.", source: "line" });
      }
      return { success: false, error: "LINE service not available" };
    }

    const currentState = state ?? (await runtime.composeState(message));

    // Extract parameters using LLM
    const prompt = composePromptFromState({
      template: SEND_MESSAGE_TEMPLATE,
      state: currentState,
    });

    let msgInfo: SendMessageParams | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response);
      if (parsed?.text) {
        msgInfo = {
          text: String(parsed.text),
          to: String(parsed.to || "current"),
        };
        break;
      }
    }

    if (!msgInfo?.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "line",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target
    let targetId: string | undefined;

    if (msgInfo.to && msgInfo.to !== "current") {
      const normalized = normalizeLineTarget(msgInfo.to);
      if (normalized && isValidLineId(normalized)) {
        targetId = normalized;
      }
    }

    // Fall back to current chat
    if (!targetId) {
      const stateData = (currentState.data || {}) as Record<string, unknown>;
      targetId =
        (stateData.groupId as string) ||
        (stateData.roomId as string) ||
        (stateData.userId as string);
    }

    if (!targetId) {
      if (callback) {
        callback({
          text: "I couldn't determine where to send the message. Please specify a target.",
          source: "line",
        });
      }
      return { success: false, error: "Could not determine target" };
    }

    // Send message
    const result = await lineService.sendMessage(targetId, msgInfo.text);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to send message: ${result.error}`,
          source: "line",
        });
      }
      return { success: false, error: result.error };
    }

    logger.debug(`Sent LINE message to ${targetId}`);

    if (callback) {
      callback({
        text: "Message sent successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      text: "Message sent successfully",
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send them a message saying 'Hello!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message via LINE.",
          actions: ["LINE_SEND_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Message the group saying 'Meeting in 5 minutes'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that to the group.",
          actions: ["LINE_SEND_MESSAGE"],
        },
      },
    ],
  ],
};

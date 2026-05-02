/**
 * Send DM action for Instagram
 */

import type {
  Action,
  ActionExample,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME } from "../constants";
import type { InstagramService } from "../service";

/**
 * Action to send a direct message on Instagram
 */
export const sendDmAction: Action = {
  name: "SEND_INSTAGRAM_DM",
  description: "Send a direct message to an Instagram user",
  similes: [
    "instagram_dm",
    "instagram_message",
    "send_instagram_message",
    "dm_instagram",
    "direct_message_instagram",
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a message to this Instagram thread",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the Instagram thread now.",
          action: "SEND_INSTAGRAM_DM",
        },
      },
    ],
  ] as ActionExample[][],

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["send", "instagram", "dm"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegexOk = /\b(?:send|instagram|dm)\b/i.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "instagram";
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

    const __avLegacyValidate = async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
      // Check if this is an Instagram message with a thread ID
      const content = message.content as Record<string, unknown>;
      const source = content.source as string | undefined;
      const threadId = content.threadId as string | undefined;

      if (source !== "instagram") {
        return false;
      }

      if (!threadId) {
        return false;
      }

      // Check if Instagram service is available
      const service = runtime.getService(INSTAGRAM_SERVICE_NAME);
      if (!service) {
        return false;
      }

      return true;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) {
    const service = runtime.getService(INSTAGRAM_SERVICE_NAME) as InstagramService;
    if (!service || !service.getIsRunning()) {
      if (callback) {
        await callback({
          text: "Instagram service is not running",
        });
      }
      return { success: false, error: "Service not available" };
    }

    const content = message.content as Record<string, unknown>;
    const threadId = content.threadId as string | undefined;

    if (!threadId) {
      if (callback) {
        await callback({
          text: "No thread ID provided for Instagram DM",
        });
      }
      return { success: false, error: "Missing thread ID" };
    }

    // Get response text from state or message
    const responseText =
      ((state?.response as Record<string, unknown> | undefined)?.text as string | undefined) ||
      (content.text as string | undefined) ||
      "";

    if (!responseText) {
      if (callback) {
        await callback({
          text: "No message text to send",
        });
      }
      return { success: false, error: "Empty message" };
    }

    try {
      const messageId = await service.sendDirectMessage(threadId, responseText);

      if (callback) {
        await callback({
          text: `Message sent to Instagram thread ${threadId}`,
          action: "SEND_INSTAGRAM_DM",
        });
      }

      return { success: true, data: { threadId, messageId } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({
          text: `Failed to send Instagram DM: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },
};

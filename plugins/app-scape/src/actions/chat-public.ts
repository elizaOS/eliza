/**
 * CHAT_PUBLIC — broadcast a short message in public chat. The LLM
 * can use this to narrate what it's doing, ask other players for
 * help, or respond to operator prompts.
 *
 * Expected LLM response format:
 *
 *   action: CHAT_PUBLIC
 *   message: Heading to the bank to stash my logs.
 *
 * Server-side: `BotSdkActionRouter.chatPublic` → `MessagingService.queueChatMessage`.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ScapeGameService } from "../services/game-service.js";
import { hasActionRequest, resolveActionText } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

const MAX_MESSAGE_LENGTH = 80;

export const chatPublic: Action = {
  name: "CHAT_PUBLIC",
  description:
    "Say something in public chat so nearby players and agents can see it. Use to narrate, socialize, or respond to operator prompts.",
  descriptionCompressed: "Say something in public chat.",
  contexts: ["game", "automation", "world", "state", "messaging"],
  roleGate: { minRole: "ADMIN" },
  similes: ["SAY", "SPEAK", "TALK", "BROADCAST"],
  examples: [],
  parameters: [
    {
      name: "message",
      description: "Public chat text to send, capped to 80 characters.",
      descriptionCompressed: "Chat text.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionRequest(message, "CHAT_PUBLIC");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
    if (!service) {
      const errMsg = "'scape game service not available.";
      callback?.({ text: errMsg, action: "CHAT_PUBLIC" });
      return { success: false, text: errMsg };
    }

    const llmText = resolveActionText(message);
    const chatMessage =
      extractParam(llmText, "message") ?? extractParam(llmText, "text");
    if (!chatMessage) {
      const err = "CHAT_PUBLIC requires message: text.";
      callback?.({ text: err, action: "CHAT_PUBLIC" });
      return { success: false, text: err };
    }

    const trimmed = chatMessage.slice(0, MAX_MESSAGE_LENGTH);
    try {
      const result = await service.executeAction({
        action: "chatPublic",
        text: trimmed,
      });
      const displayText =
        result.message ??
        (result.success ? `said "${trimmed}"` : "chat failed");
      callback?.({ text: displayText, action: "CHAT_PUBLIC" });
      return { success: result.success, text: displayText };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown chat failure.";
      const displayText = `chat failed: ${message}`;
      callback?.({ text: displayText, action: "CHAT_PUBLIC" });
      return {
        success: false,
        text: displayText,
        error: message,
        data: { action: "chatPublic" },
      };
    }
  },
};

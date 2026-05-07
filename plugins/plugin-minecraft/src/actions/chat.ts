import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { JsonValue } from "../protocol.js";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";
import { emit, mergedInput, readString } from "./helpers.js";

const ACTION_NAME = "MC_CHAT";

export const minecraftChatAction: Action = {
  name: ACTION_NAME,
  contexts: ["messaging", "automation", "media"],
  contextGate: { anyOf: ["messaging", "automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_SAY", "MC_MESSAGE"],
  description: "Send a chat message in Minecraft.",
  descriptionCompressed: "Send chat message in Minecraft.",
  parameters: [
    {
      name: "message",
      description: "Chat text to send.",
      descriptionCompressed: "chat text",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    return /\b(chat|say|tell|message)\b/i.test(message.content.text ?? "");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!service) return { text: "Minecraft service is not available", success: false };

    const params = mergedInput(message, options);
    const text = readString(params, "message", "text") ?? (message.content.text ?? "").trim();
    if (!text) {
      return emit(ACTION_NAME, callback, "No chat message provided.", message.content.source, {
        success: false,
      });
    }

    try {
      await service.chat(text);
      return await emit(
        ACTION_NAME,
        callback,
        `Sent Minecraft chat: ${text}`,
        message.content.source,
        { success: true, values: { sent: true } }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Chat failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Say hello in chat." } },
      {
        name: "{{agent}}",
        content: { text: "Sending chat.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};

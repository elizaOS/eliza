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
import { emit, withMinecraftTimeout } from "./helpers.js";

const ACTION_NAME = "MC_DISCONNECT";

export const minecraftDisconnectAction: Action = {
  name: ACTION_NAME,
  contexts: ["connectors", "automation", "media"],
  contextGate: { anyOf: ["connectors", "automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_LEAVE", "MC_QUIT"],
  description: "Disconnect the active Minecraft bot session.",
  descriptionCompressed: "Disconnect Minecraft bot.",
  parameters: [],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    return /\b(disconnect|leave|quit)\b/i.test(message.content.text ?? "");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!service) return { text: "Minecraft service is not available", success: false };

    const session = service.getCurrentSession();
    if (!session) {
      return emit(ACTION_NAME, callback, "No Minecraft bot is connected.", message.content.source, {
        success: false,
      });
    }

    try {
      await withMinecraftTimeout(service.destroyBot(session.botId), "minecraft disconnect");
      return await emit(
        ACTION_NAME,
        callback,
        "Disconnected Minecraft bot.",
        message.content.source,
        { success: true, values: { connected: false } }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Disconnect failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Disconnect the bot." } },
      {
        name: "{{agent}}",
        content: { text: "Disconnecting.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { z } from "zod";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

const connectOverridesSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    username: z.string().optional(),
    auth: z.enum(["offline", "microsoft"]).optional(),
    version: z.string().optional(),
  })
  .passthrough();

function parseOverrides(text: string): Record<string, string | number> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, string | number>;
    const validated = connectOverridesSchema.parse(parsed);
    const out: Record<string, string | number> = {};
    if (typeof validated.host === "string") out.host = validated.host;
    if (typeof validated.port === "number") out.port = validated.port;
    if (typeof validated.username === "string")
      out.username = validated.username;
    if (typeof validated.auth === "string") out.auth = validated.auth;
    if (typeof validated.version === "string") out.version = validated.version;
    return out;
  } catch {
    return {};
  }
}

export const minecraftConnectAction: Action = {
  name: "MC_CONNECT",
  similes: ["MINECRAFT_CONNECT", "JOIN_SERVER", "CONNECT_TO_MINECRAFT"],
  description: "Connect the Mineflayer bot to a Minecraft server",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    if (!service) {
      return { text: "Minecraft service is not available", success: false };
    }

    try {
      const overrides = parseOverrides(message.content.text ?? "");
      const session = await service.createBot(overrides);

      const content: Content = {
        text: `Connected Minecraft bot (botId=${session.botId}).`,
        actions: ["MC_CONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: true,
        data: { botId: session.botId },
        values: { connected: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to connect Minecraft bot: ${msg}`,
        actions: ["MC_CONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: false,
        data: { error: msg },
        values: { connected: false },
      };
    }
  },
};

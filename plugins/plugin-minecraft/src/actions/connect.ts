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
import type { JsonObject, JsonValue } from "../protocol.js";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";
import { emit, mergedInput, readNumber, readString } from "./helpers.js";

const ACTION_NAME = "MC_CONNECT";

function parseConnectOverrides(params: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  const host = readString(params, "host");
  const port = readNumber(params, "port");
  const username = readString(params, "username");
  const auth = readString(params, "auth");
  const version = readString(params, "version");

  if (host) out.host = host;
  if (port !== null && Number.isInteger(port) && port > 0) out.port = port;
  if (username) out.username = username;
  if (auth === "offline" || auth === "microsoft") out.auth = auth;
  if (version) out.version = version;
  return out;
}

export const minecraftConnectAction: Action = {
  name: ACTION_NAME,
  contexts: ["connectors", "automation", "media"],
  contextGate: { anyOf: ["connectors", "automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_JOIN", "MINECRAFT_CONNECT"],
  description: "Connect a Minecraft bot to a server, optionally overriding host/port/auth.",
  descriptionCompressed: "Connect Minecraft bot to server.",
  parameters: [
    {
      name: "host",
      description: "Server host override.",
      descriptionCompressed: "server host",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "port",
      description: "Server port override.",
      descriptionCompressed: "server port",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "username",
      description: "Minecraft username override.",
      descriptionCompressed: "username",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "auth",
      description: "Auth mode (offline or microsoft).",
      descriptionCompressed: "auth mode",
      required: false,
      schema: { type: "string", enum: ["offline", "microsoft"] },
    },
    {
      name: "version",
      description: "Minecraft version override.",
      descriptionCompressed: "version",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    const text = message.content.text ?? "";
    return /\b(connect|join)\b/i.test(text) || text.trim().startsWith("{");
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
    try {
      const session = await service.createBot(parseConnectOverrides(params));
      return await emit(
        ACTION_NAME,
        callback,
        `Connected Minecraft bot (botId=${session.botId}).`,
        message.content.source,
        {
          success: true,
          data: { botId: session.botId },
          values: { connected: true },
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Connect failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Connect the Minecraft bot." },
      },
      {
        name: "{{agent}}",
        content: { text: "Connecting bot.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};

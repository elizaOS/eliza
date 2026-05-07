import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { type JsonValue, ROBLOX_SERVICE_NAME } from "../types";

const actionName = "SEND_ROBLOX_MESSAGE";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readParams(
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  return isRecord(options) && isRecord(options.parameters) ? options.parameters : {};
}

function mergedInput(
  message: Memory,
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  return {
    ...parseJsonObject(message.content.text ?? ""),
    ...readParams(options),
  };
}

function readString(params: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(params: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readTargetPlayerIds(params: Record<string, unknown>, text: string): number[] | undefined {
  const explicit = params.targetPlayerIds;
  if (Array.isArray(explicit)) {
    const ids = explicit
      .map((value) =>
        typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
      )
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length) return ids;
  }

  const single = readNumber(params, "targetPlayerId", "playerId", "userId");
  if (single !== null && Number.isInteger(single) && single > 0) return [single];

  const matches = [...text.matchAll(/\bplayer\s*(\d+)\b/gi)];
  return matches.length ? matches.map((match) => Number.parseInt(match[1], 10)) : undefined;
}

export const sendRobloxMessage: Action = {
  name: actionName,
  contexts: ["media", "messaging"],
  contextGate: { anyOf: ["media", "messaging"] },
  similes: ["ROBLOX_SEND", "ROBLOX_CHAT", "ROBLOX_ANNOUNCE"],
  description:
    "Send a chat or announcement message into the connected Roblox experience, optionally targeting specific player IDs.",
  descriptionCompressed: "Send chat message in Roblox game.",
  parameters: [
    {
      name: "message",
      description: "Message content to send into the Roblox experience.",
      descriptionCompressed: "message text",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "targetPlayerIds",
      description: "Roblox player IDs to target. Omit to broadcast to all players.",
      descriptionCompressed: "target player ids",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text ?? "";
    const params = parseJsonObject(text);
    const hasIntent =
      readString(params, "message", "text", "content") !== null ||
      /\b(send|message|tell|announce|chat|say)\b/i.test(text);
    if (!hasIntent) return false;

    const apiKey = runtime.getSetting("ROBLOX_API_KEY");
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID");
    return Boolean(apiKey && universeId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
    if (!service) {
      logger.error("Roblox service not found");
      await callback?.({ text: "Roblox service not available.", action: actionName });
      return { success: false, error: "Roblox service not found" };
    }

    const params = mergedInput(message, options);
    const content =
      readString(params, "message", "text", "content") ??
      (typeof state?.message === "string" ? state.message : undefined) ??
      (message.content.text ?? "").trim();

    if (!content) {
      await callback?.({
        text: "I need a message to send to the Roblox game.",
        action: actionName,
      });
      return { success: false, error: "No message content to send" };
    }

    const targetPlayerIds = readTargetPlayerIds(params, content);
    await service.sendMessage(runtime.agentId, content, targetPlayerIds);

    const targetText =
      targetPlayerIds && targetPlayerIds.length > 0
        ? `to ${targetPlayerIds.length} player(s)`
        : "to all players";
    await callback?.({ text: `Sent Roblox message ${targetText}.`, action: actionName });
    return {
      success: true,
      text: `Sent Roblox message ${targetText}`,
      data: { targetPlayerIds, messageLength: content.length },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell everyone in Roblox that the event starts now" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send that message to the Roblox game.",
          action: actionName,
        },
      },
    ],
  ] as ActionExample[][],
};

export default sendRobloxMessage;

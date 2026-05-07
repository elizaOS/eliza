import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { RobloxService } from "../services/RobloxService";
import { ROBLOX_SERVICE_NAME, type RobloxUser } from "../types";

const providerName = "robloxPlayer";

type PlayerIdentifier = { type: "id"; value: number } | { type: "username"; value: string };

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

function extractIdentifier(text: string, params: Record<string, unknown>): PlayerIdentifier | null {
  const userId = readNumber(params, "playerId", "userId", "id");
  if (userId !== null && Number.isInteger(userId) && userId > 0) {
    return { type: "id", value: userId };
  }

  const username = readString(params, "username", "playerName", "user");
  if (username && !/^\d+$/.test(username)) {
    return { type: "username", value: username };
  }

  const idMatch = text.match(/\b(?:player|user|id)\s*[:#]?\s*(\d{5,})\b/i);
  if (idMatch) {
    return { type: "id", value: Number.parseInt(idMatch[1], 10) };
  }

  const usernameMatch = text.match(/\b(?:user(?:name)?|player)\s*[:#]?\s*([A-Za-z0-9_]{3,20})\b/i);
  if (usernameMatch && !/^\d+$/.test(usernameMatch[1])) {
    return { type: "username", value: usernameMatch[1] };
  }

  return null;
}

function formatPlayerJson(user: RobloxUser): string {
  const lines: string[] = ["robloxPlayer:"];
  lines.push(`id: ${user.id}`);
  lines.push(`username: ${user.username}`);
  lines.push(`displayName: ${user.displayName}`);
  if (typeof user.isBanned === "boolean") {
    lines.push(`banned: ${user.isBanned}`);
  }
  if (user.avatarUrl) {
    lines.push(`avatarUrl: ${user.avatarUrl}`);
  }
  if (user.createdAt) {
    lines.push(`createdAt: ${user.createdAt.toISOString()}`);
  }
  return lines.join("\n");
}

export const robloxPlayerProvider: Provider = {
  name: providerName,
  description:
    "Resolve a Roblox player by ID or username from the current message and surface their public profile as JSON context.",
  descriptionCompressed: "Look up Roblox player by id or username.",
  get: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<ProviderResult> => {
    const service = runtime.getService<RobloxService>(ROBLOX_SERVICE_NAME);
    if (!service) {
      return {
        text: "",
        data: { resolved: false, reason: "service-unavailable" },
        values: { resolved: false },
      };
    }

    const client = service.getClient(runtime.agentId);
    if (!client) {
      return {
        text: "",
        data: { resolved: false, reason: "client-unavailable" },
        values: { resolved: false },
      };
    }

    const text = message.content.text ?? "";
    const params = parseJsonObject(text);
    const identifier = extractIdentifier(text, params);
    if (!identifier) {
      return {
        text: "",
        data: { resolved: false, reason: "no-identifier" },
        values: { resolved: false },
      };
    }

    const user =
      identifier.type === "id"
        ? await client.getUserById(identifier.value)
        : await client.getUserByUsername(identifier.value);

    if (!user) {
      return {
        text: `robloxPlayer:\nresolved: false\n${identifier.type}: ${identifier.value}`,
        data: { resolved: false, identifier },
        values: { resolved: false },
      };
    }

    const avatarUrl = await client.getAvatarUrl(user.id);
    user.avatarUrl = avatarUrl;

    return {
      text: formatPlayerJson(user),
      data: {
        resolved: true,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: avatarUrl || undefined,
        isBanned: user.isBanned,
        createdAt: user.createdAt ? user.createdAt.toISOString() : undefined,
      },
      values: {
        resolved: true,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
      },
    };
  },
};

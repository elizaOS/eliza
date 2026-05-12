/**
 * Bridges Eliza session keys with elizaOS rooms.
 *
 * Eliza keys: agent:{agentId}:main (DMs), agent:{agentId}:{channel}:group:{id} (groups)
 * elizaOS rooms: per-agent UUIDs via createUniqueUuid(runtime, channelId)
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
} from "@elizaos/core";
import * as elizaCore from "@elizaos/core";

type ElizaCoreSessionHelpers = {
  buildAgentMainSessionKey?: (params: {
    agentId: string;
    mainKey: string;
  }) => string;
  ChannelType?: {
    DM: number | string;
    SELF: number | string;
    GROUP: number | string;
  };
  parseAgentSessionKey?: (key: string) =>
    | {
        agentId?: string;
      }
    | undefined;
};

const coreSessionHelpers = elizaCore as ElizaCoreSessionHelpers;
// Fallback for when ChannelType is not exported by @elizaos/core (e.g. in tests)
const channelType = coreSessionHelpers.ChannelType ?? {
  DM: "DM",
  SELF: "SELF",
  GROUP: "GROUP",
};

function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey: string;
}): string {
  if (typeof coreSessionHelpers.buildAgentMainSessionKey === "function") {
    return coreSessionHelpers.buildAgentMainSessionKey(params);
  }
  return `agent:${params.agentId}:${params.mainKey}`;
}

function parseAgentSessionKey(key: string):
  | {
      agentId?: string;
    }
  | undefined {
  if (typeof coreSessionHelpers.parseAgentSessionKey === "function") {
    return coreSessionHelpers.parseAgentSessionKey(key);
  }
  return undefined;
}

/**
 * Resolve an Eliza session key from an elizaOS room.
 *
 * DMs -> agent:{agentId}:main
 * Groups -> agent:{agentId}:{channel}:group:{groupId}
 * Channels -> agent:{agentId}:{channel}:channel:{channelId}
 * Threads append :thread:{threadId}
 */
export function resolveSessionKeyFromRoom(
  agentId: string,
  room: Room,
  meta?: { threadId?: string; groupId?: string; channel?: string },
): string {
  const channel = meta?.channel ?? room.source ?? "unknown";

  if (room.type === channelType.DM || room.type === channelType.SELF) {
    return buildAgentMainSessionKey({ agentId, mainKey: "main" });
  }

  const id = meta?.groupId ?? room.channelId ?? room.id;
  const kind = room.type === channelType.GROUP ? "group" : "channel";
  const base = `agent:${agentId}:${channel}:${kind}:${id}`;
  return meta?.threadId ? `${base}:thread:${meta.threadId}` : base;
}

export function createSessionKeyProvider(options?: {
  defaultAgentId?: string;
}): Provider {
  const agentId = options?.defaultAgentId ?? "main";

  return {
    name: "elizaSessionBridge",
    description: "Eliza session key (DM/group/thread isolation)",
    dynamic: true,
    position: 5,
    contexts: ["general", "messaging"],
    contextGate: { anyOf: ["general", "messaging"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const meta = (message.metadata ?? {}) as Record<string, unknown>;
      const existing =
        typeof meta.sessionKey === "string" ? meta.sessionKey : undefined;

      if (existing) {
        const parsed = parseAgentSessionKey(existing);
        return {
          text: `Session: ${existing}`,
          values: { sessionKey: existing, agentId: parsed?.agentId ?? agentId },
          data: { sessionKey: existing },
        };
      }

      const room = await runtime.getRoom(message.roomId);
      if (!room) {
        const key = buildAgentMainSessionKey({ agentId, mainKey: "main" });
        return {
          text: `Session: ${key}`,
          values: { sessionKey: key },
          data: { sessionKey: key },
        };
      }

      const key = resolveSessionKeyFromRoom(agentId, room, {
        threadId: typeof meta.threadId === "string" ? meta.threadId : undefined,
        groupId: typeof meta.groupId === "string" ? meta.groupId : undefined,
        channel:
          (typeof meta.channel === "string" ? meta.channel : undefined) ??
          room.source,
      });

      return {
        text: `Session: ${key}`,
        values: { sessionKey: key, isGroup: room.type === channelType.GROUP },
        data: { sessionKey: key },
      };
    },
  };
}

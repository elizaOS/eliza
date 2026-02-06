/**
 * Bridges Milaidy session keys with ElizaOS rooms.
 *
 * Milaidy keys: agent:{agentId}:main (DMs), agent:{agentId}:{channel}:group:{id} (groups)
 * ElizaOS rooms: per-agent UUIDs via createUniqueUuid(runtime, channelId)
 */

import type { IAgentRuntime, Memory, State, Provider, ProviderResult, Room } from "@elizaos/core";
import { buildAgentMainSessionKey, parseAgentSessionKey, ChannelType } from "@elizaos/core";

/**
 * Resolve an Milaidy session key from an ElizaOS room.
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

  if (room.type === ChannelType.DM || room.type === ChannelType.SELF) {
    return buildAgentMainSessionKey({ agentId, mainKey: "main" });
  }

  const id = meta?.groupId ?? room.channelId ?? room.id;
  const kind = room.type === ChannelType.GROUP ? "group" : "channel";
  const base = `agent:${agentId}:${channel}:${kind}:${id}`;
  return meta?.threadId ? `${base}:thread:${meta.threadId}` : base;
}

export function createSessionKeyProvider(options?: { defaultAgentId?: string }): Provider {
  const agentId = options?.defaultAgentId ?? "main";

  return {
    name: "milaidySessionKey",
    description: "Milaidy session key (DM/group/thread isolation)",
    dynamic: true,
    position: 5,

    async get(runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> {
      const meta = (message.metadata ?? {}) as Record<string, unknown>;
      const existing = meta.sessionKey as string | undefined;

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
        return { text: `Session: ${key}`, values: { sessionKey: key }, data: { sessionKey: key } };
      }

      const key = resolveSessionKeyFromRoom(agentId, room, {
        threadId: meta.threadId as string | undefined,
        groupId: meta.groupId as string | undefined,
        channel: (meta.channel as string | undefined) ?? room.source,
      });

      return {
        text: `Session: ${key}`,
        values: { sessionKey: key, isGroup: room.type === ChannelType.GROUP },
        data: { sessionKey: key },
      };
    },
  };
}

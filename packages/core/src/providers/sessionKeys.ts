/**
 * Bridges Eliza session keys with ElizaOS rooms.
 *
 * Eliza keys: agent:{agentId}:main (DMs), agent:{agentId}:{channel}:group:{id} (groups)
 * ElizaOS rooms: per-agent UUIDs via createUniqueUuid(runtime, channelId)
 */

import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type Provider,
	type ProviderResult,
	type Room,
	type State,
} from "../types";

// Internal helper to avoid circular dependency issues if needed,
// though here we are in core so we can just implement logically.
// The original code used `elizaCore as ElizaCoreSessionHelpers` which suggests
// circular dependency workaround or loose typing.
// For now, I will keep the logic but clean up the imports since we ARE in core.

function buildAgentMainSessionKey(params: {
	agentId: string;
	mainKey: string;
}): string {
	return `agent:${params.agentId}:${params.mainKey}`;
}

function parseAgentSessionKey(key: string):
	| {
			agentId?: string;
	  }
	| undefined {
	// Simple parsing based on the format: agent:{agentId}:{rest}
	const parts = key.split(":");
	if (parts.length >= 2 && parts[0] === "agent") {
		return { agentId: parts[1] };
	}
	return undefined;
}

/**
 * Resolve an Eliza session key from an ElizaOS room.
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
	// In core, string enums might be different.
	// Ensure we match the room.type correctly.
	const isDmOrSelf =
		room.type === ChannelType.DM || room.type === ChannelType.SELF;
	const isGroup = room.type === ChannelType.GROUP;

	const channel = meta?.channel ?? room.source ?? "unknown";

	if (isDmOrSelf) {
		return buildAgentMainSessionKey({ agentId, mainKey: "main" });
	}

	const id = meta?.groupId ?? room.channelId ?? room.id;
	const kind = isGroup ? "group" : "channel";
	const base = `agent:${agentId}:${channel}:${kind}:${id}`;
	return meta?.threadId ? `${base}:thread:${meta.threadId}` : base;
}

export function createSessionKeyProvider(options?: {
	defaultAgentId?: string;
}): Provider {
	const agentId = options?.defaultAgentId ?? "main";

	return {
		name: "elizaSessionKey",
		description: "Eliza session key (DM/group/thread isolation)",
		contexts: ["general", "messaging"],
		contextGate: { anyOf: ["general", "messaging"] },
		cacheStable: false,
		cacheScope: "turn",
		roleGate: { minRole: "USER" },

		get: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state: State,
		): Promise<ProviderResult> => {
			const meta = (message.metadata ?? {}) as Record<string, unknown>;
			const existing =
				typeof meta.sessionKey === "string" ? meta.sessionKey : undefined;

			if (existing) {
				const parsed = parseAgentSessionKey(existing);
				return {
					text: `Session: ${existing}`,
					values: {
						sessionKey: existing,
						agentId: parsed?.agentId ?? agentId,
					},
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
				values: { sessionKey: key, isGroup: room.type === ChannelType.GROUP },
				data: { sessionKey: key },
			};
		},
	};
}

import type {
	AgentContext,
	IAgentRuntime,
	Memory,
	MessageConnector,
	MessageConnectorChatContext,
	MessageConnectorChatMessageContext,
	MessageConnectorQueryContext,
	MessageConnectorUserContext,
	Metadata,
	Provider,
	ProviderResult,
	ProviderValue,
	State,
	TargetInfo,
} from "../../../types/index.ts";
import {
	getActiveRoutingContextsForTurn,
	getExplicitRoutingContexts,
	routingContextsOverlap,
} from "../../../utils/context-routing.ts";

export const PLATFORM_CHAT_CONTEXT_PROVIDER_NAME = "PLATFORM_CHAT_CONTEXT";
export const PLATFORM_USER_CONTEXT_PROVIDER_NAME = "PLATFORM_USER_CONTEXT";

const PLATFORM_CONTEXTS: AgentContext[] = ["social", "phone", "connectors"];
const MAX_CONNECTOR_CONTEXTS = 8;
const MAX_RECENT_MESSAGES = 10;

type RuntimeWithMessageConnectors = IAgentRuntime & {
	getMessageConnectors?: () => MessageConnector[];
};

type RoomLike = {
	id?: string;
	source?: string;
	channelId?: string;
	serverId?: string;
	type?: string;
	name?: string;
	metadata?: Metadata;
};

function cleanRecord<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	) as T;
}

function toProviderValue(value: unknown, depth = 0): ProviderValue {
	if (value === undefined) {
		return undefined;
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value as ProviderValue;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (depth > 4) {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toProviderValue(entry, depth + 1));
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === "object") {
		const out: Record<string, ProviderValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (typeof entry === "function" || typeof entry === "symbol") {
				continue;
			}
			const normalized = toProviderValue(entry, depth + 1);
			if (normalized !== undefined) {
				out[key] = normalized;
			}
		}
		return out;
	}
	return String(value);
}

function getRuntimeMessageConnectors(
	runtime: IAgentRuntime,
): MessageConnector[] {
	const runtimeWithConnectors = runtime as RuntimeWithMessageConnectors;
	if (typeof runtimeWithConnectors.getMessageConnectors !== "function") {
		return [];
	}

	return runtimeWithConnectors
		.getMessageConnectors()
		.filter((connector) => connector && typeof connector.source === "string");
}

function getMemorySource(
	message: Memory,
	room: RoomLike | null,
): string | undefined {
	const contentSource =
		typeof message.content?.source === "string"
			? message.content.source.trim()
			: "";
	if (contentSource) {
		return contentSource;
	}
	const roomSource = typeof room?.source === "string" ? room.source.trim() : "";
	return roomSource || undefined;
}

function getRoomThreadId(room: RoomLike | null): string | undefined {
	const threadId = room?.metadata?.threadId ?? room?.metadata?.threadTs;
	return typeof threadId === "string" && threadId.trim() ? threadId : undefined;
}

function buildCurrentTarget(
	message: Memory,
	room: RoomLike | null,
	source: string | undefined,
): TargetInfo {
	return cleanRecord({
		source,
		roomId: message.roomId,
		entityId: message.entityId,
		channelId: room?.channelId,
		serverId: room?.serverId,
		threadId: getRoomThreadId(room),
	}) as TargetInfo;
}

function buildQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	source: string | undefined,
	activeContexts: AgentContext[],
): MessageConnectorQueryContext {
	return cleanRecord({
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		contexts: activeContexts,
		metadata: message.content?.metadata as Metadata | undefined,
	});
}

function connectorMatchesSource(
	connector: MessageConnector,
	source: string | undefined,
): boolean {
	return Boolean(
		source &&
			connector.source.trim().toLowerCase() === source.trim().toLowerCase(),
	);
}

function connectorMatchesExplicitContext(
	connector: MessageConnector,
	activeContexts: AgentContext[],
): boolean {
	const explicitContexts = getExplicitRoutingContexts(activeContexts);
	if (explicitContexts.length === 0) {
		return false;
	}
	const connectorContexts =
		connector.contexts && connector.contexts.length > 0
			? connector.contexts
			: PLATFORM_CONTEXTS;
	return routingContextsOverlap(connectorContexts, explicitContexts);
}

function filterContextRelevantConnectors(
	connectors: MessageConnector[],
	source: string | undefined,
	activeContexts: AgentContext[],
): MessageConnector[] {
	const sourceMatches = connectors.filter((connector) =>
		connectorMatchesSource(connector, source),
	);
	if (source) {
		return sourceMatches;
	}

	return connectors.filter((connector) =>
		connectorMatchesExplicitContext(connector, activeContexts),
	);
}

async function getCurrentRoom(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): Promise<RoomLike | null> {
	const stateRoom = state.data?.room as RoomLike | undefined;
	if (stateRoom?.id || stateRoom?.channelId || stateRoom?.source) {
		return stateRoom;
	}
	return (await runtime.getRoom(message.roomId)) as RoomLike | null;
}

function normalizeRecentMessage(
	message: MessageConnectorChatMessageContext,
): Record<string, ProviderValue> {
	return cleanRecord({
		entityId: message.entityId,
		name: message.name,
		text: message.text,
		timestamp: message.timestamp,
		metadata: toProviderValue(message.metadata),
	});
}

function normalizeChatContext(
	connector: MessageConnector,
	context: MessageConnectorChatContext,
): Record<string, ProviderValue> {
	return cleanRecord({
		source: connector.source,
		connector: connector.label,
		label: context.label,
		summary: context.summary,
		target: toProviderValue(context.target),
		recentMessages: (context.recentMessages ?? [])
			.slice(-MAX_RECENT_MESSAGES)
			.map(normalizeRecentMessage),
		metadata: toProviderValue(context.metadata),
	});
}

function normalizeUserContext(
	connector: MessageConnector,
	context: MessageConnectorUserContext,
): Record<string, ProviderValue> {
	return cleanRecord({
		source: connector.source,
		connector: connector.label,
		entityId: context.entityId,
		label: context.label,
		aliases: context.aliases,
		handles: toProviderValue(context.handles),
		metadata: toProviderValue(context.metadata),
	});
}

function renderJson(payload: Record<string, ProviderValue>): string {
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return "";
	}
}

function emptyResult(data: Record<string, ProviderValue> = {}): ProviderResult {
	return {
		text: "",
		values: data,
		data,
	};
}

export const platformChatContextProvider: Provider = {
	name: PLATFORM_CHAT_CONTEXT_PROVIDER_NAME,
	description:
		"Current platform chat context from registered message connectors.",
	descriptionCompressed:
		"Current chat/room context from relevant message connector hooks.",
	dynamic: true,
	position: 125,
	contexts: PLATFORM_CONTEXTS,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		const connectors = getRuntimeMessageConnectors(runtime).filter(
			(connector) => typeof connector.getChatContext === "function",
		);
		if (connectors.length === 0) {
			return emptyResult({ connectorCount: 0, chatContextCount: 0 });
		}

		const room = await getCurrentRoom(runtime, message, state);
		const source = getMemorySource(message, room);
		const activeContexts = getActiveRoutingContextsForTurn(state, message);
		const relevantConnectors = filterContextRelevantConnectors(
			connectors,
			source,
			activeContexts,
		).slice(0, MAX_CONNECTOR_CONTEXTS);
		if (relevantConnectors.length === 0) {
			return emptyResult({
				connectorCount: connectors.length,
				relevantConnectorCount: 0,
				chatContextCount: 0,
			});
		}

		const queryContext = buildQueryContext(
			runtime,
			message,
			source,
			activeContexts,
		);
		const target = buildCurrentTarget(message, room, source);
		const contexts: Record<string, ProviderValue>[] = [];

		for (const connector of relevantConnectors) {
			try {
				const context = await connector.getChatContext?.(target, queryContext);
				if (!context) {
					continue;
				}
				contexts.push(normalizeChatContext(connector, context));
			} catch (error) {
				runtime.logger.debug(
					{
						src: "provider:platformChatContext",
						agentId: runtime.agentId,
						connector: connector.source,
						error: error instanceof Error ? error.message : String(error),
					},
					"Message connector chat context hook failed",
				);
			}
		}

		if (contexts.length === 0) {
			return emptyResult({
				connectorCount: connectors.length,
				relevantConnectorCount: relevantConnectors.length,
				chatContextCount: 0,
			});
		}

		const data = {
			source,
			roomId: message.roomId,
			entityId: message.entityId,
			connectorCount: connectors.length,
			relevantConnectorCount: relevantConnectors.length,
			chatContextCount: contexts.length,
			contexts,
		};

		return {
			text: renderJson({ platform_chat_context: data }),
			values: {
				platformChatContextCount: contexts.length,
			},
			data,
		};
	},
};

export const platformUserContextProvider: Provider = {
	name: PLATFORM_USER_CONTEXT_PROVIDER_NAME,
	description:
		"Current platform user/contact identity from registered message connectors.",
	descriptionCompressed:
		"Current user/contact identity from relevant message connector hooks.",
	dynamic: true,
	position: 126,
	contexts: PLATFORM_CONTEXTS,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		if (!message.entityId) {
			return emptyResult({ connectorCount: 0, userContextCount: 0 });
		}

		const connectors = getRuntimeMessageConnectors(runtime).filter(
			(connector) => typeof connector.getUserContext === "function",
		);
		if (connectors.length === 0) {
			return emptyResult({ connectorCount: 0, userContextCount: 0 });
		}

		const room = await getCurrentRoom(runtime, message, state);
		const source = getMemorySource(message, room);
		const activeContexts = getActiveRoutingContextsForTurn(state, message);
		const relevantConnectors = filterContextRelevantConnectors(
			connectors,
			source,
			activeContexts,
		).slice(0, MAX_CONNECTOR_CONTEXTS);
		if (relevantConnectors.length === 0) {
			return emptyResult({
				connectorCount: connectors.length,
				relevantConnectorCount: 0,
				userContextCount: 0,
			});
		}

		const queryContext = buildQueryContext(
			runtime,
			message,
			source,
			activeContexts,
		);
		const users: Record<string, ProviderValue>[] = [];

		for (const connector of relevantConnectors) {
			try {
				const context = await connector.getUserContext?.(
					message.entityId,
					queryContext,
				);
				if (!context) {
					continue;
				}
				users.push(normalizeUserContext(connector, context));
			} catch (error) {
				runtime.logger.debug(
					{
						src: "provider:platformUserContext",
						agentId: runtime.agentId,
						connector: connector.source,
						error: error instanceof Error ? error.message : String(error),
					},
					"Message connector user context hook failed",
				);
			}
		}

		if (users.length === 0) {
			return emptyResult({
				connectorCount: connectors.length,
				relevantConnectorCount: relevantConnectors.length,
				userContextCount: 0,
			});
		}

		const data = {
			source,
			roomId: message.roomId,
			entityId: message.entityId,
			connectorCount: connectors.length,
			relevantConnectorCount: relevantConnectors.length,
			userContextCount: users.length,
			users,
		};

		return {
			text: renderJson({ platform_user_context: data }),
			values: {
				platformUserContextCount: users.length,
			},
			data,
		};
	},
};

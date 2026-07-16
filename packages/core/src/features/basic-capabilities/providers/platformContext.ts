/**
 * The PLATFORM_CHAT_CONTEXT and PLATFORM_USER_CONTEXT providers: inject
 * connector-specific metadata for the current platform target. Chat context
 * carries per-connector room metadata (source, channel/thread ids, summaries,
 * output guidance) — deliberately NOT the canonical transcript, which the
 * RECENT_MESSAGES provider owns; user context carries sender identity (handles,
 * aliases, account labels). Connectors are selected by matching the message
 * source, or by overlapping explicit routing contexts when no source is set, and
 * each connector hook's result is normalized to JSON-safe ProviderValues. Recent
 * messages are stripped from the emitted prompt text but kept in `data` for
 * diagnostics.
 */
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
import { getMessageConnectorsWithHook } from "../../advanced-capabilities/actions/connectorActionUtils.ts";

export const PLATFORM_CHAT_CONTEXT_PROVIDER_NAME = "PLATFORM_CHAT_CONTEXT";
export const PLATFORM_USER_CONTEXT_PROVIDER_NAME = "PLATFORM_USER_CONTEXT";

/** Pretty-print a provider payload as JSON; returns "" if it can't serialize. */
function renderJson(payload: Record<string, ProviderValue>): string {
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return "";
	}
}

/** An empty (no prompt text) ProviderResult carrying only diagnostic values. */
function emptyResult(data: Record<string, ProviderValue>): ProviderResult {
	return { text: "", values: data, data };
}

const PLATFORM_CONTEXTS: AgentContext[] = ["social", "phone", "connectors"];
const MAX_CONNECTOR_CONTEXTS = 8;
// Lower bound on what we ship per connector — RECENT_MESSAGES provider
// already renders the canonical conversation history. PLATFORM_CHAT_CONTEXT
// adds a per-connector view of the same conversation (so the model can
// see e.g. that the same room is bridged across Discord and Telegram).
// Five messages is enough to disambiguate the connector source without
// re-shipping the full history twice. Kept low because two-connector rooms
// (e.g. Discord default account + Discord stealth account) double-count and
// would otherwise push ~130K extra characters into the prompt.
const MAX_RECENT_MESSAGES = 5;
const PLATFORM_OUTPUT_GUIDANCE: Record<string, string[]> = {
	discord: [
		"Format replies for Discord: avoid markdown tables; prefer short bullets or plain lines.",
		"When sending multiple links, wrap each URL in angle brackets to avoid noisy embeds.",
	],
	whatsapp: [
		"Format replies for WhatsApp: avoid markdown tables and markdown headings; prefer concise plain text.",
	],
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

function getMemorySource(
	message: Memory,
	room: RoomLike | null,
): string | undefined {
	const contentSource =
		typeof message.content.source === "string"
			? message.content.source.trim()
			: "";
	if (contentSource) {
		return contentSource;
	}
	const roomSource = typeof room?.source === "string" ? room.source.trim() : "";
	return roomSource || undefined;
}

function outputGuidanceForSource(
	source: string | undefined,
): string[] | undefined {
	const normalized = source?.trim().toLowerCase();
	if (!normalized) return undefined;
	return PLATFORM_OUTPUT_GUIDANCE[normalized];
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
		metadata: message.content.metadata as Metadata | undefined,
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
	const sourceMatches = dropShadowedLegacyConnectors(
		connectors.filter((connector) => connectorMatchesSource(connector, source)),
	);
	if (source) {
		return sourceMatches;
	}

	return dropShadowedLegacyConnectors(
		connectors.filter((connector) =>
			connectorMatchesExplicitContext(connector, activeContexts),
		),
	);
}

/**
 * Drop an accountId-less connector when an account-scoped connector with the
 * same source is present. Connector plugins register both a legacy unscoped
 * entry and one entry per account; the pair answers every context hook with
 * byte-identical work, so keeping both doubles the per-turn connector cost
 * (observed live: two serial Discord history round-trips per turn).
 */
function dropShadowedLegacyConnectors(
	connectors: MessageConnector[],
): MessageConnector[] {
	const scopedSources = new Set(
		connectors
			.filter((connector) => connector.accountId)
			.map((connector) => connector.source),
	);
	return connectors.filter(
		(connector) => connector.accountId || !scopedSources.has(connector.source),
	);
}

async function getCurrentRoom(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): Promise<RoomLike | null> {
	const stateRoom = state.data.room as RoomLike | undefined;
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

function omitRecentMessages(
	context: Record<string, ProviderValue>,
): Record<string, ProviderValue> {
	const { recentMessages: _recentMessages, ...rest } = context;
	return rest;
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

export const platformChatContextProvider: Provider = {
	name: PLATFORM_CHAT_CONTEXT_PROVIDER_NAME,
	description:
		"Connector-specific room metadata for the current platform target, including source, channel/thread identifiers, summaries, and output guidance; not the canonical transcript.",
	descriptionCompressed:
		"Connector room metadata and output guidance; not the canonical transcript.",
	dynamic: true,
	position: 125,
	contexts: PLATFORM_CONTEXTS,
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		const connectors = getMessageConnectorsWithHook(runtime, "getChatContext");
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
		// Connector hooks run concurrently: each may do its own I/O, and this
		// provider sits on the Stage-1 critical path — serializing them stacks
		// every connector's round-trip into the turn floor.
		const contexts: Record<string, ProviderValue>[] = (
			await Promise.all(
				relevantConnectors.map(async (connector) => {
					try {
						const context = await connector.getChatContext?.(
							target,
							queryContext,
						);
						return context ? normalizeChatContext(connector, context) : null;
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
						return null;
					}
				}),
			)
		).filter(
			(context): context is Record<string, ProviderValue> => context !== null,
		);

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
			outputGuidance: outputGuidanceForSource(source),
			connectorCount: connectors.length,
			relevantConnectorCount: relevantConnectors.length,
			chatContextCount: contexts.length,
			contexts,
		};
		const promptData = {
			...data,
			contexts: contexts.map(omitRecentMessages),
		};

		return {
			text: renderJson({ platform_chat_context: promptData }),
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
		"Connector-specific sender identity metadata for the current platform user/contact, including handles, aliases, and account labels; not conversation history.",
	descriptionCompressed:
		"Connector sender identity and handles; not conversation history.",
	dynamic: true,
	position: 126,
	contexts: PLATFORM_CONTEXTS,
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		if (!message.entityId) {
			return emptyResult({ connectorCount: 0, userContextCount: 0 });
		}

		const connectors = getMessageConnectorsWithHook(runtime, "getUserContext");
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
		// Concurrent for the same reason as the chat-context hooks above.
		const users: Record<string, ProviderValue>[] = (
			await Promise.all(
				relevantConnectors.map(async (connector) => {
					try {
						const context = await connector.getUserContext?.(
							message.entityId,
							queryContext,
						);
						return context ? normalizeUserContext(connector, context) : null;
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
						return null;
					}
				}),
			)
		).filter(
			(context): context is Record<string, ProviderValue> => context !== null,
		);

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

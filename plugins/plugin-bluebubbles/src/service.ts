/**
 * BlueBubbles service for ElizaOS
 */
import * as childProcess from "node:child_process";
import {
	ChannelType,
	type Content,
	type ContentType,
	createMessageMemory,
	createUniqueUuid,
	type Entity,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
	Service,
	type UUID,
} from "@elizaos/core";
import { BlueBubblesClient } from "./client";
import { BLUEBUBBLES_SERVICE_NAME, DEFAULT_WEBHOOK_PATH } from "./constants";
import {
	getConfigFromRuntime,
	isHandleAllowed,
	normalizeHandle,
} from "./environment";
import type {
	BlueBubblesChat,
	BlueBubblesChatState,
	BlueBubblesConfig,
	BlueBubblesIncomingEvent,
	BlueBubblesMessage,
	BlueBubblesProbeResult,
	BlueBubblesWebhookPayload,
} from "./types";

const AUTOSTART_PROBE_INTERVAL_MS = 1000;
const DEFAULT_AUTOSTART_WAIT_MS = 15000;
const DEFAULT_AUTOSTART_COMMAND = "open";
const DEFAULT_AUTOSTART_ARGS = ["-a", "BlueBubbles"];

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type BlueBubblesAutoStartConfig = {
	command: string;
	args: string[];
	cwd?: string;
	waitMs: number;
};

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
	);
}

export function resolveBlueBubblesAutoStartConfig(
	config: BlueBubblesConfig | null,
	platform = process.platform,
): BlueBubblesAutoStartConfig | null {
	if (!config) {
		return null;
	}

	const explicitCommand = config.autoStartCommand?.trim();
	const explicitArgs = Array.isArray(config.autoStartArgs)
		? config.autoStartArgs
				.map((arg) => arg.trim())
				.filter((arg) => arg.length > 0)
		: [];
	const cwd = config.autoStartCwd?.trim() || undefined;
	const waitMs =
		typeof config.autoStartWaitMs === "number" &&
		Number.isFinite(config.autoStartWaitMs) &&
		config.autoStartWaitMs >= 0
			? config.autoStartWaitMs
			: DEFAULT_AUTOSTART_WAIT_MS;

	if (explicitCommand) {
		return {
			command: explicitCommand,
			args: explicitArgs,
			cwd,
			waitMs,
		};
	}

	if (platform !== "darwin") {
		return null;
	}

	try {
		const serverUrl = new URL(config.serverUrl);
		if (!isLoopbackHostname(serverUrl.hostname)) {
			return null;
		}
	} catch {
		return null;
	}

	return {
		command: DEFAULT_AUTOSTART_COMMAND,
		args: explicitArgs.length > 0 ? explicitArgs : [...DEFAULT_AUTOSTART_ARGS],
		cwd,
		waitMs,
	};
}

type MessageService = {
	handleMessage: (
		runtime: IAgentRuntime,
		message: Memory,
		callback: HandlerCallback,
	) => Promise<void>;
};

function getMessageService(runtime: IAgentRuntime): MessageService | null {
	if ("messageService" in runtime) {
		const withMessageService = runtime as IAgentRuntime & {
			messageService?: MessageService | null;
		};
		return withMessageService.messageService ?? null;
	}
	return null;
}

type RuntimeWithOptionalConnectorRegistry = IAgentRuntime & {
	registerMessageConnector?: (
		registration: MessageConnectorRegistration,
	) => void;
	getMessageConnectors?: () => Array<{ source?: string }>;
};
type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0];
type MessageConnectorTarget = Awaited<
	ReturnType<NonNullable<MessageConnectorRegistration["resolveTargets"]>>
>[number];
type MessageConnectorQueryContext = Parameters<
	NonNullable<MessageConnectorRegistration["resolveTargets"]>
>[1];
type MessageConnectorChatContext = NonNullable<
	Awaited<
		ReturnType<NonNullable<MessageConnectorRegistration["getChatContext"]>>
	>
>;
type MessageConnectorUserContext = NonNullable<
	Awaited<
		ReturnType<NonNullable<MessageConnectorRegistration["getUserContext"]>>
	>
>;
type ConnectorReadParams = {
	target?: ConnectorTargetInfo;
	limit?: number;
	query?: string;
};
type ConnectorMutationParams = {
	target?: ConnectorTargetInfo;
	chatGuid?: string;
	messageGuid?: string;
	messageId?: string;
	id?: string;
	emoji?: string;
	reaction?: string;
	text?: string;
	content?: ConnectorContent;
};
type AdditiveMessageConnectorHooks = {
	fetchMessages?: (
		context: MessageConnectorQueryContext,
		params?: ConnectorReadParams,
	) => Promise<Memory[]>;
	searchMessages?: (
		context: MessageConnectorQueryContext,
		params: ConnectorReadParams & { query: string },
	) => Promise<Memory[]>;
	reactHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMutationParams,
	) => Promise<void>;
	editHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMutationParams,
	) => Promise<void>;
	deleteHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMutationParams,
	) => Promise<void>;
};
type ExtendedMessageConnectorRegistration = MessageConnectorRegistration &
	AdditiveMessageConnectorHooks;

function registerMessageConnectorIfAvailable(
	runtime: IAgentRuntime,
	registration: MessageConnectorRegistration,
): void {
	const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry;
	if (typeof withRegistry.registerMessageConnector === "function") {
		withRegistry.registerMessageConnector(registration);
		return;
	}
	if (registration.sendHandler) {
		runtime.registerSendHandler(registration.source, registration.sendHandler);
	}
}

function hasRegisteredConnector(
	runtime: IAgentRuntime,
	source: string,
): boolean {
	const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry & {
		sendHandlers?: unknown;
	};
	if (typeof withRegistry.getMessageConnectors === "function") {
		return withRegistry
			.getMessageConnectors()
			.some((connector) => connector.source === source);
	}
	return (
		withRegistry.sendHandlers instanceof Map &&
		withRegistry.sendHandlers.has(source)
	);
}

function normalizedSearchText(value: string | undefined): string {
	return (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9@+._;-]+/g, " ")
		.trim();
}

function matchesQuery(
	query: string,
	...values: Array<string | undefined>
): boolean {
	const normalizedQuery = normalizedSearchText(query);
	if (!normalizedQuery) return true;
	const normalizedHandleQuery = normalizedSearchText(normalizeHandle(query));
	return values.some((value) => {
		const normalizedValue = normalizedSearchText(value);
		return (
			normalizedValue.includes(normalizedQuery) ||
			(normalizedHandleQuery.length > 0 &&
				normalizedValue.includes(normalizedHandleQuery))
		);
	});
}

function normalizeConnectorLimit(
	limit: number | undefined,
	fallback = 50,
): number {
	if (!Number.isFinite(limit) || !limit || limit <= 0) {
		return fallback;
	}
	return Math.min(Math.floor(limit), 200);
}

function filterMemoriesByQuery(
	memories: Memory[],
	query: string,
	limit: number,
): Memory[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return memories.slice(0, limit);
	}
	return memories
		.filter((memory) => {
			const text =
				typeof memory.content?.text === "string" ? memory.content.text : "";
			return text.toLowerCase().includes(normalized);
		})
		.slice(0, limit);
}

function isBlueBubblesChatGuid(value: string): boolean {
	return /^(?:iMessage|SMS|RCS);/i.test(value);
}

function normalizeBlueBubblesTarget(value: string): string {
	const trimmed = value
		.trim()
		.replace(/^bluebubbles:/i, "")
		.trim();
	if (!trimmed) return "";
	if (isBlueBubblesChatGuid(trimmed)) return trimmed;
	return normalizeHandle(trimmed);
}

function targetKindForBlueBubbles(
	value: string,
): "phone" | "email" | "group" | "contact" {
	if (isBlueBubblesChatGuid(value) && value.includes(";+;")) return "group";
	if (value.includes("@") && !value.endsWith("@g.us")) return "email";
	if (/^\+?\d{7,}$/.test(value)) return "phone";
	return "contact";
}

function chatLabel(chat: BlueBubblesChat): string {
	if (chat.displayName?.trim()) return chat.displayName.trim();
	if (chat.participants.length === 1) {
		return normalizeBlueBubblesTarget(
			chat.participants[0]?.address ?? chat.chatIdentifier,
		);
	}
	return chat.participants
		.map((participant) => normalizeBlueBubblesTarget(participant.address))
		.filter(Boolean)
		.join(", ");
}

function chatToTarget(
	chat: BlueBubblesChat,
	score = 0.74,
): MessageConnectorTarget {
	const label = chatLabel(chat) || chat.chatIdentifier || chat.guid;
	const isGroup = chat.participants.length > 1 || chat.guid.includes(";+;");
	const directHandle = !isGroup
		? normalizeBlueBubblesTarget(
				chat.participants[0]?.address ?? chat.chatIdentifier,
			)
		: "";
	const target: ConnectorTargetInfo = {
		source: "bluebubbles",
		channelId: isGroup ? chat.guid : directHandle || chat.guid,
	};
	if (!isGroup && directHandle) {
		target.entityId = directHandle as unknown as UUID;
	}
	return {
		target,
		label,
		kind: isGroup ? "group" : targetKindForBlueBubbles(directHandle),
		description: isGroup
			? "BlueBubbles iMessage group chat"
			: "BlueBubbles iMessage contact",
		score,
		metadata: {
			chatGuid: chat.guid,
			chatIdentifier: chat.chatIdentifier,
			participants: chat.participants
				.map((participant) => normalizeBlueBubblesTarget(participant.address))
				.filter(Boolean)
				.join(", "),
		},
	};
}

function directTarget(
	value: string,
	score = 0.7,
): MessageConnectorTarget | null {
	const normalized = normalizeBlueBubblesTarget(value);
	if (!normalized) return null;
	return {
		target: {
			source: "bluebubbles",
			channelId: normalized,
			entityId: normalized as unknown as UUID,
		},
		label: normalized,
		kind: targetKindForBlueBubbles(normalized),
		score,
		metadata: {
			handle: normalized,
		},
	};
}

async function resolveBlueBubblesSendTarget(
	runtime: IAgentRuntime,
	target: ConnectorTargetInfo,
): Promise<string | null> {
	if (target.channelId?.trim()) {
		return normalizeBlueBubblesTarget(target.channelId);
	}
	if (target.entityId?.trim()) {
		return normalizeBlueBubblesTarget(target.entityId);
	}
	if (target.roomId) {
		const room = await runtime.getRoom(target.roomId);
		if (room?.channelId) {
			return normalizeBlueBubblesTarget(room.channelId);
		}
	}
	return null;
}

function blueBubblesMessageToMemory({
	runtime,
	message,
	chatGuid,
	roomId,
	source,
	config,
}: {
	runtime: IAgentRuntime;
	message: BlueBubblesMessage;
	chatGuid: string;
	roomId: UUID;
	source: "bluebubbles" | "imessage";
	config: BlueBubblesConfig | null;
}): Memory {
	const senderHandle = normalizeBlueBubblesTarget(
		message.handle?.address ?? message.chats[0]?.chatIdentifier ?? chatGuid,
	);
	const entityId = message.isFromMe
		? runtime.agentId
		: (createUniqueUuid(runtime, `bluebubbles-entity:${senderHandle}`) as UUID);
	const isGroup =
		message.chats[0]?.participants.length > 1 || chatGuid.includes(";+;");
	const attachments = message.attachments.map((attachment) => ({
		id: attachment.guid,
		url: config
			? `${config.serverUrl}/api/v1/attachment/${encodeURIComponent(attachment.guid)}?password=${encodeURIComponent(config.password)}`
			: "",
		title: attachment.transferName,
		description: attachment.mimeType ?? undefined,
		contentType: (attachment.mimeType ??
			"application/octet-stream") as ContentType,
	}));

	const memory = createMessageMemory({
		id: createUniqueUuid(runtime, `bluebubbles:${message.guid}`) as UUID,
		agentId: runtime.agentId,
		entityId,
		roomId,
		content: {
			text: message.text ?? "",
			source,
			channelType: isGroup ? ChannelType.GROUP : ChannelType.DM,
			...(attachments.length > 0 ? { attachments } : {}),
		},
	}) as Memory;
	memory.createdAt = message.dateCreated;
	memory.metadata = {
		...(memory.metadata ?? {}),
		source,
		provider: "bluebubbles",
		timestamp: message.dateCreated,
		entityName: message.handle?.address ?? senderHandle,
		entityUserName: senderHandle,
		fromBot: message.isFromMe,
		fromId: message.isFromMe ? runtime.agentId : senderHandle,
		sourceId: entityId,
		chatType: isGroup ? ChannelType.GROUP : ChannelType.DM,
		messageIdFull: message.guid,
		sender: {
			id: message.isFromMe ? runtime.agentId : senderHandle,
			name: message.handle?.address ?? senderHandle,
			username: senderHandle,
		},
		bluebubbles: {
			id: senderHandle,
			userId: senderHandle,
			username: senderHandle,
			userName: senderHandle,
			name: message.handle?.address ?? senderHandle,
			chatGuid,
			messageGuid: message.guid,
		},
		bluebubblesChatGuid: chatGuid,
		bluebubblesMessageGuid: message.guid,
	};
	return memory;
}

export class BlueBubblesService extends Service {
	static serviceType = BLUEBUBBLES_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive iMessages via BlueBubbles";

	private client: BlueBubblesClient | null = null;
	private blueBubblesConfig: BlueBubblesConfig | null = null;
	private knownChats: Map<string, BlueBubblesChat> = new Map();
	private entityCache: Map<string, UUID> = new Map();
	private roomCache: Map<string, UUID> = new Map();
	private webhookPath: string = DEFAULT_WEBHOOK_PATH;
	private isRunning = false;

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		if (!runtime) return;
		this.blueBubblesConfig = getConfigFromRuntime(runtime);

		if (!this.blueBubblesConfig) {
			logger.warn(
				"BlueBubbles configuration not provided - BlueBubbles functionality will be unavailable",
			);
			return;
		}

		if (!this.blueBubblesConfig.enabled) {
			logger.info("BlueBubbles plugin is disabled via configuration");
			return;
		}

		this.webhookPath =
			this.blueBubblesConfig.webhookPath ?? DEFAULT_WEBHOOK_PATH;
		this.client = new BlueBubblesClient(this.blueBubblesConfig);
	}

	static async start(runtime: IAgentRuntime): Promise<BlueBubblesService> {
		const service = new BlueBubblesService(runtime);

		if (!service.client) {
			logger.warn(
				"BlueBubbles service started without client functionality - no configuration provided",
			);
			return service;
		}

		try {
			// Probe the server to verify connectivity
			let probeResult = await service.client.probe();

			if (!probeResult.ok) {
				probeResult = await service.tryAutoStartServer(probeResult);
			}

			if (!probeResult.ok) {
				logger.warn(
					`BlueBubbles server unavailable at startup: ${probeResult.error}. Continuing without BlueBubbles connectivity.`,
				);
				return service;
			}

			logger.success(
				`Connected to BlueBubbles server v${probeResult.serverVersion} on macOS ${probeResult.osVersion}`,
			);

			if (probeResult.privateApiEnabled) {
				logger.info(
					"BlueBubbles Private API is enabled - edit and unsend features available",
				);
			}

			// Initialize known chats
			await service.initializeChats();

			service.isRunning = true;
			logger.success(
				`BlueBubbles service started for ${runtime.character.name}`,
			);
		} catch (error) {
			logger.error(
				`Failed to start BlueBubbles service: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return service;
	}

	private getAutoStartConfig(): BlueBubblesAutoStartConfig | null {
		return resolveBlueBubblesAutoStartConfig(this.blueBubblesConfig);
	}

	private async spawnAutoStartProcess(
		command: string,
		args: string[],
		cwd?: string,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const child = childProcess.spawn(command, args, {
				cwd,
				stdio: "ignore",
				detached: process.platform !== "win32",
			});

			const cleanup = () => {
				child.removeListener("error", onError);
				child.removeListener("spawn", onSpawn);
			};

			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};

			const onSpawn = () => {
				if (settled) return;
				settled = true;
				cleanup();
				child.unref();
				resolve();
			};

			child.once("error", onError);
			child.once("spawn", onSpawn);
		});
	}

	private async tryAutoStartServer(
		initialProbe: BlueBubblesProbeResult,
	): Promise<BlueBubblesProbeResult> {
		if (!this.client) {
			return initialProbe;
		}

		const autoStart = this.getAutoStartConfig();
		if (!autoStart) {
			return initialProbe;
		}

		const commandPreview = [autoStart.command, ...autoStart.args]
			.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
			.join(" ");
		logger.info(
			`Attempting to auto-start BlueBubbles server: ${commandPreview}`,
		);

		try {
			await this.spawnAutoStartProcess(
				autoStart.command,
				autoStart.args,
				autoStart.cwd,
			);
		} catch (error) {
			return {
				ok: false,
				error: `auto-start command failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		let probeResult = await this.client.probe();
		const deadline = Date.now() + autoStart.waitMs;

		while (!probeResult.ok && Date.now() < deadline) {
			const sleepMs = Math.min(
				AUTOSTART_PROBE_INTERVAL_MS,
				Math.max(0, deadline - Date.now()),
			);
			if (sleepMs <= 0) {
				break;
			}
			await delay(sleepMs);
			probeResult = await this.client.probe();
		}

		if (!probeResult.ok && autoStart.waitMs > 0) {
			return {
				ok: false,
				error:
					`auto-start did not make BlueBubbles reachable within ${autoStart.waitMs}ms` +
					(probeResult.error ? `: ${probeResult.error}` : ""),
			};
		}

		return probeResult;
	}

	static registerSendHandlers(
		runtime: IAgentRuntime,
		service: BlueBubblesService,
	): void {
		const register = (source: "bluebubbles" | "imessage") => {
			const registration = {
				source,
				label: source === "imessage" ? "iMessage (BlueBubbles)" : "BlueBubbles",
				capabilities: [
					"send_message",
					"reply",
					"reactions",
					"effects",
					"chat_context",
				],
				supportedTargetKinds: [
					"phone",
					"email",
					"contact",
					"user",
					"group",
					"room",
				],
				contexts: ["phone", "social", "connectors"],
				description:
					"Send iMessage/SMS through the BlueBubbles bridge using contact handles or chat GUIDs.",
				metadata: {
					aliases:
						source === "imessage"
							? ["imessage", "sms", "text", "messages", "bluebubbles"]
							: ["bluebubbles", "imessage", "sms", "text"],
					bridge: "bluebubbles",
					status: service.getIsRunning() ? "connected" : "not_connected",
				},
				sendHandler: async (
					_runtime: IAgentRuntime,
					target: ConnectorTargetInfo,
					content: ConnectorContent,
				) => {
					const text =
						typeof content.text === "string" ? content.text.trim() : "";
					if (!text) {
						return;
					}

					const chatGuid = await resolveBlueBubblesSendTarget(runtime, target);
					if (!chatGuid) {
						throw new Error("BlueBubbles target is missing a chat GUID");
					}

					let selectedMessageGuid: string | undefined;
					if (
						typeof content.inReplyTo === "string" &&
						content.inReplyTo.trim().length > 0
					) {
						const repliedToMemory = await runtime.getMemoryById(
							content.inReplyTo as UUID,
						);
						const metadata = repliedToMemory?.metadata as
							| Record<string, unknown>
							| undefined;
						const replyGuid = metadata?.bluebubblesMessageGuid;
						if (typeof replyGuid === "string" && replyGuid.trim().length > 0) {
							selectedMessageGuid = replyGuid.trim();
						}
					}

					const result = await service.sendMessage(
						chatGuid,
						text,
						selectedMessageGuid,
					);

					if (!target.roomId) {
						return;
					}

					const memory = createMessageMemory({
						id: createUniqueUuid(runtime, `bluebubbles:${result.guid}`) as UUID,
						entityId: runtime.agentId,
						roomId: target.roomId,
						content: {
							...content,
							text,
							source: "bluebubbles",
						},
					}) as Memory;
					memory.createdAt = result.dateCreated;
					memory.metadata = {
						...(memory.metadata ?? {}),
						bluebubblesChatGuid: chatGuid,
						bluebubblesMessageGuid: result.guid,
						messageIdFull: result.guid,
					};

					return memory;
				},
				resolveTargets: async (query: string) => {
					const candidates: MessageConnectorTarget[] = [];
					for (const chat of await service.listChats()) {
						const candidate = chatToTarget(chat, 0.78);
						if (
							matchesQuery(
								query,
								candidate.label,
								chat.guid,
								chat.chatIdentifier,
								...chat.participants.map((participant) => participant.address),
							)
						) {
							candidates.push(candidate);
						}
					}
					const direct = directTarget(query, 0.72);
					if (direct) candidates.push(direct);
					return candidates;
				},
				listRecentTargets: async () =>
					(await service.listChats()).map((chat) => chatToTarget(chat, 0.66)),
				listRooms: async () =>
					(await service.listChats()).map((chat) => chatToTarget(chat, 0.7)),
				fetchMessages: async (context, params) => {
					const limit = normalizeConnectorLimit(params?.limit);
					const target = params?.target ?? context.target;
					const resolvedTarget = target
						? await resolveBlueBubblesSendTarget(context.runtime, target)
						: null;
					if (service.client && resolvedTarget) {
						const chatGuid = await service.client.resolveTarget(resolvedTarget);
						const roomId =
							target?.roomId ??
							(createUniqueUuid(
								context.runtime,
								`bluebubbles-room:${chatGuid}`,
							) as UUID);
						const messages = await service.client
							.getMessages(chatGuid, limit)
							.catch(() => []);
						if (messages.length > 0) {
							return messages
								.map((message) =>
									blueBubblesMessageToMemory({
										runtime: context.runtime,
										message,
										chatGuid,
										roomId,
										source,
										config: service.blueBubblesConfig,
									}),
								)
								.sort(
									(left, right) =>
										(right.createdAt ?? 0) - (left.createdAt ?? 0),
								)
								.slice(0, limit);
						}
					}
					if (target?.roomId) {
						return context.runtime.getMemories({
							tableName: "messages",
							roomId: target.roomId,
							limit,
							orderBy: "createdAt",
							orderDirection: "desc",
						});
					}
					const targets = (await service.listChats())
						.slice(0, 10)
						.map((chat) => chatToTarget(chat, 0.66));
					const roomIds = Array.from(
						new Set(
							targets
								.map((candidate) => candidate.target.roomId)
								.filter((roomId): roomId is UUID => Boolean(roomId)),
						),
					);
					const chunks = await Promise.all(
						roomIds.map((roomId) =>
							context.runtime.getMemories({
								tableName: "messages",
								roomId,
								limit,
								orderBy: "createdAt",
								orderDirection: "desc",
							}),
						),
					);
					return chunks
						.flat()
						.sort(
							(left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
						)
						.slice(0, limit);
				},
				searchMessages: async (context, params) => {
					const limit = normalizeConnectorLimit(params?.limit);
					const messages = await registration.fetchMessages?.(context, {
						target: params?.target ?? context.target,
						limit: Math.max(limit, 100),
					});
					return filterMemoriesByQuery(messages ?? [], params.query, limit);
				},
				reactHandler: async (handlerRuntime, params) => {
					const mutationParams = params as ConnectorMutationParams;
					const target = params.target ?? ({ source } as ConnectorTargetInfo);
					const resolvedTarget = await resolveBlueBubblesSendTarget(
						handlerRuntime,
						target,
					);
					const chatGuid = mutationParams.chatGuid ?? resolvedTarget;
					const messageGuid = String(
						mutationParams.messageGuid ??
							params.messageId ??
							mutationParams.id ??
							"",
					).trim();
					const reaction = String(
						mutationParams.reaction ?? params.emoji ?? "",
					).trim();
					if (!chatGuid || !messageGuid || !reaction) {
						throw new Error(
							"BlueBubbles reactHandler requires chat, message guid, and reaction",
						);
					}
					const result = await service.sendReaction(
						chatGuid,
						messageGuid,
						reaction,
					);
					if (!result.success) {
						throw new Error("BlueBubbles reaction failed");
					}
				},
				editHandler: async (_handlerRuntime, params) => {
					const mutationParams = params as ConnectorMutationParams;
					if (!service.client) {
						throw new Error("BlueBubbles client not initialized");
					}
					const messageGuid = String(
						mutationParams.messageGuid ??
							params.messageId ??
							mutationParams.id ??
							"",
					).trim();
					const text = String(
						mutationParams.text ?? params.content?.text ?? "",
					).trim();
					if (!messageGuid || !text) {
						throw new Error(
							"BlueBubbles editHandler requires message guid and text",
						);
					}
					await service.client.editMessage(messageGuid, text);
				},
				deleteHandler: async (_handlerRuntime, params) => {
					const mutationParams = params as ConnectorMutationParams;
					if (!service.client) {
						throw new Error("BlueBubbles client not initialized");
					}
					const messageGuid = String(
						mutationParams.messageGuid ??
							params.messageId ??
							mutationParams.id ??
							"",
					).trim();
					if (!messageGuid) {
						throw new Error("BlueBubbles deleteHandler requires message guid");
					}
					await service.client.unsendMessage(messageGuid);
				},
				getChatContext: async (
					target: ConnectorTargetInfo,
					context: MessageConnectorQueryContext,
				): Promise<MessageConnectorChatContext | null> => {
					const chatGuid = await resolveBlueBubblesSendTarget(
						context.runtime,
						target,
					);
					if (!chatGuid) return null;
					const chatState = await service.getChatState(chatGuid);
					if (!chatState) {
						return {
							target,
							label: chatGuid,
							summary: "BlueBubbles chat context unavailable for this target.",
							metadata: { chatGuid },
						};
					}
					return {
						target,
						label: chatState.displayName ?? chatState.chatIdentifier,
						summary: chatState.isGroup
							? "BlueBubbles iMessage group chat."
							: "BlueBubbles iMessage direct chat.",
						metadata: {
							...chatState,
							participants: chatState.participants.join(", "),
						},
					};
				},
				getUserContext: async (
					entityId: string | UUID,
				): Promise<MessageConnectorUserContext | null> => {
					const handle = normalizeBlueBubblesTarget(String(entityId));
					if (!handle) return null;
					return {
						entityId,
						label: handle,
						aliases: [handle],
						handles: {
							bluebubbles: handle,
							...(handle.includes("@") ? { email: handle } : { phone: handle }),
						},
						metadata: { normalizedHandle: handle },
					};
				},
			} as ExtendedMessageConnectorRegistration;
			registerMessageConnectorIfAvailable(runtime, registration);
		};

		register("bluebubbles");
		if (!hasRegisteredConnector(runtime, "imessage")) {
			register("imessage");
		}
	}

	static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
		const service = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);
		if (service) {
			await service.stop();
		}
	}

	async stop(): Promise<void> {
		this.isRunning = false;
		logger.info("BlueBubbles service stopped");
	}

	/**
	 * Gets the BlueBubbles client
	 */
	getClient(): BlueBubblesClient | null {
		return this.client;
	}

	/**
	 * Gets the current configuration
	 */
	getConfig(): BlueBubblesConfig | null {
		return this.blueBubblesConfig;
	}

	/**
	 * Checks if the service is running
	 */
	getIsRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Gets the webhook path for receiving messages
	 */
	getWebhookPath(): string {
		return this.webhookPath;
	}

	async listChats(limit = 100): Promise<BlueBubblesChat[]> {
		if (this.client) {
			try {
				const chats = await this.client.listChats(limit);
				for (const chat of chats) {
					this.knownChats.set(chat.guid, chat);
				}
			} catch (error) {
				logger.debug(
					`Failed to list BlueBubbles chats: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return Array.from(this.knownChats.values());
	}

	/**
	 * Initializes known chats from the server
	 */
	private async initializeChats(): Promise<void> {
		if (!this.client) return;

		try {
			const chats = await this.client.listChats(100);
			for (const chat of chats) {
				this.knownChats.set(chat.guid, chat);
			}
			logger.info(`Loaded ${chats.length} BlueBubbles chats`);
		} catch (error) {
			logger.error(
				`Failed to load BlueBubbles chats: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Handles an incoming webhook payload
	 */
	async handleWebhook(payload: BlueBubblesWebhookPayload): Promise<void> {
		if (!this.blueBubblesConfig || !this.client) {
			logger.warn("Received webhook but BlueBubbles service is not configured");
			return;
		}

		const event: BlueBubblesIncomingEvent = {
			type: payload.type as BlueBubblesIncomingEvent["type"],
			data: payload.data,
		};

		switch (event.type) {
			case "new-message":
				await this.handleIncomingMessage(event.data as BlueBubblesMessage);
				break;
			case "updated-message":
				await this.handleMessageUpdate(event.data as BlueBubblesMessage);
				break;
			case "chat-updated":
				await this.handleChatUpdate(event.data as BlueBubblesChat);
				break;
			case "typing-indicator":
			case "read-receipt":
				// These events can be logged but don't require action
				logger.debug(
					`BlueBubbles ${event.type}: ${JSON.stringify(event.data)}`,
				);
				break;
			default:
				logger.debug(`Unhandled BlueBubbles event: ${event.type}`);
		}
	}

	/**
	 * Handles an incoming message
	 */
	private async handleIncomingMessage(
		message: BlueBubblesMessage,
	): Promise<void> {
		// Skip outgoing messages
		if (message.isFromMe) {
			return;
		}

		// Skip system messages
		if (message.isSystemMessage) {
			return;
		}

		const config = this.blueBubblesConfig;
		if (!config) {
			return;
		}

		const chat = message.chats[0];
		if (!chat) {
			logger.warn(`Received message without chat info: ${message.guid}`);
			return;
		}

		const isGroup = chat.participants.length > 1;
		const senderHandle = message.handle?.address ?? "";

		// Check access policies
		if (isGroup) {
			if (
				!isHandleAllowed(
					senderHandle,
					config.groupAllowFrom ?? [],
					config.groupPolicy ?? "allowlist",
				)
			) {
				logger.debug(
					`Ignoring message from ${senderHandle} - not in group allowlist`,
				);
				return;
			}
		} else {
			if (
				!isHandleAllowed(
					senderHandle,
					config.allowFrom ?? [],
					config.dmPolicy ?? "pairing",
				)
			) {
				logger.debug(
					`Ignoring message from ${senderHandle} - not in DM allowlist`,
				);
				return;
			}
		}

		// Mark as read if configured
		if (config.sendReadReceipts && this.client) {
			try {
				await this.client.markChatRead(chat.guid);
			} catch (error) {
				logger.debug(`Failed to mark chat as read: ${error}`);
			}
		}

		const entityId = await this.getOrCreateEntity(
			senderHandle,
			message.handle?.address,
		);
		const roomId = await this.getOrCreateRoom(chat);
		const worldId = createUniqueUuid(this.runtime, "bluebubbles-world") as UUID;
		const replyToGuid = message.threadOriginatorGuid?.trim() || "";
		const replyToMessageId = replyToGuid
			? (createUniqueUuid(this.runtime, `bluebubbles:${replyToGuid}`) as UUID)
			: undefined;
		const attachments = message.attachments.map((att) => ({
			id: att.guid,
			url: `${config.serverUrl}/api/v1/attachment/${encodeURIComponent(att.guid)}?password=${encodeURIComponent(config.password)}`,
			title: att.transferName,
			description: att.mimeType ?? undefined,
			contentType: (att.mimeType ?? "application/octet-stream") as ContentType,
		}));

		await this.runtime.ensureConnection({
			entityId,
			roomId,
			worldId,
			worldName: "iMessage",
			userId: senderHandle as unknown as UUID,
			userName: senderHandle,
			name: message.handle?.address ?? senderHandle,
			source: "bluebubbles",
			type: isGroup ? ChannelType.GROUP : ChannelType.DM,
			channelId: chat.guid,
			roomName: chat.displayName ?? chat.chatIdentifier,
			metadata: {
				bluebubblesChatGuid: chat.guid,
				bluebubblesChatIdentifier: chat.chatIdentifier,
				bluebubblesHandle: senderHandle,
			},
		});

		const memory = createMessageMemory({
			id: createUniqueUuid(this.runtime, `bluebubbles:${message.guid}`) as UUID,
			agentId: this.runtime.agentId,
			entityId,
			roomId,
			content: {
				text: message.text ?? "",
				source: "bluebubbles",
				...(replyToMessageId ? { inReplyTo: replyToMessageId } : {}),
				...(attachments.length > 0 ? { attachments } : {}),
			},
		}) as Memory;
		memory.createdAt = message.dateCreated;
		memory.metadata = {
			...(memory.metadata ?? {}),
			source: "bluebubbles",
			provider: "bluebubbles",
			timestamp: message.dateCreated,
			entityName: message.handle?.address ?? senderHandle,
			entityUserName: senderHandle,
			fromId: senderHandle,
			sourceId: entityId,
			chatType: isGroup ? ChannelType.GROUP : ChannelType.DM,
			messageIdFull: message.guid,
			sender: {
				id: senderHandle,
				name: message.handle?.address ?? senderHandle,
				username: senderHandle,
			},
			bluebubbles: {
				id: senderHandle,
				userId: senderHandle,
				username: senderHandle,
				userName: senderHandle,
				name: message.handle?.address ?? senderHandle,
				chatGuid: chat.guid,
				chatIdentifier: chat.chatIdentifier,
				messageGuid: message.guid,
			},
			bluebubblesChatGuid: chat.guid,
			bluebubblesChatIdentifier: chat.chatIdentifier,
			bluebubblesMessageGuid: message.guid,
			bluebubblesThreadOriginatorGuid:
				message.threadOriginatorGuid ?? undefined,
		} as unknown as Memory["metadata"];

		await this.runtime.createMemory(memory, "messages");

		const room = await this.runtime.getRoom(roomId);
		if (!room) {
			logger.warn(
				`BlueBubbles room ${roomId} not found after ensureConnection`,
			);
			return;
		}

		await this.processMessage(memory, room, chat.guid);
	}

	/**
	 * Handles a message update (edit, unsend, etc.)
	 */
	private async handleMessageUpdate(
		message: BlueBubblesMessage,
	): Promise<void> {
		// Handle edited or unsent messages
		if (message.dateEdited) {
			logger.debug(`Message ${message.guid} was edited`);
		}
	}

	/**
	 * Handles a chat update
	 */
	private async handleChatUpdate(chat: BlueBubblesChat): Promise<void> {
		this.knownChats.set(chat.guid, chat);
		logger.debug(
			`Chat ${chat.guid} updated: ${chat.displayName ?? chat.chatIdentifier}`,
		);
	}

	/**
	 * Gets or creates an entity for a BlueBubbles handle
	 */
	private async getOrCreateEntity(
		handle: string,
		displayName?: string,
	): Promise<UUID> {
		const normalized = normalizeHandle(handle);
		const cached = this.entityCache.get(normalized);
		if (cached) {
			return cached;
		}

		const entityId = createUniqueUuid(
			this.runtime,
			`bluebubbles:${normalized}`,
		) as UUID;

		// Check if entity exists
		const existing = await this.runtime.getEntityById(entityId);
		if (!existing) {
			const entity: Entity = {
				id: entityId,
				agentId: this.runtime.agentId,
				names: displayName ? [displayName, normalized] : [normalized],
				metadata: {
					bluebubbles: {
						handle: normalized,
						displayName: displayName ?? normalized,
					},
				},
			};
			await this.runtime.createEntity(entity);
		}

		this.entityCache.set(normalized, entityId);
		return entityId;
	}

	/**
	 * Gets or creates a room for a BlueBubbles chat
	 */
	private async getOrCreateRoom(chat: BlueBubblesChat): Promise<UUID> {
		const cached = this.roomCache.get(chat.guid);
		if (cached) {
			return cached;
		}

		const roomId = createUniqueUuid(
			this.runtime,
			`bluebubbles:${chat.guid}`,
		) as UUID;

		this.roomCache.set(chat.guid, roomId);
		return roomId;
	}

	/**
	 * Sends a message to a target
	 */
	async sendMessage(
		target: string,
		text: string,
		replyToMessageGuid?: string,
	): Promise<{ guid: string; dateCreated: number }> {
		if (!this.client) {
			throw new Error("BlueBubbles client not initialized");
		}

		const chatGuid = await this.client.resolveTarget(target);
		const result = await this.client.sendMessage(chatGuid, text, {
			...(replyToMessageGuid
				? { selectedMessageGuid: replyToMessageGuid }
				: {}),
		});

		return {
			guid: result.guid,
			dateCreated: result.dateCreated,
		};
	}

	private async processMessage(
		memory: Memory,
		room: { id: UUID; channelId?: string | null },
		chatGuid: string,
	): Promise<void> {
		const messageService = getMessageService(this.runtime);
		if (!messageService) {
			return;
		}

		const callback: HandlerCallback = async (
			response: Content,
		): Promise<Memory[]> => {
			const responseText =
				typeof response.text === "string" ? response.text.trim() : "";
			if (!responseText) {
				return [];
			}

			let selectedMessageGuid: string | undefined;
			if (
				typeof memory.id === "string" &&
				memory.metadata &&
				typeof (memory.metadata as Record<string, unknown>)
					.bluebubblesMessageGuid === "string"
			) {
				selectedMessageGuid = (memory.metadata as Record<string, unknown>)
					.bluebubblesMessageGuid as string;
			}

			const sent = await this.sendMessage(
				chatGuid,
				responseText,
				selectedMessageGuid,
			);

			const responseMemory = createMessageMemory({
				id: createUniqueUuid(this.runtime, `bluebubbles:${sent.guid}`) as UUID,
				agentId: this.runtime.agentId,
				entityId: this.runtime.agentId,
				roomId: room.id,
				content: {
					...response,
					text: responseText,
					source: "bluebubbles",
					inReplyTo: memory.id,
				},
			}) as Memory;
			responseMemory.createdAt = Date.now();
			responseMemory.metadata = {
				...(responseMemory.metadata ?? {}),
				bluebubblesChatGuid: chatGuid,
				bluebubblesMessageGuid: sent.guid,
			};

			await this.runtime.createMemory(responseMemory, "messages");
			return [responseMemory];
		};

		await messageService.handleMessage(this.runtime, memory, callback);
	}

	/**
	 * Gets the state for a chat
	 */
	async getChatState(chatGuid: string): Promise<BlueBubblesChatState | null> {
		const chat = this.knownChats.get(chatGuid);
		if (!chat && this.client) {
			try {
				const fetchedChat = await this.client.getChat(chatGuid);
				this.knownChats.set(chatGuid, fetchedChat);
				return this.chatToState(fetchedChat);
			} catch {
				return null;
			}
		}

		if (!chat) {
			return null;
		}

		return this.chatToState(chat);
	}

	private chatToState(chat: BlueBubblesChat): BlueBubblesChatState {
		return {
			chatGuid: chat.guid,
			chatIdentifier: chat.chatIdentifier,
			isGroup: chat.participants.length > 1,
			participants: chat.participants.map((p) => p.address),
			displayName: chat.displayName,
			lastMessageAt: chat.lastMessage?.dateCreated ?? null,
			hasUnread: chat.hasUnreadMessages,
		};
	}

	/**
	 * Checks if the service is connected
	 */
	isConnected(): boolean {
		return this.isRunning && this.client !== null;
	}

	/**
	 * Sends a reaction to a message
	 */
	async sendReaction(
		chatGuid: string,
		messageGuid: string,
		reaction: string,
	): Promise<{ success: boolean }> {
		if (!this.client) {
			throw new Error("BlueBubbles client not initialized");
		}

		try {
			await this.client.reactToMessage(chatGuid, messageGuid, reaction);
			return { success: true };
		} catch (error) {
			logger.error(
				`Failed to send reaction: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { success: false };
		}
	}
}

import {
	ChannelType,
	type Content,
	createUniqueUuid,
	type Entity,
	type EventPayload,
	EventType,
	type IAgentRuntime,
	logger,
	type Memory,
	type MessageConnectorChatContext,
	type MessageConnectorTarget,
	type MessageConnectorUserContext,
	type Room,
	Service,
	type TargetInfo,
	type UUID,
	type World,
} from "@elizaos/core";
import * as lark from "@larksuiteoapi/node-sdk";
import { FEISHU_SERVICE_NAME } from "./constants";
import {
	type FeishuConfig,
	getFeishuConfig,
	validateConfig,
} from "./environment";
import { MessageManager } from "./messageManager";
import type {
	FeishuChat,
	FeishuEventData,
	FeishuMessageContent,
	FeishuWorldPayload,
} from "./types";
import { FeishuChatType, FeishuEventTypes } from "./types";

function normalizeFeishuQuery(query: string): string {
	return query.trim().toLowerCase();
}

function scoreFeishuCandidate(
	values: Array<string | undefined>,
	query: string,
): number {
	const normalized = normalizeFeishuQuery(query);
	if (!normalized) {
		return 0.45;
	}
	const candidates = values
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.map((value) => value.trim().toLowerCase());
	if (candidates.some((candidate) => candidate === normalized)) {
		return 1;
	}
	return candidates.some((candidate) => candidate.includes(normalized))
		? 0.8
		: 0;
}

function feishuChatToConnectorTarget(
	chat: FeishuChat,
	score = 0.55,
	roomId?: UUID,
): MessageConnectorTarget {
	return {
		target: {
			source: FEISHU_SERVICE_NAME,
			channelId: chat.chatId,
			roomId,
		},
		label: chat.name || chat.chatId,
		kind: chat.chatType === FeishuChatType.P2P ? "user" : "group",
		description: chat.description || "Feishu/Lark chat",
		score,
		contexts: ["social", "connectors"],
		metadata: {
			chatType: chat.chatType,
			ownerOpenId: chat.ownerOpenId,
			tenantKey: chat.tenantKey,
		},
	};
}

type ConnectorHookContext = {
	runtime: IAgentRuntime;
	roomId?: UUID;
	target?: TargetInfo;
};

type ConnectorReadParams = {
	target?: TargetInfo;
	limit?: number;
	query?: string;
};

type ConnectorUserLookupParams = {
	entityId?: UUID | string;
	userId?: string;
	username?: string;
	handle?: string;
	target?: TargetInfo;
};

type AdditiveMessageConnectorHooks = {
	fetchMessages?: (
		context: ConnectorHookContext,
		params?: ConnectorReadParams,
	) => Promise<Memory[]>;
	searchMessages?: (
		context: ConnectorHookContext,
		params: ConnectorReadParams & { query: string },
	) => Promise<Memory[]>;
	getUser?: (
		runtime: IAgentRuntime,
		params: ConnectorUserLookupParams,
	) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0] &
	AdditiveMessageConnectorHooks;

function normalizeConnectorLimit(
	limit: number | undefined,
	fallback = 50,
): number {
	if (!Number.isFinite(limit) || !limit || limit <= 0) {
		return fallback;
	}
	return Math.min(Math.floor(limit), 200);
}

async function readStoredMessageMemories(
	runtime: IAgentRuntime,
	roomId: UUID,
	limit: number,
): Promise<Memory[]> {
	return runtime.getMemories({
		tableName: "messages",
		roomId,
		limit,
		orderBy: "createdAt",
		orderDirection: "desc",
	});
}

async function readStoredMessagesForTargets(
	runtime: IAgentRuntime,
	targets: MessageConnectorTarget[],
	limit: number,
): Promise<Memory[]> {
	const roomIds = Array.from(
		new Set(
			targets
				.map((target) => target.target.roomId)
				.filter((id): id is UUID => Boolean(id)),
		),
	);
	const chunks = await Promise.all(
		roomIds.map((roomId) => readStoredMessageMemories(runtime, roomId, limit)),
	);
	return chunks
		.flat()
		.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
		.slice(0, limit);
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

/**
 * Feishu service for ElizaOS.
 */
export class FeishuService extends Service {
	static serviceType = FEISHU_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive messages on Feishu/Lark";

	private client: lark.Client | null = null;
	private wsClient: lark.WSClient | null = null;
	public messageManager: MessageManager | null = null;
	private feishuConfig: FeishuConfig | null = null;
	private botOpenId: string | null = null;
	private knownChats: Map<string, FeishuChat> = new Map();

	constructor(runtime?: IAgentRuntime) {
		super(runtime);

		if (!runtime) {
			return;
		}

		const config = getFeishuConfig(runtime);
		if (!config) {
			logger.warn(
				"[Feishu] App ID or App Secret not provided - Feishu functionality will be unavailable",
			);
			return;
		}

		const validation = validateConfig(config);
		if (!validation.valid) {
			logger.warn(`[Feishu] Invalid configuration: ${validation.error}`);
			return;
		}

		this.feishuConfig = config;

		// Initialize Lark SDK client
		this.client = new lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			domain: config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
			loggerLevel: lark.LoggerLevel.warn,
		});

		this.messageManager = new MessageManager(this.client, runtime, config);
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new FeishuService(runtime);

		if (!service.client || !service.feishuConfig) {
			logger.warn(
				"[Feishu] Service started without client - no credentials provided",
			);
			return service;
		}

		const maxRetries = 5;
		let retryCount = 0;
		let lastError: Error | null = null;

		while (retryCount < maxRetries) {
			try {
				logger.info(
					`[Feishu] Starting service for character ${runtime.character.name}`,
				);

				await service.initializeBot();
				await service.setupWebSocket();

				logger.success(`[Feishu] Service started successfully`);
				return service;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				logger.error(
					`[Feishu] Initialization attempt ${retryCount + 1} failed: ${lastError.message}`,
				);
				retryCount++;

				if (retryCount < maxRetries) {
					const delay = 2 ** retryCount * 1000;
					logger.info(`[Feishu] Retrying in ${delay / 1000} seconds...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		logger.error(
			`[Feishu] Initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}`,
		);

		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		const service = runtime.getService(FEISHU_SERVICE_NAME) as
			| FeishuService
			| undefined;
		if (service) {
			await service.stop();
		}
	}

	async stop(): Promise<void> {
		logger.info("[Feishu] Stopping service...");

		if (this.wsClient) {
			try {
				// WSClient may not have a stop method in newer SDK versions
				const wsClientWithStop = this.wsClient as {
					stop?: () => Promise<void>;
				};
				if (typeof wsClientWithStop.stop === "function") {
					await wsClientWithStop.stop();
				}
			} catch (error) {
				logger.error(
					`[Feishu] Error stopping WebSocket client: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.wsClient = null;
		}

		this.client = null;
		logger.info("[Feishu] Service stopped");
	}

	/**
	 * Initializes the bot and fetches bot information.
	 */
	private async initializeBot(): Promise<void> {
		if (!this.client) {
			throw new Error("Client not initialized");
		}

		// Get bot info - the API path may vary by SDK version
		try {
			// Try to get bot info via the contact API
			const client = this.client as {
				bot?: {
					botInfo?: {
						get: (params: Record<string, unknown>) => Promise<{
							data?: { bot?: { open_id?: string; app_name?: string } };
						}>;
					};
				};
				contact?: {
					user?: {
						me?: (params: Record<string, unknown>) => Promise<{
							data?: { user?: { open_id?: string; name?: string } };
						}>;
					};
				};
			};

			if (client.bot?.botInfo?.get) {
				const botInfo = await client.bot.botInfo.get({});
				this.botOpenId = botInfo.data?.bot?.open_id || null;

				if (this.botOpenId && this.messageManager) {
					this.messageManager.setBotOpenId(this.botOpenId);
				}

				logger.info(
					`[Feishu] Bot initialized: ${botInfo.data?.bot?.app_name || "Unknown"}`,
				);
			} else {
				logger.warn(
					"[Feishu] Bot info API not available, some features may not work",
				);
			}
		} catch (error) {
			logger.error(
				`[Feishu] Failed to get bot info: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Sets up WebSocket connection for receiving events.
	 */
	private async setupWebSocket(): Promise<void> {
		if (!this.client || !this.feishuConfig || !this.runtime) {
			throw new Error("Client not initialized");
		}

		const eventDispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				await this.handleMessageEvent(data as FeishuEventData);
				return {};
			},
			"im.chat.member.bot.added_v1": async (data: unknown) => {
				await this.handleBotAddedEvent(data as FeishuEventData);
				return {};
			},
			"im.chat.member.bot.deleted_v1": async (data: unknown) => {
				await this.handleBotRemovedEvent(data as FeishuEventData);
				return {};
			},
			"im.chat.member.user.added_v1": async (data: unknown) => {
				await this.handleUserAddedEvent(data as FeishuEventData);
				return {};
			},
			"im.chat.member.user.deleted_v1": async (data: unknown) => {
				await this.handleUserRemovedEvent(data as FeishuEventData);
				return {};
			},
		});

		this.wsClient = new lark.WSClient({
			appId: this.feishuConfig.appId,
			appSecret: this.feishuConfig.appSecret,
			domain:
				this.feishuConfig.domain === "lark"
					? lark.Domain.Lark
					: lark.Domain.Feishu,
			loggerLevel: lark.LoggerLevel.warn,
		});

		await this.wsClient.start({ eventDispatcher });

		// Emit connected event
		this.runtime.emitEvent(FeishuEventTypes.WORLD_CONNECTED, {
			runtime: this.runtime,
			source: "feishu",
			botOpenId: this.botOpenId,
		} as EventPayload);
	}

	/**
	 * Handles incoming message events.
	 */
	private async handleMessageEvent(event: FeishuEventData): Promise<void> {
		if (!this.messageManager) return;
		await this.messageManager.handleMessage(event);
	}

	/**
	 * Handles bot added to chat events.
	 */
	private async handleBotAddedEvent(event: FeishuEventData): Promise<void> {
		if (!this.runtime) return;

		try {
			const chatId = event.event?.chat_id as string | undefined;
			if (!chatId) return;

			const chat: FeishuChat = {
				chatId,
				chatType: FeishuChatType.GROUP,
				name: event.event?.chat_name as string | undefined,
			};

			this.knownChats.set(chatId, chat);

			// Create world and room
			const worldId = createUniqueUuid(this.runtime, chatId) as UUID;
			const roomId = createUniqueUuid(this.runtime, chatId) as UUID;

			const world: World = {
				id: worldId,
				name: chat.name || `Feishu Chat ${chatId}`,
				agentId: this.runtime.agentId,
				messageServerId: worldId,
				metadata: {
					extra: {
						chatType: chat.chatType,
					},
				},
			};

			await this.runtime.ensureWorldExists(world);

			const room: Room = {
				id: roomId,
				name: chat.name || `Feishu Chat ${chatId}`,
				source: "feishu",
				type: ChannelType.GROUP,
				channelId: chatId,
				messageServerId: worldId,
				worldId,
			};

			await this.runtime.ensureRoomExists(room);

			const payload: FeishuWorldPayload = {
				runtime: this.runtime,
				world,
				rooms: [room],
				entities: [],
				source: "feishu",
				chat,
				botOpenId: this.botOpenId || undefined,
			};

			this.runtime.emitEvent(
				FeishuEventTypes.WORLD_JOINED,
				payload as EventPayload,
			);
			this.runtime.emitEvent(EventType.WORLD_JOINED, {
				runtime: this.runtime,
				world,
				rooms: [room],
				entities: [],
				source: "feishu",
			} as EventPayload);

			logger.info(`[Feishu] Bot added to chat: ${chat.name || chatId}`);
		} catch (error) {
			logger.error(
				`[Feishu] Error handling bot added event: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Handles bot removed from chat events.
	 */
	private async handleBotRemovedEvent(event: FeishuEventData): Promise<void> {
		if (!this.runtime) return;

		try {
			const chatId = event.event?.chat_id as string | undefined;
			if (!chatId) return;

			const chat = this.knownChats.get(chatId) || {
				chatId,
				chatType: FeishuChatType.GROUP,
			};

			this.knownChats.delete(chatId);

			this.runtime.emitEvent(FeishuEventTypes.WORLD_LEFT, {
				runtime: this.runtime,
				source: "feishu",
				chat,
				botOpenId: this.botOpenId,
			} as EventPayload);

			logger.info(`[Feishu] Bot removed from chat: ${chatId}`);
		} catch (error) {
			logger.error(
				`[Feishu] Error handling bot removed event: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Handles user added to chat events.
	 */
	private async handleUserAddedEvent(event: FeishuEventData): Promise<void> {
		if (!this.runtime) return;

		try {
			const chatId = event.event?.chat_id as string | undefined;
			const users = event.event?.users as
				| Array<{ user_id?: { open_id?: string }; name?: string }>
				| undefined;

			if (!chatId || !users) return;

			for (const user of users) {
				const openId = user.user_id?.open_id;
				if (!openId) continue;

				this.runtime.emitEvent(FeishuEventTypes.ENTITY_JOINED, {
					runtime: this.runtime,
					source: "feishu",
					feishuUser: {
						openId,
						name: user.name,
					},
					chat: this.knownChats.get(chatId) || {
						chatId,
						chatType: FeishuChatType.GROUP,
					},
				} as EventPayload);
			}
		} catch (error) {
			logger.error(
				`[Feishu] Error handling user added event: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Handles user removed from chat events.
	 */
	private async handleUserRemovedEvent(event: FeishuEventData): Promise<void> {
		if (!this.runtime) return;

		try {
			const chatId = event.event?.chat_id as string | undefined;
			const users = event.event?.users as
				| Array<{ user_id?: { open_id?: string }; name?: string }>
				| undefined;

			if (!chatId || !users) return;

			for (const user of users) {
				const openId = user.user_id?.open_id;
				if (!openId) continue;

				this.runtime.emitEvent(FeishuEventTypes.ENTITY_LEFT, {
					runtime: this.runtime,
					source: "feishu",
					feishuUser: {
						openId,
						name: user.name,
					},
					chat: this.knownChats.get(chatId) || {
						chatId,
						chatType: FeishuChatType.GROUP,
					},
				} as EventPayload);
			}
		} catch (error) {
			logger.error(
				`[Feishu] Error handling user removed event: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Registers send handlers for the service.
	 */
	static registerSendHandlers(
		runtime: IAgentRuntime,
		serviceInstance: FeishuService,
	): void {
		if (serviceInstance?.client && serviceInstance?.messageManager) {
			const sendHandler = async (
				handlerRuntime: IAgentRuntime,
				target: TargetInfo,
				content: Content,
			): Promise<Memory | undefined> => {
				await serviceInstance.handleSendMessage(
					handlerRuntime,
					target,
					content,
				);
				return undefined;
			};

			if (typeof runtime.registerMessageConnector === "function") {
				const registration = {
					source: FEISHU_SERVICE_NAME,
					label: "Feishu/Lark",
					capabilities: [
						"send_message",
						"send_card",
						"send_image",
						"send_file",
					],
					supportedTargetKinds: ["group", "room", "user", "channel"],
					contexts: ["social", "connectors"],
					description:
						"Send Feishu/Lark text, card, image, and file messages to known chats.",
					sendHandler,
					resolveTargets: async (query, context) => {
						const chats = await serviceInstance.listConnectorChats(
							context.runtime,
						);
						return chats
							.map(({ chat, roomId }) => ({
								chat,
								roomId,
								score: scoreFeishuCandidate(
									[chat.chatId, chat.name, chat.description, chat.ownerOpenId],
									query,
								),
							}))
							.filter(({ score }) => score > 0)
							.sort((left, right) => right.score - left.score)
							.slice(0, 10)
							.map(({ chat, score, roomId }) =>
								feishuChatToConnectorTarget(chat, score, roomId),
							);
					},
					listRecentTargets: async (context) =>
						(await serviceInstance.listConnectorChats(context.runtime))
							.slice(0, 10)
							.map(({ chat, roomId }) =>
								feishuChatToConnectorTarget(chat, 0.55, roomId),
							),
					listRooms: async (context) =>
						(await serviceInstance.listConnectorChats(context.runtime)).map(
							({ chat, roomId }) =>
								feishuChatToConnectorTarget(chat, 0.55, roomId),
						),
					fetchMessages: async (context, params) => {
						const limit = normalizeConnectorLimit(params?.limit);
						const target = params?.target ?? context.target;
						if (target?.roomId) {
							return readStoredMessageMemories(
								context.runtime,
								target.roomId,
								limit,
							);
						}
						const targets = (
							await serviceInstance.listConnectorChats(context.runtime)
						)
							.slice(0, 10)
							.map(({ chat, roomId }) =>
								feishuChatToConnectorTarget(chat, 0.55, roomId),
							);
						return readStoredMessagesForTargets(
							context.runtime,
							targets,
							limit,
						);
					},
					searchMessages: async (context, params) => {
						const limit = normalizeConnectorLimit(params?.limit);
						const target = params?.target ?? context.target;
						const messages = target?.roomId
							? await readStoredMessageMemories(
									context.runtime,
									target.roomId,
									Math.max(limit, 100),
								)
							: await readStoredMessagesForTargets(
									context.runtime,
									(await serviceInstance.listConnectorChats(context.runtime))
										.slice(0, 10)
										.map(({ chat, roomId }) =>
											feishuChatToConnectorTarget(chat, 0.55, roomId),
										),
									Math.max(limit, 100),
								);
						return filterMemoriesByQuery(messages, params.query, limit);
					},
					getChatContext: async (target, context) => {
						const room = target.roomId
							? await context.runtime.getRoom(target.roomId)
							: null;
						const chatId = String(
							target.channelId ?? room?.channelId ?? "",
						).trim();
						if (!chatId) {
							return null;
						}
						const chat =
							serviceInstance.knownChats.get(chatId) ||
							({
								chatId,
								chatType:
									room?.type === ChannelType.DM
										? FeishuChatType.P2P
										: FeishuChatType.GROUP,
								name: room?.name,
							} satisfies FeishuChat);
						return {
							target: {
								source: FEISHU_SERVICE_NAME,
								roomId: target.roomId,
								channelId: chatId,
							},
							label: chat.name || chat.chatId,
							summary:
								chat.chatType === FeishuChatType.P2P
									? "Feishu/Lark direct chat"
									: "Feishu/Lark group chat",
							metadata: {
								chatType: chat.chatType,
								ownerOpenId: chat.ownerOpenId,
								tenantKey: chat.tenantKey,
							},
						} satisfies MessageConnectorChatContext;
					},
					getUserContext: async (entityId, context) => {
						const entity =
							typeof context.runtime.getEntityById === "function"
								? await context.runtime.getEntityById(String(entityId) as UUID)
								: null;
						if (!entity) {
							return null;
						}
						return {
							entityId,
							label: entity.names?.[0],
							aliases: entity.names,
							handles: {},
							metadata: entity.metadata,
						} satisfies MessageConnectorUserContext;
					},
					getUser: async (handlerRuntime, params) => {
						const lookupParams = params as ConnectorUserLookupParams;
						const entityId = String(
							lookupParams.entityId ??
								params.userId ??
								params.username ??
								params.handle ??
								params.target?.entityId ??
								"",
						).trim();
						if (
							!entityId ||
							typeof handlerRuntime.getEntityById !== "function"
						) {
							return null;
						}
						const entity = await handlerRuntime
							.getEntityById(entityId as UUID)
							.catch(() => null);
						return entity;
					},
				} as ExtendedMessageConnectorRegistration;
				runtime.registerMessageConnector(registration);
			} else {
				runtime.registerSendHandler(FEISHU_SERVICE_NAME, sendHandler);
			}
			logger.info("[Feishu] Registered message connector");
		} else {
			logger.warn(
				"[Feishu] Cannot register send handler - client not initialized",
			);
		}
	}

	/**
	 * Handles sending messages through the service.
	 */
	async handleSendMessage(
		runtime: IAgentRuntime,
		target: TargetInfo,
		content: Content,
	): Promise<void> {
		if (!this.messageManager) {
			logger.error("[Feishu] Message manager not initialized");
			throw new Error("Feishu message manager is not initialized");
		}

		let chatId: string | undefined;

		if (target.channelId) {
			chatId = target.channelId;
		} else if (target.roomId) {
			const room = await runtime.getRoom(target.roomId);
			chatId = room?.channelId;
			if (!chatId) {
				throw new Error(
					`Could not resolve Feishu chat ID from roomId ${target.roomId}`,
				);
			}
		} else {
			throw new Error("Feishu SendHandler requires channelId or roomId");
		}

		if (!chatId) {
			throw new Error(
				`Could not determine target Feishu chat ID for target: ${JSON.stringify(target)}`,
			);
		}

		// Build Feishu content from the base content
		const feishuContent: FeishuMessageContent = {
			text: content.text || "",
		};

		// Copy over Feishu-specific fields if present
		// Card can be passed via data.card or metadata
		const contentData = content.data as Record<string, unknown> | undefined;
		const feishuData = (
			contentData?.feishu && typeof contentData.feishu === "object"
				? contentData.feishu
				: contentData
		) as Record<string, unknown> | undefined;
		if (feishuData?.card) {
			feishuContent.card = feishuData.card as FeishuMessageContent["card"];
		}
		if (feishuData?.imageKey) {
			feishuContent.imageKey = feishuData.imageKey as string;
		}
		if (feishuData?.fileKey) {
			feishuContent.fileKey = feishuData.fileKey as string;
		}

		await this.messageManager.sendMessage(chatId, feishuContent);
		logger.info(`[Feishu] Message sent to chat ID: ${chatId}`);
	}

	async sendRoomMessage(target: string, content: Content): Promise<void> {
		await this.handleSendMessage(
			this.runtime,
			{ source: FEISHU_SERVICE_NAME, channelId: target } as TargetInfo,
			content,
		);
	}

	async sendDirectMessage(target: string, content: Content): Promise<void> {
		await this.sendRoomMessage(target, content);
	}

	private async listConnectorChats(
		runtime: IAgentRuntime,
	): Promise<Array<{ chat: FeishuChat; roomId?: UUID }>> {
		const chats = new Map<string, { chat: FeishuChat; roomId?: UUID }>();
		for (const chat of this.knownChats.values()) {
			chats.set(chat.chatId, { chat });
		}

		if (typeof runtime.getRoomsForParticipant !== "function") {
			return Array.from(chats.values());
		}

		const roomIds = await runtime
			.getRoomsForParticipant(runtime.agentId)
			.catch(() => [] as UUID[]);
		for (const roomId of roomIds) {
			const room = await runtime.getRoom(roomId).catch(() => null);
			if (room?.source !== FEISHU_SERVICE_NAME || !room.channelId) {
				continue;
			}
			const known = chats.get(room.channelId)?.chat;
			chats.set(room.channelId, {
				chat:
					known ||
					({
						chatId: room.channelId,
						chatType:
							room.type === ChannelType.DM
								? FeishuChatType.P2P
								: FeishuChatType.GROUP,
						name: room.name,
					} satisfies FeishuChat),
				roomId,
			});
		}

		return Array.from(chats.values());
	}
}

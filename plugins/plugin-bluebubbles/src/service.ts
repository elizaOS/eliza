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
		const register = (source: string) => {
			runtime.registerSendHandler(source, async (_runtime, target, content) => {
				const text =
					typeof content.text === "string" ? content.text.trim() : "";
				if (!text) {
					return;
				}

				const room =
					target.roomId && typeof runtime.getRoom === "function"
						? await runtime.getRoom(target.roomId)
						: null;
				const chatGuid = String(
					target.channelId ?? room?.channelId ?? "",
				).trim();
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
				};

				await runtime.createMemory(memory, "messages");
			});
		};

		register("bluebubbles");
		const sendHandlers = (runtime as unknown as { sendHandlers?: unknown })
			.sendHandlers;
		if (!(sendHandlers instanceof Map) || !sendHandlers.has("imessage")) {
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

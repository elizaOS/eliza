/**
 * LINE service implementation for elizaOS.
 */

import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import {
	type FlexMessage,
	type LocationMessage,
	type Message,
	type MiddlewareConfig,
	messagingApi,
	middleware,
	type TemplateMessage,
	type WebhookEvent,
} from "@line/bot-sdk";
import {
	getChatTypeFromId,
	type ILineService,
	LINE_SERVICE_NAME,
	LineApiError,
	LineConfigurationError,
	LineEventTypes,
	type LineFlexMessage,
	type LineGroup,
	type LineLocationMessage,
	type LineMessage,
	type LineMessageSendOptions,
	type LineSendResult,
	type LineSettings,
	type LineTemplateMessage,
	type LineUser,
	MAX_LINE_BATCH_SIZE,
	splitMessageForLine,
} from "./types.js";

/**
 * LINE messaging service for elizaOS agents.
 */
export class LineService extends Service implements ILineService {
	static serviceType: string = LINE_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive messages via LINE";

	private settings: LineSettings | null = null;
	private client: messagingApi.MessagingApiClient | null = null;
	private connected: boolean = false;

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		if (!runtime) return;
		this.settings = this.loadSettings();
	}

	/**
	 * Start the LINE service.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new LineService(runtime);
		await service.initialize();
		return service;
	}

	/**
	 * Initialize the service.
	 */
	private async initialize(): Promise<void> {
		if (!this.runtime) return;
		logger.info("Starting LINE service...");

		// Load settings
		if (!this.settings) {
			this.settings = this.loadSettings();
		}
		this.validateSettings();

		// Initialize LINE client
		this.client = new messagingApi.MessagingApiClient({
			channelAccessToken: this.settings.channelAccessToken,
		});

		this.connected = true;
		logger.info("LINE service started");

		// Emit connection ready event
		if (this.runtime) {
			this.runtime.emitEvent([LineEventTypes.CONNECTION_READY], {
				runtime: this.runtime,
				source: "line",
				service: this,
			} as unknown as EventPayload);
		}
	}

	/**
	 * Stop the LINE service.
	 */
	async stop(): Promise<void> {
		logger.info("Stopping LINE service...");
		this.connected = false;
		this.client = null;
		this.settings = null;
		logger.info("LINE service stopped");
	}

	/**
	 * Check if the service is connected.
	 */
	isConnected(): boolean {
		return this.connected && this.client !== null;
	}

	/**
	 * Get bot info.
	 */
	async getBotInfo(): Promise<LineUser | null> {
		if (!this.client) {
			return null;
		}

		const info = await this.client.getBotInfo();
		return {
			userId: info.userId,
			displayName: info.displayName,
			pictureUrl: info.pictureUrl,
		};
	}

	/**
	 * Send a text message.
	 */
	async sendMessage(
		to: string,
		text: string,
		options?: LineMessageSendOptions,
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		const chunks = splitMessageForLine(text);
		const messages: Message[] = chunks.map((chunk) => ({
			type: "text" as const,
			text: chunk,
		}));

		// Add quick replies to last message if provided
		if (options?.quickReplyItems && messages.length > 0) {
			const lastIdx = messages.length - 1;
			// Cast to unknown first to avoid strict type checking with LINE SDK types
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(messages[lastIdx] as { quickReply?: unknown }).quickReply = {
				items: options.quickReplyItems,
			} as unknown;
		}

		return this.pushMessages(to, messages);
	}

	/**
	 * Send multiple messages.
	 */
	async sendMessages(
		to: string,
		messages: Array<{ type: string; [key: string]: unknown }>,
	): Promise<LineSendResult> {
		return this.pushMessages(to, messages as Message[]);
	}

	/**
	 * Send a flex message.
	 */
	async sendFlexMessage(
		to: string,
		flex: LineFlexMessage,
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		const message: FlexMessage = {
			type: "flex",
			altText: flex.altText.slice(0, 400),
			contents: flex.contents as FlexMessage["contents"],
		};

		return this.pushMessages(to, [message]);
	}

	/**
	 * Send a template message.
	 */
	async sendTemplateMessage(
		to: string,
		template: LineTemplateMessage,
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		const message: TemplateMessage = {
			type: "template",
			altText: template.altText.slice(0, 400),
			template: template.template as TemplateMessage["template"],
		};

		return this.pushMessages(to, [message]);
	}

	/**
	 * Send a location message.
	 */
	async sendLocationMessage(
		to: string,
		location: LineLocationMessage,
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		const message: LocationMessage = {
			type: "location",
			title: location.title.slice(0, 100),
			address: location.address.slice(0, 100),
			latitude: location.latitude,
			longitude: location.longitude,
		};

		return this.pushMessages(to, [message]);
	}

	/**
	 * Reply to a message using reply token.
	 */
	async replyMessage(
		replyToken: string,
		messages: Array<{ type: string; [key: string]: unknown }>,
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		await this.client.replyMessage({
			replyToken,
			messages: messages.slice(
				0,
				MAX_LINE_BATCH_SIZE,
			) as unknown as messagingApi.Message[],
		});

		return {
			success: true,
			messageId: "reply",
			chatId: "reply",
		};
	}

	/**
	 * Get user profile.
	 */
	async getUserProfile(userId: string): Promise<LineUser | null> {
		if (!this.client) {
			return null;
		}

		const profile = await this.client.getProfile(userId);
		return {
			userId: profile.userId,
			displayName: profile.displayName,
			pictureUrl: profile.pictureUrl,
			statusMessage: profile.statusMessage,
			language: profile.language,
		};
	}

	/**
	 * Get group info.
	 */
	async getGroupInfo(groupId: string): Promise<LineGroup | null> {
		if (!this.client) {
			return null;
		}

		const chatType = getChatTypeFromId(groupId);
		if (chatType === "group") {
			const summary = await this.client.getGroupSummary(groupId);
			return {
				groupId: summary.groupId,
				groupName: summary.groupName,
				pictureUrl: summary.pictureUrl,
				type: "group",
			};
		} else if (chatType === "room") {
			// Rooms don't have summary, just return ID
			return {
				groupId,
				type: "room",
			};
		}

		return null;
	}

	/**
	 * Leave a group or room.
	 */
	async leaveChat(chatId: string, chatType: "group" | "room"): Promise<void> {
		if (!this.client) {
			throw new LineApiError("Service not connected");
		}

		if (chatType === "group") {
			await this.client.leaveGroup(chatId);
		} else {
			await this.client.leaveRoom(chatId);
		}
	}

	/**
	 * Get the middleware config for webhook verification.
	 */
	getMiddlewareConfig(): MiddlewareConfig {
		if (!this.settings) {
			throw new LineConfigurationError("Service not configured");
		}

		return {
			channelSecret: this.settings.channelSecret,
		};
	}

	/**
	 * Create Express middleware for webhook handling.
	 */
	createMiddleware(): ReturnType<typeof middleware> {
		return middleware(this.getMiddlewareConfig());
	}

	/**
	 * Handle webhook events.
	 */
	async handleWebhookEvents(events: WebhookEvent[]): Promise<void> {
		if (!this.runtime) {
			return;
		}

		for (const event of events) {
			await this.handleWebhookEvent(event);
		}
	}

	/**
	 * Get current settings.
	 */
	getSettings(): LineSettings | null {
		return this.settings;
	}

	// Private methods

	private loadSettings(): LineSettings {
		if (!this.runtime) {
			throw new LineConfigurationError("Runtime not initialized");
		}

		const getStringSetting = (key: string): string => {
			const value = this.runtime?.getSetting(key);
			return typeof value === "string" ? value : "";
		};

		const channelAccessToken =
			getStringSetting("LINE_CHANNEL_ACCESS_TOKEN") ||
			process.env.LINE_CHANNEL_ACCESS_TOKEN ||
			"";

		const channelSecret =
			getStringSetting("LINE_CHANNEL_SECRET") ||
			process.env.LINE_CHANNEL_SECRET ||
			"";

		const webhookPath =
			getStringSetting("LINE_WEBHOOK_PATH") ||
			process.env.LINE_WEBHOOK_PATH ||
			"/webhooks/line";

		const dmPolicyRaw =
			getStringSetting("LINE_DM_POLICY") ||
			process.env.LINE_DM_POLICY ||
			"pairing";
		const dmPolicy = dmPolicyRaw as LineSettings["dmPolicy"];

		const groupPolicyRaw =
			getStringSetting("LINE_GROUP_POLICY") ||
			process.env.LINE_GROUP_POLICY ||
			"allowlist";
		const groupPolicy = groupPolicyRaw as LineSettings["groupPolicy"];

		const allowFromRaw =
			getStringSetting("LINE_ALLOW_FROM") || process.env.LINE_ALLOW_FROM || "";
		const allowFrom = allowFromRaw
			.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);

		const enabledRaw =
			getStringSetting("LINE_ENABLED") || process.env.LINE_ENABLED || "true";
		const enabled = enabledRaw !== "false";

		return {
			channelAccessToken,
			channelSecret,
			webhookPath,
			dmPolicy,
			groupPolicy,
			allowFrom,
			enabled,
		};
	}

	private validateSettings(): void {
		if (!this.settings) {
			throw new LineConfigurationError("Settings not loaded");
		}

		if (!this.settings.channelAccessToken) {
			throw new LineConfigurationError(
				"LINE_CHANNEL_ACCESS_TOKEN is required",
				"LINE_CHANNEL_ACCESS_TOKEN",
			);
		}

		if (!this.settings.channelSecret) {
			throw new LineConfigurationError(
				"LINE_CHANNEL_SECRET is required",
				"LINE_CHANNEL_SECRET",
			);
		}
	}

	private async pushMessages(
		to: string,
		messages: Message[],
	): Promise<LineSendResult> {
		if (!this.client) {
			return { success: false, error: "Service not connected" };
		}

		// Send in batches of 5
		for (let i = 0; i < messages.length; i += MAX_LINE_BATCH_SIZE) {
			const batch = messages.slice(i, i + MAX_LINE_BATCH_SIZE);

			await this.client.pushMessage({
				to,
				messages: batch as unknown as messagingApi.Message[],
			});
		}

		// Emit sent event
		if (this.runtime) {
			this.runtime.emitEvent(LineEventTypes.MESSAGE_SENT, {
				runtime: this.runtime,
				source: "line",
				to,
				messageCount: messages.length,
			} as unknown as EventPayload);
		}

		return {
			success: true,
			messageId: Date.now().toString(),
			chatId: to,
		};
	}

	private async handleWebhookEvent(event: WebhookEvent): Promise<void> {
		if (!this.runtime) {
			return;
		}

		switch (event.type) {
			case "message":
				await this.handleMessageEvent(event);
				break;
			case "follow":
				this.runtime.emitEvent([LineEventTypes.FOLLOW], {
					runtime: this.runtime,
					source: "line",
					userId: event.source.userId,
					timestamp: event.timestamp,
				} as unknown as EventPayload);
				break;
			case "unfollow":
				this.runtime.emitEvent([LineEventTypes.UNFOLLOW], {
					runtime: this.runtime,
					source: "line",
					userId: event.source.userId,
					timestamp: event.timestamp,
				} as unknown as EventPayload);
				break;
			case "join":
				this.runtime.emitEvent([LineEventTypes.JOIN_GROUP], {
					runtime: this.runtime,
					source: "line",
					groupId:
						event.source.type === "group"
							? event.source.groupId
							: event.source.type === "room"
								? event.source.roomId
								: undefined,
					type: event.source.type,
					timestamp: event.timestamp,
				} as unknown as EventPayload);
				break;
			case "leave":
				this.runtime.emitEvent([LineEventTypes.LEAVE_GROUP], {
					runtime: this.runtime,
					source: "line",
					groupId:
						event.source.type === "group"
							? event.source.groupId
							: event.source.type === "room"
								? event.source.roomId
								: undefined,
					type: event.source.type,
					timestamp: event.timestamp,
				} as unknown as EventPayload);
				break;
			case "postback":
				this.runtime.emitEvent([LineEventTypes.POSTBACK], {
					runtime: this.runtime,
					source: "line",
					userId: event.source.userId,
					data: event.postback.data,
					params: event.postback.params,
					timestamp: event.timestamp,
				} as unknown as EventPayload);
				break;
		}
	}

	private async handleMessageEvent(
		event: WebhookEvent & { type: "message" },
	): Promise<void> {
		if (!this.runtime) {
			return;
		}

		const message: LineMessage = {
			id: event.message.id,
			type: event.message.type,
			userId: event.source.userId || "",
			timestamp: event.timestamp,
			replyToken: event.replyToken,
		};

		// Add text for text messages
		if (event.message.type === "text") {
			message.text = event.message.text;
			message.mention = event.message.mention;
		}

		// Add group/room ID if applicable
		if (event.source.type === "group") {
			message.groupId = event.source.groupId;
		} else if (event.source.type === "room") {
			message.roomId = event.source.roomId;
		}

		// Emit message received event
		this.runtime.emitEvent([LineEventTypes.MESSAGE_RECEIVED], {
			runtime: this.runtime,
			source: "line",
			message,
			lineSource: event.source,
			replyToken: event.replyToken,
		} as unknown as EventPayload);
	}
}

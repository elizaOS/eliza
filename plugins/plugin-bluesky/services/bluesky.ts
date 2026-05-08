import {
	ChannelType,
	type Content,
	type IAgentRuntime,
	logger,
	type Memory,
	Service,
	type UUID,
} from "@elizaos/core";
import { BlueSkyClient } from "../client";
import { BlueSkyAgentManager } from "../managers/agent";
import { BLUESKY_SERVICE_NAME } from "../types";
import {
	DEFAULT_BLUESKY_ACCOUNT_ID,
	normalizeBlueSkyAccountId,
	resolveDefaultBlueSkyAccountId,
	hasBlueSkyEnabled,
	validateBlueSkyConfig,
} from "../utils/config";
import { BlueSkyMessageService } from "./message";
import { BlueSkyPostService } from "./post";

type BlueSkyMessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0] & {
	fetchMessages?: BlueSkyMessageService["fetchConnectorMessages"];
	contentShaping?: {
		systemPromptFragment?: string;
		constraints?: Record<string, unknown>;
	};
};

type BlueSkyPostConnectorRegistration = {
	source: string;
	label?: string;
	description?: string;
	capabilities?: string[];
	contexts?: string[];
	metadata?: Record<string, unknown>;
	postHandler: (runtime: IAgentRuntime, content: Content) => Promise<Memory>;
	fetchFeed?: BlueSkyPostService["fetchFeed"];
	searchPosts?: BlueSkyPostService["searchPosts"];
	contentShaping?: {
		systemPromptFragment?: string;
		constraints?: Record<string, unknown>;
	};
};

type RuntimeWithPostConnector = IAgentRuntime & {
	registerPostConnector?: (
		registration: BlueSkyPostConnectorRegistration,
	) => void;
};

export class BlueSkyService extends Service {
	private static instance: BlueSkyService;
	private managers = new Map<UUID, BlueSkyAgentManager>();
	private messageServices = new Map<UUID, BlueSkyMessageService>();
	private postServices = new Map<UUID, BlueSkyPostService>();
	static serviceType = BLUESKY_SERVICE_NAME;
	readonly capabilityDescription = "Send and receive messages on BlueSky";

	private static getInstance(): BlueSkyService {
		BlueSkyService.instance ??= new BlueSkyService();
		return BlueSkyService.instance;
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = BlueSkyService.getInstance();

		if (service.managers.has(runtime.agentId)) {
			return service;
		}

		if (!hasBlueSkyEnabled(runtime)) {
			return service;
		}

		const config = validateBlueSkyConfig(runtime);
		const accountId = config.accountId;
		const client = new BlueSkyClient({
			service: config.service,
			handle: config.handle,
			password: config.password,
			dryRun: config.dryRun,
		});

		const manager = new BlueSkyAgentManager(runtime, config, client);
		service.managers.set(runtime.agentId, manager);
		service.messageServices.set(
			runtime.agentId,
			new BlueSkyMessageService(client, runtime, accountId),
		);
		service.postServices.set(
			runtime.agentId,
			new BlueSkyPostService(client, runtime, accountId),
		);

		await manager.start();
		logger.success({ agentId: runtime.agentId }, "BlueSky client started");

		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		const service = BlueSkyService.getInstance();
		const manager = service.managers.get(runtime.agentId);
		if (!manager) return;

		await manager.stop();
		service.managers.delete(runtime.agentId);
		service.messageServices.delete(runtime.agentId);
		service.postServices.delete(runtime.agentId);
		logger.info({ agentId: runtime.agentId }, "BlueSky client stopped");
	}

	static registerSendHandlers(
		runtime: IAgentRuntime,
		serviceInstance: BlueSkyService,
	): void {
		const messageService = serviceInstance?.getMessageService(runtime.agentId);
		const accountId =
			messageService?.getAccountId() ??
			normalizeBlueSkyAccountId(resolveDefaultBlueSkyAccountId(runtime));
		if (!messageService) {
			runtime.logger.warn(
				{ src: "plugin:bluesky", agentId: runtime.agentId },
				"Cannot register BlueSky DM connector; message service is not initialized",
			);
			return;
		}

		const postService = serviceInstance?.getPostService(runtime.agentId);
		if (postService) {
			BlueSkyService.registerPostConnector(runtime, postService);
		}

		const sendHandler = messageService.handleSendMessage.bind(messageService);
		if (typeof runtime.registerMessageConnector === "function") {
			const registration: BlueSkyMessageConnectorRegistration = {
				source: "bluesky",
				accountId,
				label: "BlueSky",
				description:
					"BlueSky DM connector for sending private messages to conversations.",
				capabilities: [
					"send_message",
					"fetch_messages",
					"resolve_targets",
					"list_rooms",
					"chat_context",
					"user_context",
				],
				supportedTargetKinds: ["thread", "user"],
				contexts: ["social", "connectors"],
				metadata: {
					accountId,
					service: BLUESKY_SERVICE_NAME,
				},
				resolveTargets:
					messageService.resolveConnectorTargets.bind(messageService),
				listRecentTargets:
					messageService.listRecentConnectorTargets.bind(messageService),
				listRooms: messageService.listConnectorRooms.bind(messageService),
				getChatContext:
					messageService.getConnectorChatContext.bind(messageService),
				getUserContext:
					messageService.getConnectorUserContext.bind(messageService),
				fetchMessages:
					messageService.fetchConnectorMessages.bind(messageService),
				contentShaping: {
					systemPromptFragment:
						"For BlueSky DMs, keep messages direct and conversational. Avoid public-feed conventions like hashtags unless the user asked.",
					constraints: {
						supportsMarkdown: false,
						channelType: ChannelType.DM,
					},
				},
				sendHandler,
			};
			runtime.registerMessageConnector(registration);
			runtime.logger.info(
				{ src: "plugin:bluesky", agentId: runtime.agentId },
				"Registered BlueSky DM connector",
			);
			return;
		}

		runtime.registerSendHandler("bluesky", sendHandler);
	}

	private static registerPostConnector(
		runtime: IAgentRuntime,
		postService: BlueSkyPostService,
	): void {
		const withPostConnector = runtime as RuntimeWithPostConnector;
		if (typeof withPostConnector.registerPostConnector !== "function") {
			return;
		}
		const accountId =
			postService.getAccountId?.() ?? DEFAULT_BLUESKY_ACCOUNT_ID;

		withPostConnector.registerPostConnector({
			source: "bluesky",
			accountId,
			label: "BlueSky",
			description:
				"BlueSky public feed connector for publishing posts, reading the timeline, and searching posts.",
			capabilities: ["post", "fetch_feed", "search_posts"],
			contexts: ["social", "social_posting", "connectors"],
			metadata: {
				accountId,
				service: BLUESKY_SERVICE_NAME,
			},
			postHandler: postService.handleSendPost.bind(postService),
			fetchFeed: postService.fetchFeed.bind(postService),
			searchPosts: postService.searchPosts.bind(postService),
			contentShaping: {
				systemPromptFragment:
					"For BlueSky posts, write a public post under 300 characters. Handles, links, and facets are supported by the connector; do not exceed the platform limit.",
				constraints: {
					maxLength: 300,
					supportsMarkdown: false,
					channelType: ChannelType.FEED,
				},
			},
		});

		runtime.logger.info(
			{ src: "plugin:bluesky", agentId: runtime.agentId },
			"Registered BlueSky post connector",
		);
	}

	async stop(): Promise<void> {
		for (const manager of this.managers.values()) {
			await BlueSkyService.stop(manager.runtime);
		}
	}

	getMessageService(agentId: UUID): BlueSkyMessageService | undefined {
		return this.messageServices.get(agentId);
	}

	getPostService(agentId: UUID): BlueSkyPostService | undefined {
		return this.postServices.get(agentId);
	}
}

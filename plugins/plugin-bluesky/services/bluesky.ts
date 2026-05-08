import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import {
	listBlueSkyAccountIds,
	resolveDefaultBlueSkyAccountId,
} from "../accounts";
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

interface AgentAccounts {
	defaultAccountId: string;
	managers: Map<string, BlueSkyAgentManager>;
	messageServices: Map<string, BlueSkyMessageService>;
	postServices: Map<string, BlueSkyPostService>;
}

export class BlueSkyService extends Service {
	private static instance: BlueSkyService;
	private agents = new Map<UUID, AgentAccounts>();
	static serviceType = BLUESKY_SERVICE_NAME;
	readonly capabilityDescription = "Send and receive messages on BlueSky";

	private static getInstance(): BlueSkyService {
		BlueSkyService.instance ??= new BlueSkyService();
		return BlueSkyService.instance;
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = BlueSkyService.getInstance();

		if (service.agents.has(runtime.agentId)) {
			return service;
		}

		if (!hasBlueSkyEnabled(runtime)) {
			return service;
		}

		const accountIds = listBlueSkyAccountIds(runtime);
		const defaultAccountId = resolveDefaultBlueSkyAccountId(runtime);
		const accounts: AgentAccounts = {
			defaultAccountId,
			managers: new Map(),
			messageServices: new Map(),
			postServices: new Map(),
		};
		service.agents.set(runtime.agentId, accounts);

		for (const accountId of accountIds) {
			const config = validateBlueSkyConfig(runtime, accountId);
			if (!config.handle || !config.password) {
				logger.warn(
					{ agentId: runtime.agentId, accountId },
					"Skipping BlueSky account without handle/password",
				);
				continue;
			}

			const client = new BlueSkyClient({
				service: config.service,
				handle: config.handle,
				password: config.password,
				dryRun: config.dryRun,
			});

			const manager = new BlueSkyAgentManager(runtime, config, client);
			accounts.managers.set(accountId, manager);
			accounts.messageServices.set(
				accountId,
				new BlueSkyMessageService(client, runtime, accountId),
			);
			accounts.postServices.set(
				accountId,
				new BlueSkyPostService(client, runtime, accountId),
			);

			await manager.start();
			logger.success(
				{ agentId: runtime.agentId, accountId },
				"BlueSky client started",
			);
		}

		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		const service = BlueSkyService.getInstance();
		const accounts = service.agents.get(runtime.agentId);
		if (!accounts) return;

		for (const manager of accounts.managers.values()) {
			await manager.stop();
		}
		service.agents.delete(runtime.agentId);
		logger.info({ agentId: runtime.agentId }, "BlueSky client stopped");
	}

	static registerSendHandlers(
		runtime: IAgentRuntime,
		serviceInstance: BlueSkyService,
	): void {
		const accounts = serviceInstance?.agents.get(runtime.agentId);
		const defaultAccountId = accounts?.defaultAccountId;
		const messageService = defaultAccountId
			? accounts?.messageServices.get(defaultAccountId)
			: undefined;
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
		for (const [agentId, accounts] of this.agents) {
			for (const manager of accounts.managers.values()) {
				await manager.stop();
			}
			this.agents.delete(agentId);
		}
	}

	getMessageService(
		agentId: UUID,
		accountId?: string,
	): BlueSkyMessageService | undefined {
		const accounts = this.agents.get(agentId);
		if (!accounts) return undefined;
		const id = accountId ?? accounts.defaultAccountId;
		return accounts.messageServices.get(id);
	}

	getPostService(
		agentId: UUID,
		accountId?: string,
	): BlueSkyPostService | undefined {
		const accounts = this.agents.get(agentId);
		if (!accounts) return undefined;
		const id = accountId ?? accounts.defaultAccountId;
		return accounts.postServices.get(id);
	}

	getDefaultAccountId(agentId: UUID): string | undefined {
		return this.agents.get(agentId)?.defaultAccountId;
	}

	listAccountIds(agentId: UUID): string[] {
		const accounts = this.agents.get(agentId);
		return accounts ? Array.from(accounts.managers.keys()) : [];
	}
}

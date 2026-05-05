import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import { BlueSkyClient } from "../client";
import { BlueSkyAgentManager } from "../managers/agent";
import { BLUESKY_SERVICE_NAME } from "../types";
import { hasBlueSkyEnabled, validateBlueSkyConfig } from "../utils/config";
import { BlueSkyMessageService } from "./message";
import { BlueSkyPostService } from "./post";

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
			new BlueSkyMessageService(client, runtime),
		);
		service.postServices.set(
			runtime.agentId,
			new BlueSkyPostService(client, runtime),
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
		if (!messageService) {
			runtime.logger.warn(
				{ src: "plugin:bluesky", agentId: runtime.agentId },
				"Cannot register BlueSky DM connector; message service is not initialized",
			);
			return;
		}

		const sendHandler = messageService.handleSendMessage.bind(messageService);
		if (typeof runtime.registerMessageConnector === "function") {
			runtime.registerMessageConnector({
				source: "bluesky",
				label: "BlueSky",
				description:
					"BlueSky DM connector for sending private messages to conversations.",
				capabilities: [
					"send_message",
					"resolve_targets",
					"list_rooms",
					"chat_context",
					"user_context",
				],
				supportedTargetKinds: ["thread", "user"],
				contexts: ["social", "connectors"],
				metadata: {
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
				sendHandler,
			});
			runtime.logger.info(
				{ src: "plugin:bluesky", agentId: runtime.agentId },
				"Registered BlueSky DM connector",
			);
			return;
		}

		runtime.registerSendHandler("bluesky", sendHandler);
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

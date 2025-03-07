import {
	logger,
	Service,
	type IAgentRuntime,
	type Plugin,
	type UUID,
} from "@elizaos/core";
import reply from "./actions/reply.ts";
import spaceJoin from "./actions/spaceJoin.ts";
import { ClientBase } from "./base.ts";
import { TWITTER_SERVICE_NAME } from "./constants.ts";
import type { TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSpaceClient } from "./spaces.ts";
import { TwitterTestSuite } from "./tests.ts";
import type { ITwitterClient } from "./types.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 */
export class TwitterClientInstance implements ITwitterClient {
	client: ClientBase;
	post: TwitterPostClient;
	interaction: TwitterInteractionClient;
	space?: TwitterSpaceClient;
	service: TwitterService;

	constructor(runtime: IAgentRuntime, state: any) {
		// Pass twitterConfig to the base client
		this.client = new ClientBase(runtime, state);

		// Posting logic
		this.post = new TwitterPostClient(this.client, runtime, state);

		// Mentions and interactions
		this.interaction = new TwitterInteractionClient(
			this.client,
			runtime,
			state,
		);

		// Optional Spaces logic (enabled if TWITTER_SPACES_ENABLE is true)
		if (runtime.getSetting("TWITTER_SPACES_ENABLE") === true) {
			this.space = new TwitterSpaceClient(this.client, runtime);
		}

		this.service = TwitterService.getInstance();
	}
}

export class TwitterService extends Service {
	static serviceType: string = TWITTER_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive messages on twitter";
	private static instance: TwitterService;
	private clients: Map<string, TwitterClientInstance> = new Map();

	static getInstance(): TwitterService {
		if (!TwitterService.instance) {
			TwitterService.instance = new TwitterService();
		}
		return TwitterService.instance;
	}

	async createClient(
		runtime: IAgentRuntime,
		clientId: string,
		state: any,
	): Promise<TwitterClientInstance> {
		console.log("Creating client", clientId);
		if (runtime.getSetting("TWITTER_2FA_SECRET") === null) {
			runtime.setSetting("TWITTER_2FA_SECRET", undefined, false);
		}
		try {
			// Check if client already exists
			const existingClient = this.getClient(clientId, runtime.agentId);
			if (existingClient) {
				logger.info(`Twitter client already exists for ${clientId}`);
				return existingClient;
			}

			// Create new client instance
			const client = new TwitterClientInstance(runtime, state);

			// Initialize the client
			await client.client.init();

			if (client.space) {
				client.space.startPeriodicSpaceCheck();
			}

			if (client.post) {
				client.post.start();
			}

			if (client.interaction) {
				client.interaction.start();
			}

			// Store the client instance
			this.clients.set(this.getClientKey(clientId, runtime.agentId), client);

			logger.info(`Created Twitter client for ${clientId}`);
			return client;
		} catch (error) {
			logger.error(`Failed to create Twitter client for ${clientId}:`, error);
			throw error;
		}
	}

	getClient(
		clientId: string,
		agentId: UUID,
	): TwitterClientInstance | undefined {
		return this.clients.get(this.getClientKey(clientId, agentId));
	}

	async stopClient(clientId: string, agentId: UUID): Promise<void> {
		const key = this.getClientKey(clientId, agentId);
		const client = this.clients.get(key);
		if (client) {
			try {
				await client.service.stop();
				this.clients.delete(key);
				logger.info(`Stopped Twitter client for ${clientId}`);
			} catch (error) {
				logger.error(`Error stopping Twitter client for ${clientId}:`, error);
			}
		}
	}

	static async start(runtime: IAgentRuntime) {
		const twitterClientManager = TwitterService.getInstance();

		// Check for character-level Twitter credentials
		const twitterConfig: Partial<TwitterConfig> = {
			TWITTER_USERNAME:
				(runtime.getSetting("TWITTER_USERNAME") as string) ||
				runtime.character.settings?.TWITTER_USERNAME ||
				runtime.character.secrets?.TWITTER_USERNAME,
			TWITTER_PASSWORD:
				(runtime.getSetting("TWITTER_PASSWORD") as string) ||
				runtime.character.settings?.TWITTER_PASSWORD ||
				runtime.character.secrets?.TWITTER_PASSWORD,
			TWITTER_EMAIL:
				(runtime.getSetting("TWITTER_EMAIL") as string) ||
				runtime.character.settings?.TWITTER_EMAIL ||
				runtime.character.secrets?.TWITTER_EMAIL,
			TWITTER_2FA_SECRET:
				(runtime.getSetting("TWITTER_2FA_SECRET") as string) ||
				runtime.character.settings?.TWITTER_2FA_SECRET ||
				runtime.character.secrets?.TWITTER_2FA_SECRET,
		};

		// Filter out undefined values
		const config = Object.fromEntries(
			Object.entries(twitterConfig).filter(([_, v]) => v !== undefined),
		) as TwitterConfig;

		// If we have enough settings to create a client, do so
		try {
			if (
				config.TWITTER_USERNAME &&
				// Basic auth
				config.TWITTER_PASSWORD &&
				config.TWITTER_EMAIL
				// ||
				// // API auth
				// (config.TWITTER_API_KEY && config.TWITTER_API_SECRET &&
				//  config.TWITTER_ACCESS_TOKEN && config.TWITTER_ACCESS_TOKEN_SECRET)
			) {
				logger.info("Creating default Twitter client from character settings");
				await twitterClientManager.createClient(
					runtime,
					runtime.agentId,
					config,
				);
			}
		} catch (error) {
			logger.error("Failed to create default Twitter client:", error);
		}

		return twitterClientManager;
	}

	async stop(): Promise<void> {
		await this.stopAllClients();
	}

	async stopAllClients(): Promise<void> {
		for (const [key, client] of this.clients.entries()) {
			try {
				await client.service.stop();
				this.clients.delete(key);
			} catch (error) {
				logger.error(`Error stopping Twitter client ${key}:`, error);
			}
		}
	}

	private getClientKey(clientId: string, agentId: UUID): string {
		return `${clientId}-${agentId}`;
	}
}

const twitterPlugin: Plugin = {
	name: TWITTER_SERVICE_NAME,
	description: "Twitter client with per-server instance management",
	services: [TwitterService],
	actions: [reply, spaceJoin],
	tests: [new TwitterTestSuite()],
};

export default twitterPlugin;

import { logger, type IAgentRuntime, type UUID } from "@elizaos/core";

import Birdeye from "./providers/birdeye";
import BuySignal from "./providers/buy-signal";
import CoinmarketCap from "./providers/coinmarketcap";
import Twitter from "./providers/twitter";
import TwitterParser from "./providers/twitter-parser";

/**
 * Registers tasks for the agent to perform various Intel-related actions.
 * * @param { IAgentRuntime } runtime - The agent runtime object.
 * @param { UUID } [worldId] - The optional world ID to associate with the tasks.
 * @returns {Promise<void>} - A promise that resolves once tasks are registered.
 */
export const registerTasks = async (runtime: IAgentRuntime, worldId?: UUID) => {
	worldId = runtime.agentId; // this is global data for the agent

	// first, get all tasks with tags "queue", "repeat", "degen_intel" and delete them
	const tasks = await runtime.getDatabaseAdapter().getTasks({
		tags: ["queue", "repeat", "degen_intel"],
	});

	for (const task of tasks) {
		await runtime.getDatabaseAdapter().deleteTask(task.id);
	}

	runtime.registerTaskWorker({
		name: "INTEL_BIRDEYE_SYNC_TRENDING",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const birdeye = new Birdeye(runtime);
			try {
				await birdeye.syncTrendingTokens("solana");
			} catch (error) {
				logger.error("Failed to sync trending tokens", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_BIRDEYE_SYNC_TRENDING",
		description: "Sync trending tokens from Birdeye",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 60, // 1 hour
		},
		tags: ["queue", "repeat", "degen_intel"],
	});

	runtime.registerTaskWorker({
		name: "INTEL_COINMARKETCAP_SYNC",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const cmc = new CoinmarketCap(runtime);
			try {
				await cmc.syncTokens();
			} catch (error) {
				logger.error("Failed to sync tokens", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_COINMARKETCAP_SYNC",
		description: "Sync tokens from Coinmarketcap",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 5, // 5 minutes
		},
		tags: ["queue", "repeat", "degen_intel"],
	});

	runtime.registerTaskWorker({
		name: "INTEL_SYNC_RAW_TWEETS",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const twitter = new Twitter(runtime);
			try {
				await twitter.syncRawTweets();
			} catch (error) {
				logger.error("Failed to sync raw tweets", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_SYNC_RAW_TWEETS",
		description: "Sync raw tweets from Twitter",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 15, // 15 minutes
		},
		tags: ["queue", "repeat", "degen_intel"],
	});

	runtime.registerTaskWorker({
		name: "INTEL_SYNC_WALLET",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const birdeye = new Birdeye(runtime);
			try {
				await birdeye.syncWallet();
			} catch (error) {
				logger.error("Failed to sync wallet", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_SYNC_WALLET",
		description: "Sync wallet from Birdeye",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 5, // 5 minutes
		},
		tags: ["queue", "repeat", "degen_intel"],
	});

	runtime.registerTaskWorker({
		name: "INTEL_GENERATE_BUY_SIGNAL",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const signal = new BuySignal(runtime);
			try {
				await signal.generateSignal();
			} catch (error) {
				logger.error("Failed to generate buy signal", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_GENERATE_BUY_SIGNAL",
		description: "Generate a buy signal",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 5, // 5 minutes
		},
		tags: ["queue", "repeat", "degen_intel"],
	});

	runtime.registerTaskWorker({
		name: "INTEL_PARSE_TWEETS",
		validate: async (_runtime, _message, _state) => {
			return true; // TODO: validate after certain time
		},
		execute: async (runtime, _options, task) => {
			const twitterParser = new TwitterParser(runtime);
			try {
				await twitterParser.parseTweets();
			} catch (error) {
				logger.error("Failed to parse tweets", error);
				// kill this task
				runtime.getDatabaseAdapter().deleteTask(task.id);
			}
		},
	});

	runtime.getDatabaseAdapter().createTask({
		name: "INTEL_PARSE_TWEETS",
		description: "Parse tweets",
		worldId,
		metadata: {
			updatedAt: Date.now(),
			updateInterval: 1000 * 60 * 60 * 24, // 24 hours
		},
		tags: ["queue", "repeat", "degen_intel"],
	});
};

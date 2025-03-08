// TODO: Replace with cache adapter

import {
	type Route,
	type IAgentRuntime,
	createUniqueUuid,
	type Memory,
} from "@elizaos/core";

import { SentimentArraySchema, TweetArraySchema } from "./schemas";

import type { IToken } from "./types";
import type {
	TransactionHistory,
	Portfolio,
	SentimentContent,
} from "./providers/birdeye";

/**
 * Definition of routes with type, path, and handler for each route.
 * Routes include fetching trending tokens, wallet information, tweets, sentiment analysis, and signals.
 */ 

export const routes: Route[] = [
	{
		type: "POST",
		path: "/trending",
		handler: async (_req: any, res: any, runtime) => {
			try {
				const cachedTokens = await runtime
					.getDatabaseAdapter()
					.getCache<IToken[]>("tokens_solana");
				const tokens: IToken[] = cachedTokens ? cachedTokens : [];
				const sortedTokens = tokens.sort(
					(a, b) => (a.rank || 0) - (b.rank || 0),
				);
				res.json(sortedTokens);
			} catch (_error) {
				res.status(500).json({ error: "Internal server error" });
			}
		},
	},
	{
		type: "POST",
		path: "/wallet",
		handler: async (_req: any, res: any, runtime: IAgentRuntime) => {
			try {
				// Get transaction history
				const cachedTxs = await runtime
					.getDatabaseAdapter()
					.getCache<TransactionHistory[]>("transaction_history");
				const transactions: TransactionHistory[] = cachedTxs ? cachedTxs : [];
				const history = transactions
					.filter((tx) => tx.data.mainAction === "received")
					.sort(
						(a, b) =>
							new Date(b.blockTime).getTime() - new Date(a.blockTime).getTime(),
					)
					.slice(0, 100);

				// Get portfolio
				const cachedPortfolio = await runtime
					.getDatabaseAdapter()
					.getCache<Portfolio>("portfolio");
				const portfolio: Portfolio = cachedPortfolio
					? cachedPortfolio
					: { key: "PORTFOLIO", data: null };

				res.json({ history, portfolio: portfolio.data });
			} catch (_error) {
				res.status(500).json({ error: "Internal server error" });
			}
		},
	},
	{
		type: "GET",
		path: "/tweets",
		handler: async (_req: any, res: any, runtime: IAgentRuntime) => {
			try {
				const memories = await runtime
					.getMemoryManager("messages")
					.getMemories({
						roomId: createUniqueUuid(runtime, "twitter-feed"),
						end: Date.now(),
						count: 50,
					});

				const tweets = memories
					.filter((m) => m.content.source === "twitter")
					.sort((a, b) => b.createdAt - a.createdAt)
					.map((m) => ({
						text: m.content.text,
						timestamp: m.createdAt,
						metadata: m.content.tweet || {},
					}));

				const validatedData = TweetArraySchema.parse(tweets);
				res.json(validatedData);
			} catch (_error) {
				res.status(500).json({ error: "Internal server error" });
			}
		},
	},
	{
		type: "GET",
		path: "/sentiment",
		handler: async (_req: any, res: any, runtime: IAgentRuntime) => {
			try {
				const memories = await runtime
					.getMemoryManager("messages")
					.getMemories({
						roomId: createUniqueUuid(runtime, "sentiment-analysis"),
						end: Date.now(),
						count: 30,
					});

				const sentiments = memories
					.filter(
						(m): m is Memory & { content: SentimentContent } =>
							m.content.source === "sentiment-analysis" &&
							!!m.content.metadata &&
							typeof m.content.metadata === "object" &&
							m.content.metadata !== null &&
							"processed" in m.content.metadata &&
							"occuringTokens" in m.content.metadata &&
							Array.isArray(m.content.metadata.occuringTokens) &&
							m.content.metadata.occuringTokens.length > 1,
					)
					.sort((a, b) => {
						const aTime = new Date(a.content.metadata.timeslot).getTime();
						const bTime = new Date(b.content.metadata.timeslot).getTime();
						return bTime - aTime;
					})
					.map((m) => ({
						timeslot: m.content.metadata.timeslot,
						text: m.content.text,
						processed: m.content.metadata.processed,
						occuringTokens: m.content.metadata.occuringTokens || [],
					}));

				const validatedData = SentimentArraySchema.parse(sentiments);
				res.json(validatedData);
			} catch (_error) {
				res.status(500).json({ error: "Internal server error" });
			}
		},
	},
	{
		type: "POST",
		path: "/signal",
		handler: async (_req: any, res: any, runtime: IAgentRuntime) => {
			try {
				const cachedSignal = await runtime
					.getDatabaseAdapter()
					.getCache<any>("BUY_SIGNAL");
				const signal = cachedSignal ? cachedSignal : {};
				res.json(signal?.data || {});
			} catch (_error) {
				res.status(500).json({ error: "Internal server error" });
			}
		},
	},
];

export default routes;

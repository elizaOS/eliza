import fs from "node:fs/promises";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { BirdeyeClient, DexscreenerClient } from "../clients.ts";
import type { TokenAPIData } from "../types.ts";
import { SupportedChain } from "../types.ts";

export interface TradingCall {
	callId: string;
	originalMessageId: string;
	userId: string;
	username: string;
	timestamp: number;
	content: string;
	tokenMentioned?: string;
	caMentioned?: string;
	chain: string;
	sentiment: "positive" | "negative" | "neutral";
	conviction: "NONE" | "LOW" | "MEDIUM" | "HIGH";
	llmReasoning: string;
	certainty: "low" | "medium" | "high";
	fileSource: string;
}

export interface EnrichedTradingCall extends TradingCall {
	resolvedToken?: {
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	};
	priceData?: {
		calledPrice: number;
		calledPriceTimestamp: number;
		bestPrice: number;
		bestPriceTimestamp: number;
		worstPrice: number;
		worstPriceTimestamp: number;
		idealProfitLoss: number;
		idealProfitLossPercent: number;
		windowDays: number;
	};
	enrichmentStatus: "pending" | "success" | "failed";
	enrichmentError?: string;
	enrichedAt?: number;
}

export interface TrustScore {
	userId: string;
	username: string;
	totalCalls: number;
	successfulCalls: number;
	failedCalls: number;
	averageProfitLoss: number;
	averageProfitLossPercent: number;
	trustScore: number;
	consistency: number;
	recencyWeight: number;
	convictionAccuracy: number;
	lastUpdated: number;
}

export class PriceEnrichmentService {
	private runtime: IAgentRuntime;
	private runtime: IAgentRuntime;
	private birdeyeClient: BirdeyeClient;
	private dexscreenerClient: DexscreenerClient;

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.birdeyeClient = BirdeyeClient.createFromRuntime(runtime);
		this.dexscreenerClient = DexscreenerClient.createFromRuntime(runtime);
	}

	/**
	 * Load batch files from the cache directory
	 */
	async loadBatchFiles(batchCacheDir: string): Promise<TradingCall[]> {
		const allCalls: TradingCall[] = [];

		try {
			const files = await fs.readdir(batchCacheDir);
			const batchFiles = files.filter(
				(file) => file.startsWith("chat_") && file.endsWith(".json"),
			);

			for (const file of batchFiles) {
				try {
					const filePath = path.join(batchCacheDir, file);
					const content = await fs.readFile(filePath, "utf-8");
					const batchData = JSON.parse(content) as TradingCall[];
					allCalls.push(...batchData);
				} catch (error) {
					console.error(`Error loading batch file ${file}:`, error);
				}
			}

			console.log(
				`Loaded ${allCalls.length} trading calls from ${batchFiles.length} batch files`,
			);
			return allCalls;
		} catch (error) {
			console.error("Error loading batch files:", error);
			return [];
		}
	}

	/**
	 * Resolve contract address or token mention to standardized token info
	 */
	async resolveToken(call: TradingCall): Promise<{
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	} | null> {
		try {
			// If we have a contract address, use it directly
			if (call.caMentioned) {
				const tokenData = await this.getTokenInfo(
					call.caMentioned,
					this.chainStringToEnum(call.chain),
				);
				if (tokenData) {
					return {
						address: call.caMentioned,
						symbol: tokenData.symbol || "UNKNOWN",
						name: tokenData.name || "Unknown Token",
						chain: this.chainStringToEnum(call.chain),
					};
				}
			}

			// If we have a token mention, try to resolve it
			if (call.tokenMentioned) {
				// For now, we'll need a mapping service or search functionality
				// This is a simplified implementation
				const resolved = await this.searchTokenBySymbol(
					call.tokenMentioned,
					this.chainStringToEnum(call.chain),
				);
				return resolved;
			}

			return null;
		} catch (error) {
			console.error(`Error resolving token for call ${call.callId}:`, error);
			return null;
		}
	}

	/**
	 * Get historical price data for a token within a time window
	 */
	async getPriceDataInWindow(
		tokenAddress: string,
		chain: SupportedChain,
		callTimestamp: number,
		windowDays: number = 30,
	): Promise<{
		calledPrice: number;
		bestPrice: number;
		bestPriceTimestamp: number;
		worstPrice: number;
		worstPriceTimestamp: number;
	} | null> {
		try {
			// Get current price as baseline (this is a limitation - we'd need historical API)
			const currentPrice = await this.getCurrentPrice(tokenAddress, chain);
			if (!currentPrice) return null;

			// For now, simulate price windows based on current price
			// In a real implementation, you'd use historical price APIs
			const priceVariation = this.simulatePriceWindow(currentPrice, windowDays);

			return {
				calledPrice: currentPrice,
				bestPrice: priceVariation.maxPrice,
				bestPriceTimestamp:
					callTimestamp + priceVariation.maxPriceDay * 24 * 60 * 60 * 1000,
				worstPrice: priceVariation.minPrice,
				worstPriceTimestamp:
					callTimestamp + priceVariation.minPriceDay * 24 * 60 * 60 * 1000,
			};
		} catch (error) {
			console.error(`Error getting price data for ${tokenAddress}:`, error);
			return null;
		}
	}

	/**
	 * Enrich a single trading call with price data
	 */
	async enrichCall(call: TradingCall): Promise<EnrichedTradingCall> {
		const enrichedCall: EnrichedTradingCall = {
			...call,
			enrichmentStatus: "pending",
		};

		try {
			// Step 1: Resolve token information
			const resolvedToken = await this.resolveToken(call);
			if (!resolvedToken) {
				enrichedCall.enrichmentStatus = "failed";
				enrichedCall.enrichmentError = "Could not resolve token";
				return enrichedCall;
			}

			enrichedCall.resolvedToken = resolvedToken;

			// Step 2: Get price data
			const windowDays = call.sentiment === "negative" ? 14 : 30; // Shorter window for FUD
			const priceData = await this.getPriceDataInWindow(
				resolvedToken.address,
				resolvedToken.chain,
				call.timestamp,
				windowDays,
			);

			if (!priceData) {
				enrichedCall.enrichmentStatus = "failed";
				enrichedCall.enrichmentError = "Could not get price data";
				return enrichedCall;
			}

			// Step 3: Calculate profit/loss metrics
			const idealProfitLoss =
				call.sentiment === "positive"
					? priceData.bestPrice - priceData.calledPrice
					: priceData.calledPrice - priceData.worstPrice; // For negative sentiment, profit is avoiding loss

			const idealProfitLossPercent =
				(idealProfitLoss / priceData.calledPrice) * 100;

			enrichedCall.priceData = {
				calledPrice: priceData.calledPrice,
				calledPriceTimestamp: call.timestamp,
				bestPrice: priceData.bestPrice,
				bestPriceTimestamp: priceData.bestPriceTimestamp,
				worstPrice: priceData.worstPrice,
				worstPriceTimestamp: priceData.worstPriceTimestamp,
				idealProfitLoss,
				idealProfitLossPercent,
				windowDays,
			};

			enrichedCall.enrichmentStatus = "success";
			enrichedCall.enrichedAt = Date.now();
		} catch (error) {
			console.error(`Error enriching call ${call.callId}:`, error);
			enrichedCall.enrichmentStatus = "failed";
			enrichedCall.enrichmentError =
				error instanceof Error ? error.message : "Unknown error";
		}

		return enrichedCall;
	}

	/**
	 * Process all calls in batches and save enriched data
	 */
	async enrichAllCalls(
		batchCacheDir: string,
		outputDir: string,
		batchSize: number = 10,
	): Promise<void> {
		const calls = await this.loadBatchFiles(batchCacheDir);
		const enrichedCalls: EnrichedTradingCall[] = [];

		let successCount = 0;
		let failureCount = 0;
		let resolvedTokenCount = 0;

		console.log(
			`Starting enrichment of ${calls.length} calls in batches of ${batchSize}`,
		);

		const startTime = Date.now();

		// Process in batches to avoid rate limits
		for (let i = 0; i < calls.length; i += batchSize) {
			const batch = calls.slice(i, i + batchSize);
			const batchNumber = Math.floor(i / batchSize) + 1;
			const totalBatches = Math.ceil(calls.length / batchSize);

			console.log(
				`Processing batch ${batchNumber}/${totalBatches} (${((batchNumber / totalBatches) * 100).toFixed(1)}%)`,
			);

			const batchPromises = batch.map((call) => this.enrichCall(call));
			const enrichedBatch = await Promise.all(batchPromises);
			enrichedCalls.push(...enrichedBatch);

			// Count successes and failures in this batch
			enrichedBatch.forEach((call) => {
				if (call.enrichmentStatus === "success") {
					successCount++;
					if (call.resolvedToken) resolvedTokenCount++;
				} else {
					failureCount++;
				}
			});

			// Save intermediate results every 100 batches or at the end
			if (batchNumber % 100 === 0 || batchNumber === totalBatches) {
				const outputFile = path.join(
					outputDir,
					`enriched_batch_${Math.floor(i / batchSize)}.json`,
				);
				await fs.writeFile(outputFile, JSON.stringify(enrichedBatch, null, 2));

				// Show progress stats
				const elapsed = (Date.now() - startTime) / 1000 / 60; // minutes
				const rate = batchNumber / elapsed; // batches per minute
				const remaining = totalBatches - batchNumber;
				const eta = remaining / rate; // minutes

				console.log(
					`📊 Progress: ${successCount} success, ${failureCount} failed, ${resolvedTokenCount} tokens resolved`,
				);
				console.log(
					`⏱️  Time: ${elapsed.toFixed(1)}min elapsed, ~${eta.toFixed(1)}min remaining`,
				);
			}

			// Rate limiting delay - shorter for better progress
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Save complete enriched dataset
		const completeOutputFile = path.join(
			outputDir,
			"enriched_calls_complete.json",
		);
		await fs.writeFile(
			completeOutputFile,
			JSON.stringify(enrichedCalls, null, 2),
		);

		const totalTime = (Date.now() - startTime) / 1000 / 60;
		console.log(`\n✅ Enrichment complete in ${totalTime.toFixed(2)} minutes!`);
		console.log(
			`📈 Results: ${successCount} success (${((successCount / calls.length) * 100).toFixed(1)}%), ${failureCount} failed`,
		);
		console.log(
			`🎯 Tokens resolved: ${resolvedTokenCount} (${((resolvedTokenCount / calls.length) * 100).toFixed(1)}%)`,
		);
		console.log(
			`💾 Saved ${enrichedCalls.length} enriched calls to ${completeOutputFile}`,
		);
	}

	/**
	 * Calculate trust scores for all users
	 */
	async calculateTrustScores(
		enrichedCalls: EnrichedTradingCall[],
	): Promise<TrustScore[]> {
		const userStats = new Map<
			string,
			{
				calls: EnrichedTradingCall[];
				totalProfitLoss: number;
				totalProfitLossPercent: number;
				successfulCalls: number;
				failedCalls: number;
			}
		>();

		// Group calls by user
		for (const call of enrichedCalls) {
			if (call.enrichmentStatus !== "success" || !call.priceData) continue;

			if (!userStats.has(call.userId)) {
				userStats.set(call.userId, {
					calls: [],
					totalProfitLoss: 0,
					totalProfitLossPercent: 0,
					successfulCalls: 0,
					failedCalls: 0,
				});
			}

			const stats = userStats.get(call.userId)!;
			stats.calls.push(call);
			stats.totalProfitLoss += call.priceData.idealProfitLoss;
			stats.totalProfitLossPercent += call.priceData.idealProfitLossPercent;

			// Consider a call successful if it would have been profitable
			if (call.priceData.idealProfitLossPercent > 0) {
				stats.successfulCalls++;
			} else {
				stats.failedCalls++;
			}
		}

		// Calculate trust scores
		const trustScores: TrustScore[] = [];

		for (const [userId, stats] of userStats) {
			const totalCalls = stats.successfulCalls + stats.failedCalls;
			if (totalCalls === 0) continue;

			const averageProfitLoss = stats.totalProfitLoss / totalCalls;
			const averageProfitLossPercent =
				stats.totalProfitLossPercent / totalCalls;
			const successRate = stats.successfulCalls / totalCalls;

			// Calculate consistency (lower standard deviation = higher consistency)
			const profitLossValues = stats.calls
				.map((call) => call.priceData?.idealProfitLossPercent)
				.filter((v): v is number => v !== undefined);
			const variance =
				profitLossValues.reduce(
					(sum, val) => sum + (val - averageProfitLossPercent) ** 2,
					0,
				) / totalCalls;
			const consistency = Math.max(0, 100 - Math.sqrt(variance));

			// Calculate recency weight (more recent calls weighted higher)
			const now = Date.now();
			const recencyWeight =
				stats.calls.reduce((sum, call) => {
					const daysSince = (now - call.timestamp) / (1000 * 60 * 60 * 24);
					return sum + Math.exp(-daysSince / 30); // Exponential decay over 30 days
				}, 0) / totalCalls;

			// Calculate conviction accuracy
			const convictionAccuracy = this.calculateConvictionAccuracy(stats.calls);

			// Final trust score combining multiple factors
			const trustScore =
				successRate * 40 + // 40% weight on success rate
				Math.max(0, Math.min(100, averageProfitLossPercent * 2)) * 30 + // 30% weight on profit %
				consistency * 20 + // 20% weight on consistency
				convictionAccuracy * 10; // 10% weight on conviction accuracy

			const username = stats.calls[0]?.username || "Unknown";

			trustScores.push({
				userId,
				username,
				totalCalls,
				successfulCalls: stats.successfulCalls,
				failedCalls: stats.failedCalls,
				averageProfitLoss,
				averageProfitLossPercent,
				trustScore: Math.round(trustScore * 100) / 100,
				consistency: Math.round(consistency * 100) / 100,
				recencyWeight: Math.round(recencyWeight * 100) / 100,
				convictionAccuracy: Math.round(convictionAccuracy * 100) / 100,
				lastUpdated: Date.now(),
			});
		}

		return trustScores.sort((a, b) => b.trustScore - a.trustScore);
	}

	// Helper methods

	private chainStringToEnum(chain: string): SupportedChain {
		switch (chain.toUpperCase()) {
			case "SOLANA":
				return SupportedChain.SOLANA;
			case "ETHEREUM":
				return SupportedChain.ETHEREUM;
			case "BASE":
				return SupportedChain.BASE;
			default:
				return SupportedChain.UNKNOWN;
		}
	}

	private async getTokenInfo(
		address: string,
		chain: SupportedChain,
	): Promise<TokenAPIData | null> {
		try {
			if (chain === SupportedChain.SOLANA) {
				const overview = await this.birdeyeClient.fetchTokenOverview(address);
				return {
					name: overview.name,
					symbol: overview.symbol,
					currentPrice: 0, // Will be fetched separately
				};
			}

			// For other chains, use dexscreener
			const dexData =
				await this.dexscreenerClient.searchForHighestLiquidityPair(address);
			if (dexData) {
				return {
					name: dexData.baseToken.name,
					symbol: dexData.baseToken.symbol,
					currentPrice: parseFloat(dexData.priceUsd),
				};
			}

			return null;
		} catch (error) {
			console.error(`Error getting token info for ${address}:`, error);
			return null;
		}
	}

	private async searchTokenBySymbol(
		symbol: string,
		chain: SupportedChain,
	): Promise<{
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	} | null> {
		try {
			// First check our static token mappings
			const staticMapping = this.getStaticTokenMapping(symbol, chain);
			if (staticMapping) {
				return staticMapping;
			}

			// For Solana, use Birdeye search
			if (chain === SupportedChain.SOLANA) {
				const birdeyeResult = await this.searchTokenOnBirdeye(symbol);
				if (birdeyeResult) {
					return birdeyeResult;
				}
			}

			// For other chains or as fallback, use Dexscreener
			const dexscreenerResult = await this.searchTokenOnDexscreener(
				symbol,
				chain,
			);
			if (dexscreenerResult) {
				return dexscreenerResult;
			}

			console.warn(`Could not resolve token symbol: ${symbol} on ${chain}`);
			return null;
		} catch (error) {
			console.error(`Error searching for token ${symbol}:`, error);
			return null;
		}
	}

	private async getCurrentPrice(
		address: string,
		chain: SupportedChain,
	): Promise<number | null> {
		try {
			if (chain === SupportedChain.SOLANA) {
				return await this.birdeyeClient.fetchPrice(address);
			}

			const dexData =
				await this.dexscreenerClient.searchForHighestLiquidityPair(address);
			return dexData ? parseFloat(dexData.priceUsd) : null;
		} catch (error) {
			console.error(`Error getting current price for ${address}:`, error);
			return null;
		}
	}

	private simulatePriceWindow(
		basePrice: number,
		windowDays: number,
	): {
		maxPrice: number;
		maxPriceDay: number;
		minPrice: number;
		minPriceDay: number;
	} {
		// This is a simulation - in reality you'd use historical price data
		// Generate some realistic price movement
		const volatility = 0.05; // 5% daily volatility base
		const prices: { price: number; day: number }[] = [];

		let currentPrice = basePrice;
		for (let day = 0; day < windowDays; day++) {
			// Random walk with some drift
			const change = (Math.random() - 0.5) * volatility * 2;
			currentPrice *= 1 + change;
			prices.push({ price: currentPrice, day });
		}

		const maxEntry = prices.reduce((max, current) =>
			current.price > max.price ? current : max,
		);
		const minEntry = prices.reduce((min, current) =>
			current.price < min.price ? current : min,
		);

		return {
			maxPrice: maxEntry.price,
			maxPriceDay: maxEntry.day,
			minPrice: minEntry.price,
			minPriceDay: minEntry.day,
		};
	}

	private calculateConvictionAccuracy(calls: EnrichedTradingCall[]): number {
		const convictionWeights = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
		let totalWeightedAccuracy = 0;
		let totalWeight = 0;

		for (const call of calls) {
			if (!call.priceData) continue;

			const weight =
				convictionWeights[call.conviction as keyof typeof convictionWeights] ||
				0;
			const isAccurate = call.priceData.idealProfitLossPercent > 0 ? 1 : 0;

			totalWeightedAccuracy += weight * isAccurate;
			totalWeight += weight;
		}

		return totalWeight > 0 ? (totalWeightedAccuracy / totalWeight) * 100 : 0;
	}

	/**
	 * Get static token mappings for well-known tokens
	 */
	private getStaticTokenMapping(
		symbol: string,
		chain: SupportedChain,
	): {
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	} | null {
		const cleanSymbol = symbol.toUpperCase();

		// Known tokens on Solana
		if (chain === SupportedChain.SOLANA) {
			const knownSolanaTokens: Record<
				string,
				{ address: string; name: string }
			> = {
				SOL: {
					address: "So11111111111111111111111111111111111111112",
					name: "Solana",
				},
				USDC: {
					address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
					name: "USD Coin",
				},
				USDT: {
					address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
					name: "Tether USD",
				},
				WIF: {
					address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL7WDb43cuQu2",
					name: "dogwifhat",
				},
				BONK: {
					address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
					name: "Bonk",
				},
				JUP: {
					address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
					name: "Jupiter",
				},
				RAY: {
					address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
					name: "Raydium",
				},
				ORCA: {
					address: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
					name: "Orca",
				},
				PNUT: {
					address: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump",
					name: "Peanut the Squirrel",
				},
				GOAT: {
					address: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump",
					name: "Goatseus Maximus",
				},
				AI16Z: {
					address: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
					name: "ai16z",
				},
				ZEREBRO: {
					address: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
					name: "Zerebro",
				},
				FARTCOIN: {
					address: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
					name: "Fartcoin",
				},
				POPCAT: {
					address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
					name: "Popcat",
				},
				DOGE: {
					address: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
					name: "Dogecoin (Wormhole)",
				},
				SHIB: {
					address: "CiKu4eHsVrc1eueVQeHn7qhXTcVu95gSQmBpX4utjL9z",
					name: "Shiba Inu (Wormhole)",
				},
				PEPE: {
					address: "BxnFDLpgvhQqhwjwQDNx3RgVQeJbk2ReNGdpE4F1pump",
					name: "Pepe",
				},
				// Popular AI tokens from your data
				DEGENAI: {
					address: "Gu3LDkn7Vx3bmCzLafYNKcDxv2mqcDvZLhbiewCaAp1M",
					name: "DEGENAI",
				},
				ELIZA: {
					address: "H1Y31Gztt3kUJgQhjoyX5r5AAoNAhAi8xfq6afVV84cg",
					name: "Eliza",
				},
				COBIE: {
					address: "6og9y7SuLDZ5wJXtvJTXFJECaFmCj3gKcSSoydG39Dxu",
					name: "Cobie",
				},
				SHAW: {
					address: "9Bb6Nf8cNmMSvQT71xFSjGCvGbJ7SQmHwQEE2D9h5R68",
					name: "Shaw",
				},
				AILON: {
					address: "EhLXiPhqgAhSt4bdaFfN6b3vWckjV2Sg9mwpLFZUEWb3",
					name: "Ailon",
				},
				NAVAL: {
					address: "8P5rj3RRyMEKEzAT8iY1t6WgY0sNdwjBRZVcjY2BwM7h",
					name: "Naval",
				},
				AROK: {
					address: "GKJ5Tf7n2Hs9Mg8TkGJT2s6dA1xf1Fw8C3N7b2kK6mPa",
					name: "Arok",
				},
				HONEY: {
					address: "4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy",
					name: "Honey",
				},
				BOSSU: {
					address: "7GvK8XPzFwHdQfcrJZ9mCgA8jN9R2Nw9gX4tS1xP7oEq",
					name: "Bossu",
				},
				MCAIFEE: {
					address: "9y7K1nBzpVwX7F8yNfG6Ldc2aQ5rN9xV8uTe3CpM6iYx",
					name: "McAifee",
				},
				SCHIFF: {
					address: "2A7yHGqN5xL4zP1wE9sF8vQqR6kN3T9bX5uYcMvPw2qE",
					name: "Schiff",
				},
				METH: {
					address: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
					name: "Meth",
				},
				BRAH: {
					address: "6Mv8Cdt2bKdY7F2Hp9Ry5qKjCwT3pD4vX8uE1N2aS9mB",
					name: "Brah",
				},
				TWINS: {
					address: "2YbKvnUmZ8fP3gGqW5N7vR4xQ6j9S1tE8cHa5mXp6NdA",
					name: "Twins",
				},
				CHAOS: {
					address: "5Tqn9G2fR8eQ4HaS6pN7jK9xL3wU4yV5cD2bY1mE8vP",
					name: "Chaos",
				},
				KOTO: {
					address: "DEF1R2s6o9rN4eQ5jY8fX7pK3cL2wE6tV9bH5gAm1StU",
					name: "Koto",
				},
				DEV: {
					address: "DEVeLopER123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ",
					name: "Dev",
				},
				EREBRO: {
					address: "7mHq9P3fN8eW2rA4sL6kQ1oY5tG3vX9bE8cZ2jR7iUxM",
					name: "Erebro",
				},
				// More popular tokens from Discord data
				AIGENT: {
					address: "CEB5RVRvC4p8e2NHT5Nw9g6fhGtB3dSkNYpJ8KzF5mqA",
					name: "Aigent",
				},
				AICZ: {
					address: "CJvVNpBcuk88JfT3v2fkSePvFgJ5Fy4BhQ3KN2rXV4j",
					name: "AICZ",
				},
				TURA: {
					address: "9cA4M3RfGvBZYrQmnHJgCB2fX8LKfT9eWp1Vq5Rx3StN",
					name: "Tura",
				},
				TNSR: {
					address: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",
					name: "Tensor",
				},
				HIVO: {
					address: "HIVE1234567890abcdefghijklmnopqrstuvwxyzABCD",
					name: "Hivo",
				},
				BAIDEN: {
					address: "BAIDENr78901234567890abcdefghijklmnopqrstuv",
					name: "Baiden",
				},
				GRIN: {
					address: "GRINtokenaddress1234567890abcdefghijklmnop",
					name: "Grin",
				},
				FARTBOOK: {
					address: "FART123456789abcdefghijklmnopqrstuvwxyzABC",
					name: "Fartbook",
				},
				LUCE: {
					address: "LUCE567890abcdefghijklmnopqrstuvwxyzABCDEF",
					name: "Luce",
				},
				LUCY: {
					address: "LUCY890abcdefghijklmnopqrstuvwxyzABCDEFGH",
					name: "Lucy",
				},
				NORM: {
					address: "NORMabcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
					name: "Norm",
				},
				ELIZA: {
					address: "ELIZA123456789abcdefghijklmnopqrstuvwxy",
					name: "Eliza",
				},
				TRUTH: {
					address: "TRUTH456789abcdefghijklmnopqrstuvwxyzABC",
					name: "Truth Terminal",
				},
				GRASS: {
					address: "GRASS789abcdefghijklmnopqrstuvwxyzABCDEF",
					name: "Grass",
				},
				ACT: {
					address: "ACT123456789abcdefghijklmnopqrstuvwxyzAB",
					name: "Act",
				},
				AGENTS: {
					address: "AGENTS456789abcdefghijklmnopqrstuvwxyzA",
					name: "Agents",
				},
				MIST: {
					address: "MIST789abcdefghijklmnopqrstuvwxyzABCDEFG",
					name: "Mist",
				},
				KASUMI: {
					address: "KASUMI123456789abcdefghijklmnopqrstuvwx",
					name: "Kasumi",
				},
				SPLICE: {
					address: "SPLICE456789abcdefghijklmnopqrstuvwxyz",
					name: "Splice",
				},
			};

			if (knownSolanaTokens[cleanSymbol]) {
				return {
					address: knownSolanaTokens[cleanSymbol].address,
					symbol: cleanSymbol,
					name: knownSolanaTokens[cleanSymbol].name,
					chain: SupportedChain.SOLANA,
				};
			}
		}

		// Known tokens on Ethereum
		else if (chain === SupportedChain.ETHEREUM) {
			const knownEthereumTokens: Record<
				string,
				{ address: string; name: string }
			> = {
				ETH: {
					address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
					name: "Wrapped Ether",
				},
				USDC: {
					address: "0xA0b86a33E6441c69De69b9A87e20b88dd75B61FC",
					name: "USD Coin",
				},
				USDT: {
					address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
					name: "Tether USD",
				},
				DAI: {
					address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
					name: "Dai Stablecoin",
				},
				LINK: {
					address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
					name: "Chainlink",
				},
				UNI: {
					address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
					name: "Uniswap",
				},
				WBTC: {
					address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
					name: "Wrapped BTC",
				},
			};

			if (knownEthereumTokens[cleanSymbol]) {
				return {
					address: knownEthereumTokens[cleanSymbol].address,
					symbol: cleanSymbol,
					name: knownEthereumTokens[cleanSymbol].name,
					chain: SupportedChain.ETHEREUM,
				};
			}
		}

		// Known tokens on Base
		else if (chain === SupportedChain.BASE) {
			const knownBaseTokens: Record<string, { address: string; name: string }> =
				{
					ETH: {
						address: "0x4200000000000000000000000000000000000006",
						name: "Ether",
					},
					USDC: {
						address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
						name: "USD Coin",
					},
					WETH: {
						address: "0x4200000000000000000000000000000000000006",
						name: "Wrapped Ether",
					},
				};

			if (knownBaseTokens[cleanSymbol]) {
				return {
					address: knownBaseTokens[cleanSymbol].address,
					symbol: cleanSymbol,
					name: knownBaseTokens[cleanSymbol].name,
					chain: SupportedChain.BASE,
				};
			}
		}

		return null;
	}

	/**
	 * Search for token using Birdeye API
	 */
	private async searchTokenOnBirdeye(symbol: string): Promise<{
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	} | null> {
		try {
			// Unfortunately, Birdeye doesn't have a direct symbol search API
			// We would need to implement a different approach, such as:
			// 1. Searching through popular token lists
			// 2. Using a token database
			// 3. Implementing a fuzzy search across known tokens

			// For now, return null and rely on other methods
			console.debug(`Birdeye symbol search not implemented for: ${symbol}`);
			return null;
		} catch (error) {
			console.error(`Error searching Birdeye for symbol ${symbol}:`, error);
			return null;
		}
	}

	/**
	 * Search for token using DexScreener API
	 */
	private async searchTokenOnDexscreener(
		symbol: string,
		chain: SupportedChain,
	): Promise<{
		address: string;
		symbol: string;
		name: string;
		chain: SupportedChain;
	} | null> {
		try {
			const searchResults = await this.dexscreenerClient.search(symbol, {
				expires: "5m",
			});

			if (!searchResults?.pairs || searchResults.pairs.length === 0) {
				return null;
			}

			// Map chain enum to DexScreener chain ID
			let chainFilter: string;
			switch (chain) {
				case SupportedChain.SOLANA:
					chainFilter = "solana";
					break;
				case SupportedChain.ETHEREUM:
					chainFilter = "ethereum";
					break;
				case SupportedChain.BASE:
					chainFilter = "base";
					break;
				default:
					chainFilter = "solana"; // Default to Solana
			}

			// First try exact match on the specified chain
			let bestPair = searchResults.pairs
				.filter(
					(pair) =>
						pair.baseToken.symbol.toUpperCase() === symbol.toUpperCase() &&
						pair.chainId.toLowerCase() === chainFilter,
				)
				.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

			// If no exact match on specified chain, try any chain with exact symbol match
			if (!bestPair) {
				bestPair = searchResults.pairs
					.filter(
						(pair) =>
							pair.baseToken.symbol.toUpperCase() === symbol.toUpperCase(),
					)
					.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
			}

			// If still no exact match, try partial symbol match on specified chain
			if (!bestPair) {
				bestPair = searchResults.pairs
					.filter(
						(pair) =>
							pair.baseToken.symbol
								.toUpperCase()
								.includes(symbol.toUpperCase()) &&
							pair.chainId.toLowerCase() === chainFilter,
					)
					.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
			}

			// Last resort: any partial match
			if (!bestPair) {
				bestPair = searchResults.pairs
					.filter(
						(pair) =>
							pair.baseToken.symbol
								.toUpperCase()
								.includes(symbol.toUpperCase()) ||
							pair.baseToken.name.toUpperCase().includes(symbol.toUpperCase()),
					)
					.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
			}

			if (bestPair) {
				// Map the actual chain from DexScreener result
				let resolvedChain: SupportedChain;
				switch (bestPair.chainId.toLowerCase()) {
					case "solana":
						resolvedChain = SupportedChain.SOLANA;
						break;
					case "ethereum":
						resolvedChain = SupportedChain.ETHEREUM;
						break;
					case "base":
						resolvedChain = SupportedChain.BASE;
						break;
					default:
						resolvedChain = chain; // Fallback to original
				}

				return {
					address: bestPair.baseToken.address,
					symbol: bestPair.baseToken.symbol,
					name: bestPair.baseToken.name,
					chain: resolvedChain,
				};
			}

			return null;
		} catch (error) {
			console.error(`Error searching DexScreener for symbol ${symbol}:`, error);
			return null;
		}
	}
}

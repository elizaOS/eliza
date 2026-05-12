import fs from "node:fs/promises";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { SupportedChain } from "../types";

// Re-export types from the original services
export {
	HistoricalPriceData,
	PricePoint,
	TokenResolution,
} from "./historicalPriceService";

export {
	EnrichedTradingCall,
	TradingCall,
	TrustScore,
} from "./priceEnrichmentService";

// Import the original services
import { HistoricalPriceService } from "./historicalPriceService";
import { PriceEnrichmentService } from "./priceEnrichmentService";

/**
 * Consolidated Price Data Service that combines historical and enrichment functionality
 */
export class PriceDataService {
	private historicalService: HistoricalPriceService;
	private enrichmentService: PriceEnrichmentService;

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.historicalService = new HistoricalPriceService(runtime);
		this.enrichmentService = new PriceEnrichmentService(runtime);
	}

	// ========== Historical Price Service Methods ==========

	async fetchBirdeyeHistoricalPrices(
		address: string,
		fromTimestamp: number,
		toTimestamp: number,
	): Promise<any> {
		return this.historicalService.fetchBirdeyeHistoricalPrices(
			address,
			fromTimestamp,
			toTimestamp,
		);
	}

	async fetchDexscreenerHistoricalPrices(
		address: string,
		chain: SupportedChain,
		fromTimestamp: number,
		toTimestamp: number,
	): Promise<any> {
		return this.historicalService.fetchDexscreenerHistoricalPrices(
			address,
			chain,
			fromTimestamp,
			toTimestamp,
		);
	}

	getPriceAtTimestamp(historicalData: any, timestamp: number): number | null {
		return this.historicalService.getPriceAtTimestamp(
			historicalData,
			timestamp,
		);
	}

	getMaxPriceInWindow(
		historicalData: any,
		fromTimestamp: number,
		toTimestamp: number,
	): any {
		return this.historicalService.getMaxPriceInWindow(
			historicalData,
			fromTimestamp,
			toTimestamp,
		);
	}

	async findBestTokenMatch(
		symbol: string,
		chain: SupportedChain,
	): Promise<any> {
		return this.historicalService.findBestTokenMatch(symbol, chain);
	}

	// ========== Price Enrichment Service Methods ==========

	async loadBatchFiles(batchCacheDir: string): Promise<any[]> {
		return this.enrichmentService.loadBatchFiles(batchCacheDir);
	}

	async resolveToken(call: any): Promise<any> {
		return this.enrichmentService.resolveToken(call);
	}

	async getPriceDataInWindow(
		tokenAddress: string,
		chain: SupportedChain,
		callTimestamp: number,
		windowDays?: number,
	): Promise<any> {
		return this.enrichmentService.getPriceDataInWindow(
			tokenAddress,
			chain,
			callTimestamp,
			windowDays,
		);
	}

	async enrichCall(call: any): Promise<any> {
		return this.enrichmentService.enrichCall(call);
	}

	async enrichAllCalls(
		batchCacheDir: string,
		outputDir: string,
		batchSize?: number,
	): Promise<void> {
		return this.enrichmentService.enrichAllCalls(
			batchCacheDir,
			outputDir,
			batchSize,
		);
	}

	async calculateTrustScores(enrichedCalls: any[]): Promise<any[]> {
		return this.enrichmentService.calculateTrustScores(enrichedCalls);
	}

	// ========== Convenience Methods ==========

	/**
	 * Get current price for a token using the best available source
	 */
	async getCurrentPrice(
		address: string,
		chain: SupportedChain,
	): Promise<number | null> {
		try {
			// Try Birdeye first for Solana
			if (chain === SupportedChain.SOLANA) {
				const historicalData = await this.fetchBirdeyeHistoricalPrices(
					address,
					Date.now() - 60000, // 1 minute ago
					Date.now(),
				);
				if (historicalData?.lastPrice) {
					return historicalData.lastPrice;
				}
			}

			// Fallback to DexScreener
			const dexData = await this.fetchDexscreenerHistoricalPrices(
				address,
				chain,
				Date.now() - 60000,
				Date.now(),
			);

			return dexData?.lastPrice || null;
		} catch (error) {
			console.error(`Error fetching current price for ${address}:`, error);
			return null;
		}
	}

	/**
	 * Enrich a batch of trading calls with price data and calculate trust scores
	 */
	async processAndScoreTradingCalls(
		calls: any[],
		outputDir: string,
	): Promise<{
		enrichedCalls: any[];
		trustScores: any[];
	}> {
		// Enrich calls
		const enrichedCalls = await Promise.all(
			calls.map((call) => this.enrichCall(call)),
		);

		// Calculate trust scores
		const trustScores = await this.calculateTrustScores(enrichedCalls);

		// Save results
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(
			path.join(outputDir, "enriched_calls.json"),
			JSON.stringify(enrichedCalls, null, 2),
		);
		await fs.writeFile(
			path.join(outputDir, "trust_scores.json"),
			JSON.stringify(trustScores, null, 2),
		);

		return { enrichedCalls, trustScores };
	}
}

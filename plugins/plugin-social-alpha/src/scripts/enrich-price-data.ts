#!/usr/bin/env node

/**
 * Enrich Price Data
 *
 * This script enriches trading calls with historical price data:
 * 1. Load trading calls from batches
 * 2. Resolve token addresses
 * 3. Fetch historical price data
 * 4. Calculate profit/loss metrics
 * 5. Save enriched data
 *
 * Usage:
 *   npm run enrich-price-data [--input <dir>] [--output <dir>] [--batch-size <number>] [--resume]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import * as dotenv from "dotenv";
import { createServices } from "../services";

// Load environment variables
dotenv.config();

// Parse command line arguments
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		input: { type: "string", default: "./processed-data/batches" },
		output: { type: "string", default: "./enriched-data" },
		"batch-size": { type: "string", default: "100" },
		resume: { type: "boolean", default: false },
	},
});

const INPUT_DIR = values.input as string;
const OUTPUT_DIR = values.output as string;
const BATCH_SIZE = parseInt(values["batch-size"] as string, 10);
const RESUME = values.resume as boolean;

// Create a mock runtime for the price service
const mockRuntime: IAgentRuntime = {
	agentId: "price-enrichment" as any,
	getSetting: (key: string) => process.env[key],
	getCache: async () => null,
	setCache: async () => {},
	createMemory: async () => {},
	searchMemories: async () => [],
	getMemories: async () => [],
	useModel: async () => {},
	getComponent: async () => null,
	createComponent: async () => {},
	updateComponent: async () => {},
	deleteTask: async () => {},
	createTask: async () => {},
	registerTaskWorker: () => {},
	getEntityById: async () => null,
	ensureWorldExists: async () => {},
	ensureRoomExists: async () => {},
	getService: () => null,
};

interface TradingCall {
	id: string;
	userId: string;
	username: string;
	timestamp: number;
	content: string;
	tokenSymbol?: string;
	tokenAddress?: string;
	chain?: string;
	conviction?: string;
	metadata?: Record<string, any>;
}

interface EnrichedCall extends TradingCall {
	resolvedAddress?: string;
	priceData?: {
		callPrice: number;
		maxPrice: number;
		currentPrice: number;
		profit: number;
		profitPercent: number;
		priceHistory?: Array<{
			timestamp: number;
			price: number;
		}>;
	};
	enrichmentError?: string;
}

/**
 * Load progress state for resuming
 */
async function loadProgress(): Promise<Set<string>> {
	const progressFile = path.join(OUTPUT_DIR, ".progress.json");
	try {
		const content = await fs.readFile(progressFile, "utf-8");
		const progress = JSON.parse(content);
		return new Set(progress.processedBatches);
	} catch {
		return new Set();
	}
}

/**
 * Save progress state
 */
async function saveProgress(processedBatches: Set<string>): Promise<void> {
	const progressFile = path.join(OUTPUT_DIR, ".progress.json");
	await fs.writeFile(
		progressFile,
		JSON.stringify(
			{
				processedBatches: Array.from(processedBatches),
				lastUpdate: new Date().toISOString(),
			},
			null,
			2,
		),
	);
}

/**
 * Process a batch of trading calls
 */
async function processBatch(
	calls: TradingCall[],
	priceService: any,
	batchNumber: number,
): Promise<EnrichedCall[]> {
	const enrichedCalls: EnrichedCall[] = [];
	let processed = 0;

	for (const call of calls) {
		try {
			// Skip if no token info
			if (!call.tokenSymbol && !call.tokenAddress) {
				enrichedCalls.push({
					...call,
					enrichmentError: "No token information",
				});
				continue;
			}

			// Enrich the call
			const enrichedCall = await priceService.enrichCall(call);
			enrichedCalls.push(enrichedCall);

			processed++;
			if (processed % 10 === 0) {
				console.log(
					`   Processed ${processed}/${calls.length} calls in batch ${batchNumber}`,
				);
			}

			// Rate limiting
			await new Promise((resolve) => setTimeout(resolve, 100));
		} catch (error: any) {
			console.error(`   ⚠️  Error enriching call ${call.id}:`, error.message);
			enrichedCalls.push({
				...call,
				enrichmentError: error.message,
			});
		}
	}

	return enrichedCalls;
}

/**
 * Main enrichment function
 */
async function main() {
	try {
		console.log("🚀 Enriching Trading Calls with Price Data\n");
		console.log(`   Input: ${INPUT_DIR}`);
		console.log(`   Output: ${OUTPUT_DIR}`);
		console.log(`   Batch Size: ${BATCH_SIZE}`);
		console.log(`   Resume: ${RESUME}\n`);

		// Check API keys
		if (!process.env.BIRDEYE_API_KEY && !process.env.DEXSCREENER_API_KEY) {
			console.error(
				"❌ Error: No API keys found. Please set BIRDEYE_API_KEY or DEXSCREENER_API_KEY in .env",
			);
			process.exit(1);
		}

		// Create output directory
		await fs.mkdir(OUTPUT_DIR, { recursive: true });
		await fs.mkdir(path.join(OUTPUT_DIR, "batches"), { recursive: true });

		// Initialize services
		const services = createServices(mockRuntime);
		if (!services.priceData) {
			throw new Error("Failed to initialize price data service");
		}

		// Load batch files
		const batchFiles = await fs.readdir(INPUT_DIR);
		const jsonFiles = batchFiles
			.filter((f) => f.endsWith(".json"))
			.sort((a, b) => {
				const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
				const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
				return numA - numB;
			});

		console.log(`📁 Found ${jsonFiles.length} batch files to process\n`);

		// Load progress if resuming
		const processedBatches = RESUME ? await loadProgress() : new Set<string>();
		if (RESUME && processedBatches.size > 0) {
			console.log(
				`📌 Resuming from previous run. Already processed: ${processedBatches.size} batches\n`,
			);
		}

		let totalProcessed = 0;
		let totalErrors = 0;
		const allEnrichedCalls: EnrichedCall[] = [];

		// Process each batch
		for (const batchFile of jsonFiles) {
			if (processedBatches.has(batchFile)) {
				console.log(`⏭️  Skipping already processed batch: ${batchFile}`);
				continue;
			}

			console.log(`\n📦 Processing batch: ${batchFile}`);

			// Load batch
			const batchPath = path.join(INPUT_DIR, batchFile);
			const content = await fs.readFile(batchPath, "utf-8");
			const calls: TradingCall[] = JSON.parse(content);

			// Process calls
			const enrichedCalls = await processBatch(
				calls,
				services.priceData,
				parseInt(batchFile.match(/\d+/)?.[0] || "0", 10),
			);

			// Count successes and errors
			const successCount = enrichedCalls.filter((c) => c.priceData).length;
			const errorCount = enrichedCalls.filter((c) => c.enrichmentError).length;

			totalProcessed += successCount;
			totalErrors += errorCount;

			// Save enriched batch
			const outputPath = path.join(OUTPUT_DIR, "batches", batchFile);
			await fs.writeFile(outputPath, JSON.stringify(enrichedCalls, null, 2));

			// Add to all calls
			allEnrichedCalls.push(...enrichedCalls);

			// Update progress
			processedBatches.add(batchFile);
			await saveProgress(processedBatches);

			console.log(`   ✅ Enriched ${successCount} calls, ${errorCount} errors`);
		}

		// Save all enriched calls
		console.log("\n💾 Saving all enriched calls...");
		const allCallsPath = path.join(OUTPUT_DIR, "enriched_calls.json");
		await fs.writeFile(allCallsPath, JSON.stringify(allEnrichedCalls, null, 2));

		// Generate summary statistics
		const stats = {
			totalCalls: allEnrichedCalls.length,
			successfullyEnriched: totalProcessed,
			errors: totalErrors,
			enrichmentRate: `${((totalProcessed / allEnrichedCalls.length) * 100).toFixed(2)}%`,
			tokenDistribution: {} as Record<string, number>,
			profitDistribution: {
				profitable: 0,
				unprofitable: 0,
				breakeven: 0,
			},
			averageProfit: 0,
			topGainers: [] as any[],
			topLosers: [] as any[],
		};

		// Analyze enriched calls
		const callsWithPriceData = allEnrichedCalls.filter((c) => c.priceData);
		let totalProfit = 0;

		for (const call of callsWithPriceData) {
			// Token distribution
			if (call.tokenSymbol) {
				stats.tokenDistribution[call.tokenSymbol] =
					(stats.tokenDistribution[call.tokenSymbol] || 0) + 1;
			}

			// Profit distribution
			const profit = call.priceData?.profit ?? 0;
			if (profit > 0) stats.profitDistribution.profitable++;
			else if (profit < 0) stats.profitDistribution.unprofitable++;
			else stats.profitDistribution.breakeven++;

			totalProfit += profit;
		}

		stats.averageProfit =
			callsWithPriceData.length > 0
				? totalProfit / callsWithPriceData.length
				: 0;

		// Top gainers and losers
		const sortedByProfit = callsWithPriceData.sort(
			(a, b) => (b.priceData?.profit ?? 0) - (a.priceData?.profit ?? 0),
		);

		stats.topGainers = sortedByProfit.slice(0, 10).map((c) => ({
			username: c.username,
			tokenSymbol: c.tokenSymbol,
			profit: c.priceData?.profit,
			profitPercent: c.priceData?.profitPercent,
		}));

		stats.topLosers = sortedByProfit
			.slice(-10)
			.reverse()
			.map((c) => ({
				username: c.username,
				tokenSymbol: c.tokenSymbol,
				profit: c.priceData?.profit,
				profitPercent: c.priceData?.profitPercent,
			}));

		// Save statistics
		const statsPath = path.join(OUTPUT_DIR, "enrichment_stats.json");
		await fs.writeFile(statsPath, JSON.stringify(stats, null, 2));

		// Print summary
		console.log("\n📊 Enrichment Summary:");
		console.log(`   Total Calls: ${stats.totalCalls}`);
		console.log(
			`   Successfully Enriched: ${stats.successfullyEnriched} (${stats.enrichmentRate})`,
		);
		console.log(`   Errors: ${stats.errors}`);
		console.log(`   Average Profit: ${stats.averageProfit.toFixed(2)}%`);
		console.log(`   Profitable Calls: ${stats.profitDistribution.profitable}`);
		console.log(
			`   Unprofitable Calls: ${stats.profitDistribution.unprofitable}`,
		);

		// Clean up progress file if completed
		if (!RESUME || processedBatches.size === jsonFiles.length) {
			try {
				await fs.unlink(path.join(OUTPUT_DIR, ".progress.json"));
			} catch {}
		}

		console.log("\n✅ Enrichment complete!");
		console.log(`   Results saved to: ${OUTPUT_DIR}`);
	} catch (error) {
		console.error("❌ Error during enrichment:", error);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main();
}

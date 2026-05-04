#!/usr/bin/env node
/**
 * Process Discord Data
 *
 * This script processes Discord trading call data through the following steps:
 * 1. Load raw Discord data from JSON files
 * 2. Parse and validate trading calls
 * 3. Batch the data for processing
 * 4. Analyze the processed data
 *
 * Usage:
 *   npm run process-discord-data [--input <dir>] [--output <dir>] [--batch-size <number>]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { v4 as uuidv4 } from "uuid";

// Import types
interface DiscordMessage {
	id: string;
	content: string;
	author: {
		id: string;
		username: string;
	};
	timestamp: string;
	channel?: {
		id: string;
		name: string;
	};
}

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

// Parse command line arguments
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		input: { type: "string", default: "./discord-data" },
		output: { type: "string", default: "./processed-data" },
		"batch-size": { type: "string", default: "1000" },
	},
});

const INPUT_DIR = values.input as string;
const OUTPUT_DIR = values.output as string;
const BATCH_SIZE = parseInt(values["batch-size"] as string, 10);

/**
 * Extract trading calls from Discord messages
 */
function extractTradingCalls(messages: DiscordMessage[]): TradingCall[] {
	const calls: TradingCall[] = [];

	// Patterns for detecting trading calls
	const patterns = {
		tokenSymbol: /\$([A-Z]{2,10})/g,
		tokenAddress: /[1-9A-HJ-NP-Za-km-z]{32,44}/g,
		conviction: /(high|medium|low|moon|ape|degen)/gi,
		chain: /(solana|sol|ethereum|eth|base|arbitrum|arb)/gi,
	};

	for (const message of messages) {
		const content = message.content.toLowerCase();

		// Skip if not a trading call
		if (
			!content.includes("buy") &&
			!content.includes("long") &&
			!content.includes("bullish") &&
			!content.includes("moon") &&
			!content.includes("gem")
		) {
			continue;
		}

		// Extract token symbols
		const symbolMatches = message.content.match(patterns.tokenSymbol);
		const tokenSymbol = symbolMatches?.[0]?.replace("$", "");

		// Extract token addresses
		const addressMatches = message.content.match(patterns.tokenAddress);
		const tokenAddress = addressMatches?.[0];

		// Extract conviction
		const convictionMatches = content.match(patterns.conviction);
		const conviction = convictionMatches?.[0];

		// Extract chain
		const chainMatches = content.match(patterns.chain);
		const chain = chainMatches?.[0];

		// Create trading call
		const call: TradingCall = {
			id: uuidv4(),
			userId: message.author.id,
			username: message.author.username,
			timestamp: new Date(message.timestamp).getTime(),
			content: message.content,
			tokenSymbol,
			tokenAddress,
			chain,
			conviction,
			metadata: {
				channelId: message.channel?.id,
				channelName: message.channel?.name,
				originalMessageId: message.id,
			},
		};

		calls.push(call);
	}

	return calls;
}

/**
 * Batch trading calls for processing
 */
async function batchCalls(
	calls: TradingCall[],
	batchSize: number,
): Promise<void> {
	const batchDir = path.join(OUTPUT_DIR, "batches");
	await fs.mkdir(batchDir, { recursive: true });

	for (let i = 0; i < calls.length; i += batchSize) {
		const batch = calls.slice(i, i + batchSize);
		const batchNumber = Math.floor(i / batchSize) + 1;
		const batchFile = path.join(batchDir, `batch_${batchNumber}.json`);

		await fs.writeFile(batchFile, JSON.stringify(batch, null, 2));
		console.log(`✅ Created batch ${batchNumber} with ${batch.length} calls`);
	}
}

/**
 * Analyze processed data
 */
async function analyzeData(calls: TradingCall[]): Promise<void> {
	const analysis = {
		totalCalls: calls.length,
		uniqueUsers: new Set(calls.map((c) => c.userId)).size,
		timeRange: {
			start: new Date(Math.min(...calls.map((c) => c.timestamp))),
			end: new Date(Math.max(...calls.map((c) => c.timestamp))),
		},
		tokenDistribution: {} as Record<string, number>,
		chainDistribution: {} as Record<string, number>,
		convictionDistribution: {} as Record<string, number>,
		userActivity: {} as Record<string, number>,
		hourlyDistribution: new Array(24).fill(0),
		dailyDistribution: {} as Record<string, number>,
	};

	// Analyze each call
	for (const call of calls) {
		// Token distribution
		if (call.tokenSymbol) {
			analysis.tokenDistribution[call.tokenSymbol] =
				(analysis.tokenDistribution[call.tokenSymbol] || 0) + 1;
		}

		// Chain distribution
		if (call.chain) {
			analysis.chainDistribution[call.chain] =
				(analysis.chainDistribution[call.chain] || 0) + 1;
		}

		// Conviction distribution
		if (call.conviction) {
			analysis.convictionDistribution[call.conviction] =
				(analysis.convictionDistribution[call.conviction] || 0) + 1;
		}

		// User activity
		analysis.userActivity[call.username] =
			(analysis.userActivity[call.username] || 0) + 1;

		// Time distribution
		const date = new Date(call.timestamp);
		const hour = date.getHours();
		const day = date.toISOString().split("T")[0];

		analysis.hourlyDistribution[hour]++;
		analysis.dailyDistribution[day] =
			(analysis.dailyDistribution[day] || 0) + 1;
	}

	// Sort distributions
	analysis.tokenDistribution = Object.fromEntries(
		Object.entries(analysis.tokenDistribution)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 50), // Top 50 tokens
	);

	analysis.userActivity = Object.fromEntries(
		Object.entries(analysis.userActivity)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 100), // Top 100 users
	);

	// Save analysis
	const analysisFile = path.join(OUTPUT_DIR, "analysis.json");
	await fs.writeFile(analysisFile, JSON.stringify(analysis, null, 2));

	// Print summary
	console.log("\n📊 Data Analysis Summary:");
	console.log(`   Total Calls: ${analysis.totalCalls}`);
	console.log(`   Unique Users: ${analysis.uniqueUsers}`);
	console.log(
		`   Time Range: ${analysis.timeRange.start.toLocaleDateString()} - ${analysis.timeRange.end.toLocaleDateString()}`,
	);
	console.log(
		`   Top Tokens: ${Object.keys(analysis.tokenDistribution).slice(0, 5).join(", ")}`,
	);
	console.log(
		`   Most Active Users: ${Object.keys(analysis.userActivity).slice(0, 5).join(", ")}`,
	);
}

/**
 * Main processing function
 */
async function main() {
	try {
		console.log("🚀 Processing Discord Data\n");
		console.log(`   Input: ${INPUT_DIR}`);
		console.log(`   Output: ${OUTPUT_DIR}`);
		console.log(`   Batch Size: ${BATCH_SIZE}\n`);

		// Create output directory
		await fs.mkdir(OUTPUT_DIR, { recursive: true });

		// Load all JSON files from input directory
		const files = await fs.readdir(INPUT_DIR);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		console.log(`📁 Found ${jsonFiles.length} JSON files to process\n`);

		let allMessages: DiscordMessage[] = [];

		// Load messages from each file
		for (const file of jsonFiles) {
			const filePath = path.join(INPUT_DIR, file);
			const content = await fs.readFile(filePath, "utf-8");
			const data = JSON.parse(content);

			// Handle different data formats
			const messages = Array.isArray(data) ? data : data.messages || [];
			allMessages = allMessages.concat(messages);

			console.log(`   ✅ Loaded ${messages.length} messages from ${file}`);
		}

		console.log(`\n📝 Total messages loaded: ${allMessages.length}`);

		// Extract trading calls
		console.log("\n🔍 Extracting trading calls...");
		const tradingCalls = extractTradingCalls(allMessages);
		console.log(`   ✅ Extracted ${tradingCalls.length} trading calls`);

		// Save all calls
		const allCallsFile = path.join(OUTPUT_DIR, "all_calls.json");
		await fs.writeFile(allCallsFile, JSON.stringify(tradingCalls, null, 2));

		// Batch calls for processing
		console.log("\n📦 Creating batches...");
		await batchCalls(tradingCalls, BATCH_SIZE);

		// Analyze data
		console.log("\n📊 Analyzing data...");
		await analyzeData(tradingCalls);

		console.log("\n✅ Processing complete!");
		console.log(`   Output saved to: ${OUTPUT_DIR}`);
	} catch (error) {
		console.error("❌ Error processing data:", error);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main();
}

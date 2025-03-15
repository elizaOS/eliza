import { type IAgentRuntime, ModelType, logger } from "@elizaos/core";
import type { Sentiment } from "../schemas";
import type { IToken } from "../types";

const DEGEN_WALLET = "BzsJQeZ7cvk3pTHmKeuvdhNDkDxcZ6uCXxW2rjwC7RTq";
const _rolePrompt = "You are a buy signal analyzer.";
/**
 * Template for generating a crypto buy signal based on sentiment analysis and trending tokens.
 *
 * Sentiment analysis:
 * {{sentiment}}
 *
 * Trending tokens:
 * {{trending_tokens}}
 *
 * Only return the following JSON:
 * {
 *     recommended_buy: "the symbol of the token for example DEGENAI",
 *     recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
 *     reason: "the reason why you think this is a good buy, and why you chose the specific amount",
 *     buy_amount: "number, for example: 0.1"
 * }
 */
const _template = `

I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper token address.
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
My current balance is {{solana_balance}} SOL, also let me know what a good amount would be to buy. Buy amount should at least be 0.05 SOL and maximum 0.25 SOL.

Sentiment analysis:

{{sentiment}}

Trending tokens:

{{trending_tokens}}

Only return the following JSON:

{
recommended_buy: "the symbol of the token for example DEGENAI",
recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
reason: "the reason why you think this is a good buy, and why you chose the specific amount",
buy_amount: "number, for example: 0.1"
}`;

/**
 * Interface representing the output of a buy signal.
 * @typedef {object} IBuySignalOutput
 * @property {string} recommended_buy - The recommended buy action.
 * @property {string} recommend_buy_address - The recommended buy address.
 * @property {number} marketcap - The marketcap value.
 * @property {string} reason - The reason for the buy recommendation.
 * @property {string} buy_amount - The amount to buy.
 */
interface IBuySignalOutput {
	recommended_buy: string;
	recommend_buy_address: string;
	marketcap: number;
	reason: string;
	buy_amount: string;
}

export default class BuySignal {
	apiKey: string;
	runtime: IAgentRuntime;
	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
	}

	async generateSignal(): Promise<boolean> {
		logger.debug("Updating latest buy signal");
		/** Get all sentiments */
		const sentimentsData =
			(await this.runtime.getCache<Sentiment[]>("sentiments")) || [];
		let sentiments = "";

		let idx = 1;
		for (const sentiment of sentimentsData) {
			if (!sentiment?.occuringTokens?.length) continue;
			sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
			for (const token of sentiment.occuringTokens) {
				sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
			}

			sentiments += "\n-------------------\n";
			idx++;
		}

		/** Get all trending tokens */
		const trendingData =
			(await this.runtime.getCache<IToken[]>("tokens")) ||
			[];
		let tokens = "";
		let index = 1;
		for (const token of trendingData) {
			tokens += `ENTRY ${index}\n\nTOKEN SYMBOL: ${token.name}\nTOKEN ADDRESS: ${token.address}\nPRICE: ${token.price}\n24H CHANGE: ${token.price24hChangePercent}\nLIQUIDITY: ${token.liquidity}`;
			tokens += "\n-------------------\n";
			index++;
		}

		const solanaBalance = await this.getBalance();

		// Construct prompt with all the data
		const prompt = `
			Based on sentiment analysis and trending token data, recommend a Solana token to buy.
			
			SENTIMENT DATA:
			${sentiments}
			
			TRENDING TOKENS:
			${tokens}
			
			CURRENT SOLANA BALANCE: ${solanaBalance} SOL
			
			Respond with only a valid JSON object in this format:
			{
				"recommended_buy": "TOKEN_SYMBOL",
				"recommend_buy_address": "TOKEN_ADDRESS",
				"reason": "Detailed reason for the recommendation",
				"buy_amount": "Amount of SOL to buy (should be a number)"
			}
			`;

		// Use the runtime model service instead of direct API calls
		const responseText = await this.runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			system:
				"You are a token recommender bot for a trading bot. Only respond with valid JSON.",
			temperature: 0.2,
			maxTokens: 4096,
			object: true,
		});

		// Parse the JSON response
		const json = JSON.parse(responseText || "{}");
		if (!json.recommended_buy || !json.recommend_buy_address || !json.reason) {
			throw new Error("Invalid JSON from model");
		}

		/** Fetch the recommended buy's current marketcap */
		const options = {
			method: "GET",
			headers: {
				accept: "application/json",
				"x-chain": "solana",
				"X-API-KEY": this.runtime.getSetting("BIRDEYE_API_KEY"),
			},
		};

		const birdeyeResponse = await fetch(
			`https://public-api.birdeye.so/defi/token_overview?address=${json.recommend_buy_address}`,
			options,
		);
		if (!birdeyeResponse.ok)
			throw new Error("Birdeye marketcap request failed");

		const birdeyeData = await birdeyeResponse.json();
		const marketcap = birdeyeData?.data?.realMc;

		const data = {
			...json,
			marketcap: Number(marketcap),
		};

		// Store in cache
		await this.runtime.setCache<any>("buy_signals", {
			key: "BUY_SIGNAL",
			data,
		});

		// Create a buy task to execute the trade
		const { v4: uuidv4 } = require("uuid");
		const { ServiceType } = require("../../degen-trader/types");

		await this.runtime.createTask({
			id: uuidv4(),
			roomId: this.runtime.agentId,
			name: "EXECUTE_BUY_SIGNAL",
			description: `Buy token ${data.recommended_buy} (${data.recommend_buy_address})`,
			tags: ["queue", ServiceType.DEGEN_TRADING],
			metadata: {
				signal: {
					positionId: uuidv4(),
					tokenAddress: data.recommend_buy_address,
					entityId: "default",
				},
				tradeAmount: Number(data.buy_amount) || 0.1,
				reason: data.reason,
				updatedAt: Date.now(),
			},
		});

		return true;
	}

	async getBalance() {
		const url = "https://zondra-wil7oz-fast-mainnet.helius-rpc.com";
		const headers = {
			"Content-Type": "application/json",
		};

		const data = {
			jsonrpc: "2.0",
			id: 1,
			method: "getBalance",
			params: [DEGEN_WALLET],
		};
		const response = await fetch(url, {
			method: "POST",
			headers: headers,
			body: JSON.stringify(data),
		});

		const result = await response.json();

		const lamportsBalance = result?.result?.value;

		return lamportsBalance / 1000000000;
	}
}

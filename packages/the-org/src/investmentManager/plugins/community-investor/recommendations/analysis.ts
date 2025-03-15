import {
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
	composePrompt,
	logger,
} from "@elizaos/core";
import type { CommunityInvestorService } from "../tradingService.js";
import { ServiceType } from "../types.js";
import {
	extractXMLFromResponse,
	parseConfirmationResponse,
	parseTokenResponse,
} from "../utils.js";

/**
 * Template for generating a message to present token details to the user.
 *
 * Message should follow specific guidelines:
 * - Should enclude engaging tagline at the beginning.
 * - Should include a report of the token.
 * - Should always include links to the token addresses and accounts.
 * - Should always end in a question asking the user if they want to confirm the token recommendation.
 * - Should use a few emojis to make the message more engaging.
 *
 * Restrictions:
 * - Message should NOT contain more than 5 emojis.
 * - Message should NOT be too long.
 *
 * Structure of the message:
 * - <ticker>{{ticker}}</ticker>
 * - <token_overview>{{tokenOverview}}</token_overview>
 *
 * When responding:
 * - MESSAGE: This is the message you will need to send to the user.
 *
 * Response Format:
 * - <message>
 * **MESSAGE_TEXT_HERE**
 * </message>
 */
const tokenDetailsTemplate = `You are a crypto expert.

You will be given a ticker and token overview.

Your goal is to write a message to the user presenting the token details in a engaing, easy to read format.

Each Message should include the following information:

- Should enclude engaging tagline at the beginning.
- Should include a report of the token.
- Should always include links to the token addresses and accounts:
    - Token: https://solscan.io/token/[tokenAddress]
    - Account: https://solscan.io/account/[accountAddress]
    - Tx: https://solscan.io/tx/[txHash]
    - Pair: https://www.defined.fi/sol/[pairAddress]
- Should always use valid markdown links when possible.
- Should Always end in a question asking the user if they want to confirm the token recommendation, can get creative with the this.
- Should use a few emojis to make the message more engaging.

The message should **NOT**:

- Contain more than 5 emojis.
- Be too long.

<ticker>
{{ticker}}
</ticker>

<token_overview>
{{tokenOverview}}
</token_overview>

# Response Instructions

When writing your response, follow these strict guidelines:

## Response Information

Respond with the following structure:

-MESSAGE: This is the message you will need to send to the user.

## Response Format

Respond with the following format:
<message>
**MESSAGE_TEXT_HERE**
</message>

## Response Example

<message>
Hello! Here are the details for Kolwaii (KWAII):

Token Overview:

- Name: Kolwaii
- Symbol: KWAII
- Chain: Solana
- Address: [6uVJY332tiYwo58g3B8p9FJRGmGZ2fUuXR8cpiaDpump](https://solscan.io/token/6uVJY332tiYwo58g3B8p9FJRGmGZ2fUuXR8cpiaDpump)
- Price: $0.01578
- Market Cap: $4,230,686
- 24h Trading Volume: $53,137,098.26
- Holders: 3,884
- Liquidity: $677,160.66
- 24h Price Change: +4.75%
- Total Supply: 999,998,189.02 KWAII

Top Trading Pairs:

1. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/ChiPAU1gj79o1tB4PXpB14v4DPuumtbzAkr3BnPbo1ru) - Price: $0.01578
2. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/HsnFjX8utMyLm7fVYphsr47nhhsqHsejP3JoUr3BUcYm) - Price: $0.01577
3. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/3czJZMWfobm5r3nUcxpZGE6hz5rKywegKCWKppaisM7n) - Price: $0.01523

Creator Information:

- Creator Address: [FTERkgMYziSVfcGEkZS55zYiLerZHWcMrjwt49aL9jBe](https://solscan.io/account/FTERkgMYziSVfcGEkZS55zYiLerZHWcMrjwt49aL9jBe)
- Creation Transaction: [View Transaction](https://solscan.io/tx/4PMbpyyQB9kPDKyeQaJGrMfmS2CnnHYp9nB5h4wiB2sDv7yHGoew4EgYgsaeGYTcuZPRpgKPKgrq4DLX4y8sX21y)

</message>

Now based on the user_message, recommendation, and token_overview, write your message.`;

/**
 * Function to extract the most recent ticker or token address mentioned from a list of messages.
 * The function analyzes messages containing <createdAt> and <content> fields, searching for specific token tickers or addresses.
 * The response should include the ticker and token address in the following format:
 *
 * <token>
 *    <ticker>__TICKER___</ticker>
 *    <tokenAddress>__TOKEN_ADDRESS___</tokenAddress>
 * </token>
 *
 * Strict instructions and examples are provided within the response guidelines for clarity.
 *
 * @param {string} messages - List of messages from the user containing <createdAt> and <content> fields
 * @returns {string} - The most recent ticker or token address mentioned from the user in the specified format
 */
const extractLatestTicketTemplate = `You are an expert crypto analyst and trader, that specializes in extracting tickers or token addresses from a group of messages.

You will be given a list of messages from a user each containing <createdAt> and <content> fields.

Your goal is to identify the most recent ticker or token address mentioned from the user.

Review the following messages:

<messages>
  {{messages}}
</messages>

# Instructions and Guidelines:

1. Carefully read through the messages, looking for messages from users that:

    - Mention specific token tickers or token addresses

# Response Instructions

When writing your response, follow these strict instructions and examples:

## Response Information

Respond with the following information:

- TOKEN: The most recent ticker or token address mentioned from the user
    - TICKER: The ticker of the token
    - TOKEN_ADDRESS: The token address of the token

## Response Format

Respond in the following format:

<token>
    <ticker>__TICKER___</ticker>
    <tokenAddress>__TOKEN_ADDRESS___</tokenAddress>
</token>

## Response Example

<token>
    <ticker>MOON</ticker>
    <tokenAddress></tokenAddress>
</token>

Now, based on the messages provided, please respond with the most recent ticker or token address mentioned from the user.`;

/**
 * Function to get detailed analysis of a token.
 *
 * @name GET_TOKEN_DETAILS
 * @description Gets the detailed analysis of a token
 * @example
 * [
 *     {
 *         name: "{{name1}}",
 *         content: {
 *             text: "Are you just looking for details, or are you recommending this token?",
 *         },
 *     },
 *     {
 *         name: "{{name2}}",
 *         content: {
 *             text: "I am just looking for details",
 *         },
 *     },
 *     {
 *         name: "{{name1}}",
 *         content: {
 *             text: "Ok, here are the details...",
 *             actions: ["GET_TOKEN_DETAILS"],
 *         },
 *     },
 * ]
 * @similes ["TOKEN_DETAILS"]
 *
 * @param {IAgentRuntime} runtime - The Agent Runtime
 * @param {Memory} message - The incoming message
 * @param {State} _state - The state of the conversation
 * @param _options - Additional options
 * @param {Function} callback - The callback function
 * @returns {boolean} - Returns true
 */
export const getTokenDetails: any = {
	name: "GET_TOKEN_DETAILS",
	description: "Gets the detailed analysis of a token",
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Are you just looking for details, or are you recommending this token?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "I am just looking for details",
				},
			},
			{
				name: "{{name1}}",
				content: {
					text: "Ok, here are the details...",
					actions: ["GET_TOKEN_DETAILS"],
				},
			},
		],
	],
	similes: ["TOKEN_DETAILS"],

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
		_options,
		callback: any,
	) {
		if (!runtime.getService(ServiceType.COMMUNITY_INVESTOR)) {
			console.log("no trading service");
			return;
		}

		const tradingService = runtime.getService<CommunityInvestorService>(
			ServiceType.COMMUNITY_INVESTOR,
		);

		if (!tradingService) {
			throw new Error("No trading service found");
		}

		// Get a users most recent message containing a token
		const rawMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			count: 10,
			unique: true,
		});

		if (!rawMessages.length) {
			logger.error(`No messages found for user ${message.entityId}`);
			return;
		}

		const messages = rawMessages
			.map((m) => {
				const content =
					typeof m.content === "string" ? JSON.parse(m.content) : m.content;
				return `
            <message>
                <createdAt>${new Date(m.createdAt as number).toISOString()}</createdAt>
                <content>${JSON.stringify(content.text)}</content>
            </message>`;
			})
			.join("\n");

		const prompt = composePrompt({
			state: {
				messages: messages,
			},
			template: extractLatestTicketTemplate,
		});

		const text = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
		});

		const extractXML = extractXMLFromResponse(text, "token");

		const results = parseTokenResponse(extractXML);

		if (!results.tokenAddress) {
			results.tokenAddress = await tradingService.resolveTicker(
				"solana", // todo: extract from recommendation?
				results.ticker,
			);
		}

		if (!results.tokenAddress) {
			logger.error(`No token address found for ${results.ticker}`);
			return;
		}

		const tokenOverview = await tradingService.getTokenOverview(
			"solana",
			results.tokenAddress,
		);

		const tokenOverviewString = JSON.stringify(tokenOverview, (_, v) => {
			if (typeof v === "bigint") return v.toString();
			return v;
		});

		const tokenDetailsPrompt = composePrompt({
			state: {
				ticker: results.ticker,
				tokenOverview: tokenOverviewString,
			},
			template: tokenDetailsTemplate,
		});

		const tokenDetails = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: tokenDetailsPrompt,
		});

		// Do we want to store memory here?
		const agentResponseMsg = extractXMLFromResponse(tokenDetails, "message");

		const finalResponse = parseConfirmationResponse(agentResponseMsg);
		if (callback) {
			const responseMemory: Memory = {
				content: {
					text: finalResponse,
					inReplyTo: message.id ? message.id : undefined,
					actions: ["GET_TOKEN_DETAILS"],
				},
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				metadata: message.metadata,
				createdAt: Date.now() * 1000,
			};
			await callback(responseMemory);
		}

		return true;
	},
	async validate(_, message) {
		if (message.agentId === message.entityId) return false;
		return true;
	},
};

import type { Action } from "@elizaos/core";
import {
	type ActionExample,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelClass,
	type State,
	elizaLogger,
	composeContext,
	generateObject,
	stringToUuid,
} from "@elizaos/core";
import { validateAbstractConfig } from "../environment";

import { erc20Abi, formatUnits, isAddress } from "viem";
import { z } from "zod";
import { ETH_ADDRESS } from "../constants";
import { useGetAccount } from "../hooks";
import {
	resolveAddress,
	getTokenByName,
	abstractPublicClient,
} from "../utils/viemHelpers";

const BalanceSchema = z.object({
	tokenAddress: z.string().optional().nullable(),
	walletAddress: z.string().optional().nullable(),
	tokenSymbol: z.string().optional().nullable(),
});

export interface BalanceContent extends Content {
	tokenAddress?: string;
	walletAddress?: string;
	tokenSymbol?: string;
}

const validatedSchema = z.object({
	tokenAddress: z
		.string()
		.refine(isAddress, { message: "Invalid token address" }),
	walletAddress: z
		.string()
		.refine(isAddress, { message: "Invalid token address" }),
});

const balanceTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.


Example response:
\`\`\`json
{
    "tokenAddress": "<TOKEN_ADDRESS>",
    "walletAddress": "<TOKEN_ADDRESS>",
    "tokenSymbol": "USDC"
}
\`\`\`

User message:
"{{currentMessage}}"

Given the message, extract the following information about the requested balance check:
- Token contract address (optional, if not specified set to null)
- Wallet address to check (optional, if not specified set to null)
- The symbol of the token to check (optional, if not specified set to null). Between 1 to 6 characters usually.

Respond with a JSON markdown block containing only the extracted values.`;

export const getBalanceAction: Action = {
	name: "GET_BALANCE",
	similes: [
		"CHECK_BALANCE",
		"VIEW_BALANCE",
		"SHOW_BALANCE",
		"BALANCE_CHECK",
		"TOKEN_BALANCE",
	],
	validate: async (runtime: IAgentRuntime, message: Memory) => {
		await validateAbstractConfig(runtime);
		return true;
	},
	description: "Check token balance for a given address",
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: { [key: string]: unknown },
		callback?: HandlerCallback,
	): Promise<boolean> => {
		elizaLogger.log("Starting Abstract GET_BALANCE handler...");

		// Initialize or update state
		if (!state) {
			state = (await runtime.composeState(message)) as State;
		} else {
			state = await runtime.updateRecentMessageState(state);
		}

		// Compose balance context
		state.currentMessage = `${state.recentMessagesData[1].content.text}`;
		const balanceContext = composeContext({
			state,
			template: balanceTemplate,
		});

		// Generate balance content
		const content = (
			await generateObject({
				runtime,
				context: balanceContext,
				modelClass: ModelClass.SMALL,
				schema: BalanceSchema,
			})
		).object as BalanceContent;

		try {
			const account = useGetAccount(runtime);
			const addressToCheck = content.walletAddress || account.address;

			// Resolve address
			const resolvedAddress = await resolveAddress(addressToCheck);
			if (!resolvedAddress) {
				throw new Error("Invalid address or ENS name");
			}

			let tokenAddress = content.tokenAddress;

			if (content.tokenSymbol) {
				const tokenMemory = await runtime.messageManager.getMemoryById(
					stringToUuid(`${content.tokenSymbol}-${runtime.agentId}`),
				);

				if (typeof tokenMemory?.content?.tokenAddress === "string") {
					tokenAddress = tokenMemory.content.tokenAddress;
				}

				if (!tokenAddress) {
					tokenAddress = getTokenByName(content.tokenSymbol)?.address;
				}
			}

			const result = validatedSchema.safeParse({
				tokenAddress: tokenAddress || ETH_ADDRESS,
				walletAddress: resolvedAddress,
			});

			// Validate transfer content
			if (!result.success) {
				elizaLogger.error("Invalid content for GET_BALANCE action.");
				if (callback) {
					callback({
						text: "Unable to process balance request. Invalid content provided.",
						content: { error: "Invalid balance content" },
					});
				}
				return false;
			}

			let balance: bigint;
			let symbol: string;
			let decimals: number;

			// Query balance based on token type
			if (result.data.tokenAddress === ETH_ADDRESS) {
				balance = await abstractPublicClient.getBalance({
					address: resolvedAddress,
				});
				symbol = "ETH";
				decimals = 18;
			} else {
				[balance, decimals, symbol] = await Promise.all([
					abstractPublicClient.readContract({
						address: result.data.tokenAddress,
						abi: erc20Abi,
						functionName: "balanceOf",
						args: [resolvedAddress],
					}),
					abstractPublicClient.readContract({
						address: result.data.tokenAddress,
						abi: erc20Abi,
						functionName: "decimals",
					}),
					abstractPublicClient.readContract({
						address: result.data.tokenAddress,
						abi: erc20Abi,
						functionName: "symbol",
					}),
				]);
			}

			const formattedBalance = formatUnits(balance, decimals);

			elizaLogger.success(`Balance check completed for ${resolvedAddress}`);
			if (callback) {
				callback({
					text: `Balance for ${resolvedAddress}: ${formattedBalance} ${symbol}`,
					content: { balance: formattedBalance, symbol: symbol },
				});
			}

			return true;
		} catch (error) {
			elizaLogger.error("Error checking balance:", error);
			if (callback) {
				callback({
					text: `Error checking balance: ${error.message}`,
					content: { error: error.message },
				});
			}
			return false;
		}
	},

	examples: [
		[
			{
				user: "{{user1}}",
				content: {
					text: "What's my ETH balance?",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Let me check your ETH balance.",
					action: "GET_BALANCE",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Your ETH balance is 1.5 ETH",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Check USDC balance for 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll check the USDC balance for that address.",
					action: "GET_BALANCE",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "The USDC balance for 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 is 100 USDC",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Check balance for 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 with token 0xe4c7fbb0a626ed208021ccaba6be1566905e2dfc",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Let me check the balance for that address.",
					action: "GET_BALANCE",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "The balance for 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62 with token 0xe4c7fbb0a626ed208021ccaba6be1566905e2dfc is 100",
				},
			},
		],
	] as ActionExample[][],
};

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

import { erc20Abi, formatUnits, isAddress, parseUnits, type Hash } from "viem";
import { abstractTestnet } from "viem/chains";
import { createAbstractClient } from "@abstract-foundation/agw-client";
import { z } from "zod";
import { ETH_ADDRESS } from "../constants";
import { useGetAccount, useGetWalletClient } from "../hooks";
import {
	resolveAddress,
	abstractPublicClient,
	getTokenByName,
} from "../utils/viemHelpers";

const TransferSchema = z.object({
	tokenAddress: z.string().optional().nullable(),
	recipient: z.string(),
	amount: z.string(),
	useAGW: z.boolean(),
	tokenSymbol: z.string().optional().nullable(),
});

const validatedTransferSchema = z.object({
	tokenAddress: z
		.string()
		.refine(isAddress, { message: "Invalid token address" }),
	recipient: z
		.string()
		.refine(isAddress, { message: "Invalid recipient address" }),
	amount: z.string(),
	useAGW: z.boolean(),
});

export interface TransferContent extends Content {
	tokenAddress: string;
	recipient: string;
	amount: string | number;
	useAGW: boolean;
	tokenSymbol?: string;
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "tokenAddress": "<TOKEN_ADDRESS>",
    "recipient": "<TOKEN_ADDRESS>",
    "amount": "1000",
    "useAGW": true,
    "tokenSymbol": "USDC"
}
\`\`\`

User message:
"{{currentMessage}}"

Given the message, extract the following information about the requested token transfer:
- Token contract address
- Recipient wallet address
- Amount to transfer
- Whether to use Abstract Global Wallet aka AGW
- The symbol of the token that wants to be transferred. Between 1 to 6 characters usually.

If the user did not specify "global wallet", "AGW", "agw", or "abstract global wallet" in their message, set useAGW to false, otherwise set it to true.
s
Respond with a JSON markdown block containing only the extracted values.`;

export const transferAction: Action = {

	name: "SEND_TOKEN",
	similes: [
		"TRANSFER_TOKEN_ON_ABSTRACT",
		"TRANSFER_TOKENS_ON_ABSTRACT",
		"SEND_TOKENS_ON_ABSTRACT",
		"SEND_ETH_ON_ABSTRACT",
		"PAY_ON_ABSTRACT",
		"MOVE_TOKENS_ON_ABSTRACT",
		"MOVE_ETH_ON_ABSTRACT",
	],
	// eslint-disable-next-line
	validate: async (runtime: IAgentRuntime) => {
		await validateAbstractConfig(runtime);
		return true;
	},
	description: "Transfer tokens from the agent's wallet to another address",
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: { [key: string]: unknown },
		callback?: HandlerCallback,
	): Promise<boolean> => {
		elizaLogger.log("Starting Abstract SEND_TOKEN handler...");

		// Initialize or update state
		if (!state) {
			state = (await runtime.composeState(message)) as State;
		} else {
			state = await runtime.updateRecentMessageState(state);
		}

		// Compose transfer context
		state.currentMessage = `${state.recentMessagesData[1].content.text}`;
		const transferContext = composeContext({
			state,
			template: transferTemplate,
		});

		// Generate transfer content
		const content = (
			await generateObject({
				runtime,
				context: transferContext,
				modelClass: ModelClass.SMALL,
				schema: TransferSchema,
			})
		).object as TransferContent;

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

		const resolvedRecipient = await resolveAddress(content.recipient);

		const input = {
			tokenAddress: tokenAddress,
			recipient: resolvedRecipient,
			amount: content.amount.toString(),
			useAGW: content.useAGW,
		};
		const result = validatedTransferSchema.safeParse(input);

		if (!result.success) {
			elizaLogger.error(
				"Invalid content for TRANSFER_TOKEN action.",
				result.error.message,
			);
			if (callback) {
				callback({
					text: "Unable to process transfer request. Did not extract valid parameters.",
					content: { error: result.error.message, ...input },
				});
			}
			return false;
		}

		if (!resolvedRecipient) {
			throw new Error("Invalid recipient address or ENS name");
		}

		try {
			const account = useGetAccount(runtime);

			let symbol = "ETH";
			let decimals = 18;
			const isEthTransfer = result.data.tokenAddress === ETH_ADDRESS;
			const { tokenAddress, recipient, amount, useAGW } = result.data;

			if (!isEthTransfer) {
				[symbol, decimals] = await Promise.all([
					abstractPublicClient.readContract({
						address: tokenAddress,
						abi: erc20Abi,
						functionName: "symbol",
					}),
					abstractPublicClient.readContract({
						address: tokenAddress,
						abi: erc20Abi,
						functionName: "decimals",
					}),
				]);
			}
			let hash: Hash;
			const tokenAmount = parseUnits(amount.toString(), decimals);

			if (useAGW) {
				const abstractClient = (await createAbstractClient({
					chain: abstractTestnet,
					signer: account,
				})) as any; // biome-ignore lint/suspicious/noExplicitAny: type being exported as never

				if (isEthTransfer) {
					hash = await abstractClient.sendTransaction({
						chain: abstractTestnet,
						to: recipient,
						value: tokenAmount,
						kzg: undefined,
					});
				} else {
					hash = await abstractClient.writeContract({
						chain: abstractTestnet,
						address: tokenAddress,
						abi: erc20Abi,
						functionName: "transfer",
						args: [recipient, tokenAmount],
					});
				}
			} else {
				const walletClient = useGetWalletClient();
				if (isEthTransfer) {
					hash = await walletClient.sendTransaction({
						account,
						chain: abstractTestnet,
						to: recipient,
						value: tokenAmount,
						kzg: undefined,
					});
				} else {
					hash = await walletClient.writeContract({
						account,
						chain: abstractTestnet,
						address: tokenAddress,
						abi: erc20Abi,
						functionName: "transfer",
						args: [recipient, tokenAmount],
					});
				}
			}

			elizaLogger.success(
				`Transfer completed successfully! Transaction hash: ${hash}`,
			);
			if (callback) {
				callback({
					text: `Transfer completed successfully! Succesfully sent ${formatUnits(tokenAmount, decimals)} ${symbol} to ${recipient} using ${useAGW ? "AGW" : "wallet client"}. Transaction hash: ${hash}`,
					content: {
						hash,
						tokenAmount: formatUnits(tokenAmount, decimals),
						symbol,
						recipient,
						useAGW,
					},
				});
			}

			return true;
		} catch (error) {
			elizaLogger.error("Error during token transfer:", error);
			if (callback) {
				callback({
					text: `Error transferring tokens: ${error.message}`,
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
					text: "Send 0.01 ETH to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Sure, I'll send 0.01 ETH to that address now.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 0.01 ETH to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4\nTransaction: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Send 0.01 ETH to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4 using your abstract global wallet",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Sure, I'll send 0.01 ETH to that address now using my AGW.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 0.01 ETH to 0x114B242D931B47D5cDcEe7AF065856f70ee278C4\nTransaction: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b using my AGW",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Send 0.01 ETH to alim.getclave.eth",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Sure, I'll send 0.01 ETH to alim.getclave.eth now.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 0.01 ETH to alim.getclave.eth\nTransaction: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Send 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Sure, I'll send 100 USDC to that address now.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 100 USDC to 0xCCa8009f5e09F8C5dB63cb0031052F9CB635Af62\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Please send 0.1 ETH to 0xbD8679cf79137042214fA4239b02F4022208EE82",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Of course. Sending 0.1 ETH to that address now.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 0.1 ETH to 0xbD8679cf79137042214fA4239b02F4022208EE82\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Please send 1 MyToken to 0xbD8679cf79137042214fA4239b02F4022208EE82",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Of course. Sending 1 MyToken right away.",
					action: "SEND_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully sent 1 MyToken to 0xbD8679cf79137042214fA4239b02F4022208EE82\nTransaction: 0x0b9f23e69ea91ba98926744472717960cc7018d35bc3165bdba6ae41670da0f0",
				},
			},
		],
	] as ActionExample[][],
};

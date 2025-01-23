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
import { parseEther, type Hash } from "viem";
import { abstractTestnet } from "viem/chains";
import {
	type AbstractClient,
	createAbstractClient,
} from "@abstract-foundation/agw-client";
import { z } from "zod";
import { useGetAccount, useGetWalletClient } from "../hooks";
import basicToken from "../constants/contracts/basicToken.json";
import { abstractPublicClient } from "../utils/viemHelpers";

const DeploySchema = z.object({
	name: z.string(),
	symbol: z.string(),
	initialSupply: z.string(),
	useAGW: z.boolean(),
});

const validatedSchema = z.object({
	name: z.string().min(1, "Name is required"),
	symbol: z
		.string()
		.min(1, "Symbol is required")
		.max(5, "Symbol must be 5 characters or less"),
	initialSupply: z
		.string()
		.refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, {
			message: "Initial supply must be a positive number",
		}),
	useAGW: z.boolean(),
});

export interface DeployContent extends Content {
	name: string;
	symbol: string;
	initialSupply: string;
	useAGW: boolean;
}

const deployTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "name": "My Token",
    "symbol": "MTK",
    "initialSupply": "1000000",
    "useAGW": true
}
\`\`\`

User message:
"{{currentMessage}}"

Given the message, extract the following information about the requested token deployment:
- Token name
- Token symbol (usually 3-4 characters)
- Initial supply amount
- Whether to use Abstract Global Wallet aka AGW

If the user did not specify "global wallet", "AGW", "agw", or "abstract global wallet" in their message, set useAGW to false, otherwise set it to true.

Respond with a JSON markdown block containing only the extracted values.`;

export const deployTokenAction: Action = {
	name: "DEPLOY_TOKEN",
	similes: [
		"CREATE_TOKEN",
		"DEPLOY_NEW_TOKEN",
		"CREATE_NEW_TOKEN",
		"LAUNCH_TOKEN",
	],
	validate: async (runtime: IAgentRuntime) => {
		await validateAbstractConfig(runtime);
		return true;
	},
	description: "Deploy a new ERC20 token contract",
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: { [key: string]: unknown },
		callback?: HandlerCallback,
	): Promise<boolean> => {
		elizaLogger.log("Starting Abstract DEPLOY_TOKEN handler...");

		if (!state) {
			state = (await runtime.composeState(message)) as State;
		} else {
			state = await runtime.updateRecentMessageState(state);
		}

		state.currentMessage = `${state.recentMessagesData[1].content.text}`;
		const deployContext = composeContext({
			state,
			template: deployTemplate,
		});

		const content = (
			await generateObject({
				runtime,
				context: deployContext,
				modelClass: ModelClass.SMALL,
				schema: DeploySchema,
			})
		).object as DeployContent;

		// Validate deployment content
		const result = validatedSchema.safeParse(content);
		if (!result.success) {
			elizaLogger.error("Invalid content for DEPLOY_TOKEN action.", {
				errors: result.error.errors,
			});
			if (callback) {
				callback({
					text: "Unable to process token deployment request. Invalid parameters provided.",
					content: { error: "Invalid deployment parameters" },
				});
			}
			return false;
		}

		try {
			const account = useGetAccount(runtime);
			const supply = parseEther(content.initialSupply);
			let hash: Hash;

			if (content.useAGW) {
				const abstractClient = (await createAbstractClient({
					chain: abstractTestnet,
					signer: account,
				})) as any; // type being exported as never

				hash = await abstractClient.deployContract({
					abi: basicToken.abi,
					bytecode: basicToken.bytecode,
					args: [result.data.name, result.data.symbol, supply],
				});
			} else {
				const walletClient = useGetWalletClient();

				hash = await walletClient.deployContract({
					chain: abstractTestnet,
					account,
					abi: basicToken.abi,
					bytecode: basicToken.bytecode,
					args: [result.data.name, result.data.symbol, supply],
					kzg: undefined,
				});
			}

			// Wait for transaction receipt
			const receipt = await abstractPublicClient.waitForTransactionReceipt({
				hash,
			});
			const contractAddress = receipt.contractAddress;

			elizaLogger.success(
				`Token deployment completed! Contract address: ${contractAddress}. Transaction hash: ${hash}`,
			);
			if (callback) {
				callback({
					text: `Token "${result.data.name}" (${result.data.symbol}) deployed successfully! Contract address: ${contractAddress} and transaction hash: ${hash}`,
					content: {
						hash,
						tokenName: result.data.name,
						tokenSymbol: result.data.symbol,
						contractAddress,
						transactionHash: hash,
					},
				});
			}

			const metadata = {
				tokenAddress: contractAddress,
				name: result.data.name,
				symbol: result.data.symbol,
				initialSupply: String(result.data.initialSupply),
			};

			await runtime.messageManager.createMemory({
				id: stringToUuid(`${result.data.symbol}-${runtime.agentId}`),
				userId: runtime.agentId,
				content: {
					text: `Token deployed: ${result.data.name}, symbol: ${result.data.symbol} and contract address: ${contractAddress}`,
					...metadata,
					source: "abstract_token_deployment",
				},
				agentId: runtime.agentId,
				roomId: stringToUuid(`tokens-${runtime.agentId}`),
				createdAt: Date.now(),
			});
			elizaLogger.success("memory saved for token deployment", metadata);

			return true;
		} catch (error) {
			elizaLogger.error("Error during token deployment:", error);
			if (callback) {
				callback({
					text: `Error deploying token: ${error.message}`,
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
					text: "Deploy a new token called MyToken with symbol MTK and initial supply of 1000000",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll deploy your new token now.",
					action: "DEPLOY_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully deployed MyToken (MTK) with 1000000 initial supply.\nContract address: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b\nTransaction hash: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b",
				},
			},
		],
		[
			{
				user: "{{user1}}",
				content: {
					text: "Create a new token using AGW with name TestCoin, symbol TEST, and 5000 supply",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "I'll deploy your token using the Abstract Global Wallet.",
					action: "DEPLOY_TOKEN",
				},
			},
			{
				user: "{{agent}}",
				content: {
					text: "Successfully deployed TestCoin (TEST) with 5000 initial supply using AGW.\nContract address: 0xdde850f9257365fffffc11324726ebdcf5b90b01c6eec9b3e7ab3e81fde6f14b\nTransaction: 0x4fed598033f0added272c3ddefd4d83a521634a738474400b27378db462a76ec",
				},
			},
		],
	] as ActionExample[][],
};

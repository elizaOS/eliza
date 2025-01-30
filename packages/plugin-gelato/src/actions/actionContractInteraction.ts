import * as viemChains from "viem/chains"; // Import all predefined chains from Viem
import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    elizaLogger,
} from "@elizaos/core";
import { executeSponsoredCall, executeSponsoredCallERC2771 } from "../utils";
import { WalletProvider, initWalletProvider } from "../providers/wallet";
import { AbiFunction, parseAbi } from "viem";
import type { Chain } from "viem";
import {
    ContractInteractionSchema,
    ContractInteractionInput,
} from "../schemas";
import { WalletClient } from "viem";

// Class for managing contract interactions
export class ContractInteractionAction {
    async interactWithContract(
        abi: AbiFunction[],
        functionName: string,
        args: any[],
        target: string,
        chain: string,
        publicClient: any,
        walletClient?: any,
        user?: `0x${string}`
    ): Promise<any> {
        elizaLogger.info(`Interacting with contract at ${target} on ${chain}`);

        if (user && walletClient) {
            // Execute ERC2771 call
            return executeSponsoredCallERC2771(
                walletClient,
                abi,
                functionName,
                args,
                target,
                user
            );
        }
        
        // Execute standard sponsored call
        return executeSponsoredCall(
            publicClient,
            abi,
            functionName,
            args,
            target
        );
    }
}

// Action Definition
export const contractInteractionAction: Action = {
    name: "CONTRACT_INTERACTION",
    description:
        "Interact with a smart contract function on any EVM-compatible chain using Gelato Relay. Supports both standard and ERC2771 calls.",
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
        const apiKey = runtime.getSetting("GELATO_RELAY_API_KEY");
        if (!apiKey) {
            throw new Error("GELATO_RELAY_API_KEY is not configured.");
        }
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: unknown,
        callback?: HandlerCallback
    ) => {
        try {
            // Function to parse natural language prompt
            const parsePrompt = (
                input: string
            ): ContractInteractionInput & { user?: string } => {
                const abiRegex = /ABI:\s*\[(.*?)\]/s;
                const functionNameRegex = /Function Name:\s*([\w]+)/;
                const targetRegex = /Target:\s*(0x[a-fA-F0-9]{40})/;
                const chainRegex = /Chain:\s*([\w]+)/;
                const argsRegex = /Args:\s*\[(.*?)\]/s;
                const userRegex = /User:\s*(0x[a-fA-F0-9]{40})/;

                const abiMatch = input.match(abiRegex);
                const functionNameMatch = input.match(functionNameRegex);
                const targetMatch = input.match(targetRegex);
                const chainMatch = input.match(chainRegex);
                const argsMatch = input.match(argsRegex);
                const userMatch = input.match(userRegex);

                if (
                    !abiMatch ||
                    !functionNameMatch ||
                    !targetMatch ||
                    !chainMatch
                ) {
                    throw new Error(
                        "Failed to parse input. Please provide all required fields: ABI, Function Name, Target, and Chain."
                    );
                }

                const supportedChains = [
                    "mainnet",
                    "sepolia",
                    "goerli",
                    "polygon",
                    "arbitrum",
                    "optimism",
                    "arbitrumSepolia",
                ] as const;

                const chain = chainMatch[1] as string;

                if (!supportedChains.includes(chain as (typeof supportedChains)[number])) {
                    throw new Error(
                        `Invalid chain: ${chain}. Supported chains are ${supportedChains.join(
                            ", "
                        )}.`
                    );
                }

                return {
                    abi: JSON.parse(`[${abiMatch[1]}]`), // Parse ABI as an array
                    functionName: functionNameMatch[1],
                    target: targetMatch[1],
                    chain: chain as ContractInteractionInput["chain"], // Assert the type
                    args: argsMatch ? JSON.parse(`[${argsMatch[1]}]`) : [], // Parse Args as an array
                    user: userMatch ? userMatch[1] : undefined, // Optional user for ERC2771
                };
            };

            // Parse the prompt from message.content.text
            const prompt = message.content.text; // Assuming the input prompt is in text format
            const parsedContent = parsePrompt(prompt);

            // Validate parsed content with Zod schema
            const validatedContent =
                ContractInteractionSchema.parse(parsedContent);

            // Parse ABI
            const parsedAbi = parseAbi(validatedContent.abi) as AbiFunction[];

            elizaLogger.info(`Function: ${validatedContent.functionName}`);
            elizaLogger.info(`Target: ${validatedContent.target}`);
            elizaLogger.info(`Chain: ${validatedContent.chain}`);
            elizaLogger.info(`Parsed ABI: ${JSON.stringify(parsedAbi)}`);
            if (parsedContent.user) {
                elizaLogger.info(`User: ${parsedContent.user}`);
            }

            // Initialize Wallet Provider
            const walletProvider = await initWalletProvider(runtime);
            const publicClient = walletProvider.getPublicClient(
                validatedContent.chain
            );

            let walletClient: WalletClient | undefined;
            if (parsedContent.user) {
                walletClient = walletProvider.getWalletClient(
                    validatedContent.chain
                );
            }

            // Create an instance of the action class
            const action = new ContractInteractionAction();

            // Interact with the contract
            const response = await action.interactWithContract(
                parsedAbi,
                validatedContent.functionName,
                validatedContent.args || [],
                validatedContent.target,
                validatedContent.chain,
                publicClient,
                walletClient,
                parsedContent.user as `0x${string}`
            );

            // Format response
            const taskLink = `https://relay.gelato.digital/tasks/status/${response.taskId}`;
            const result = `✅ Contract interaction successful!
    - Function: ${validatedContent.functionName}
    - Target: ${validatedContent.target}
    - Chain: ${validatedContent.chain}
    - Task ID: ${response.taskId}
    - Track Status: [View Task](${taskLink})`;

            elizaLogger.success(result);

            if (callback) {
                callback({
                    text: result,
                    content: {
                        success: true,
                        taskId: response.taskId,
                        taskLink,
                        target: validatedContent.target,
                        chain: validatedContent.chain,
                    },
                });
            }

            return result;
        } catch (error) {
            const errorMessage = `❌ Error in contract interaction: ${
                error instanceof Error ? error.message : "Unknown error"
            }`;
            elizaLogger.error(errorMessage);

            if (callback) {
                callback({
                    text: errorMessage,
                    content: { error: errorMessage },
                });
            }

            return errorMessage;
        }
    },
    examples: [
        // Non-ERC2771 example
        [
            {
                user: "User",
                content: {
                    text: "Call increment() on contract 0x1234567890abcdef1234567890abcdef12345678 on Sepolia.",
                    functionName: "increment",
                    args: [],
                    target: "0x1234567890abcdef1234567890abcdef12345678",
                    chain: "sepolia",
                    abi: ["function increment()"],
                },
            },
            {
                user: "Eliza",
                content: {
                    text: "✅ Contract interaction successful! Task ID: abc123",
                },
            },
        ],
        // ERC2771 example
        [
            {
                user: "User",
                content: {
                    text: "Call increment() on contract 0x1234567890abcdef1234567890abcdef12345678 on Sepolia.\nUser: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                    functionName: "increment",
                    args: [],
                    target: "0x1234567890abcdef1234567890abcdef12345678",
                    chain: "sepolia",
                    abi: ["function increment()"],
                    user: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                },
            },
            {
                user: "Eliza",
                content: {
                    text: "✅ Contract interaction successful! Task ID: xyz456",
                },
            },
        ],
        // Example with additional arguments (non-ERC2771)
        [
            {
                user: "User",
                content: {
                    text: "Call setValue(42) on contract 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef on Polygon.",
                    functionName: "setValue",
                    args: [42],
                    target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                    chain: "polygon",
                    abi: ["function setValue(uint256 value)"],
                },
            },
            {
                user: "Eliza",
                content: {
                    text: "✅ Contract interaction successful! Task ID: def789",
                },
            },
        ],
        // Example with additional arguments (ERC2771)
        [
            {
                user: "User",
                content: {
                    text: "Call transfer(0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef, 1000) on contract 0x1234567890abcdef1234567890abcdef12345678 on Arbitrum.\nUser: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                    functionName: "transfer",
                    args: [
                        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                        1000,
                    ],
                    target: "0x1234567890abcdef1234567890abcdef12345678",
                    chain: "arbitrum",
                    abi: [
                        "function transfer(address recipient, uint256 amount)",
                    ],
                    user: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
                },
            },
            {
                user: "Eliza",
                content: {
                    text: "✅ Contract interaction successful! Task ID: ghi012",
                },
            },
        ],
    ],
    similes: [
        "CALL_SMART_CONTRACT",
        "INTERACT_CONTRACT",
        "GASLESS_CALL",
        "SPONSORED_CALL",
        "ERC2771_CALL",
        "TRUSTED_FORWARDED_CALL",
        "CHAIN_INTERACTION",
        "CONTRACT_EXECUTION",
    ],
};

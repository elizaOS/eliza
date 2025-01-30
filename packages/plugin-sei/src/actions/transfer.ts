import { ByteArray, formatEther, parseEther, type Hex } from "viem";
import {
    elizaLogger,
    Action,
    composeContext,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";

import { initWalletProvider, WalletProvider } from "../providers/wallet";
import { ADDRESS_PRECOMPILE_ABI, ADDRESS_PRECOMPILE_ADDRESS, type Transaction, type TransferParams } from "../types";

export const transferTemplate = `You are an AI assistant specialized in processing cryptocurrency transfer requests. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the requested transfer:
1. Amount to transfer in SEI
2. Recipient address

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part mentioning the amount.
   - Quote the part mentioning the recipient address.

2. Validate each piece of information:
   - Amount: Attempt to convert the amount to a number to verify it's valid.
   - Address: Check that it either starts with "0x" or "sei1", and ensure that the address contains 42 characters,
   - Chain: Check that the chain is either mainnet, testnet, devnet or

3. If any information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

5. Prepare the JSON structure based on your analysis.

After your analysis, provide the final output in a JSON markdown block. All fields except 'token' are required. The JSON should have this structure:
\`\`\`json
{
    "amount": string,
    "toAddress": string,
}
\`\`\`

Remember:
- The amount should be a string representing the SEI amount without any currency symbol.
- The recipient address must be a valid Ethereum address starting with "0x" or a vald SEI address startng with "sei1".

Now, process the user's request and provide your response.
`;

// Exported for tests
export class TransferAction {
    constructor(private walletProvider: WalletProvider) {}

    async transfer(params: TransferParams): Promise<Transaction> {
        const chain = this.walletProvider.getCurrentChain()
        elizaLogger.log(
            `Transferring: ${params.amount} tokens to (${params.toAddress} on ${chain.name})`
        );
        // let recipientAddress
        let recipientAddress: `0x${string}`; // Ensure it's a valid Ethereum address

        if (params.toAddress.startsWith("sei")) {
            const publicClient = this.walletProvider.getEvmPublicClient();
            const evmAddress = await publicClient.readContract({
                address: ADDRESS_PRECOMPILE_ADDRESS,
                abi: ADDRESS_PRECOMPILE_ABI,
                functionName: 'getEvmAddr',
                args: [params.toAddress],
            });

            if (!evmAddress || !evmAddress.startsWith("0x")) {
                throw new Error(`ERROR: Recipient does not have valid EVM address. Got: ${evmAddress}`);
            }

            elizaLogger.log(`Translated address ${params.toAddress} to EVM address ${evmAddress}`);
            recipientAddress = evmAddress as `0x${string}`; // Ensure it's a valid Ethereum address
        } else {
            if (!params.toAddress.startsWith("0x")) {
                throw new Error(`ERROR: Recipient address must start with '0x'. Got: ${params.toAddress}`);
            }
            recipientAddress = params.toAddress as `0x${string}`; // Ensure it's a valid Ethereum address
        }

        const walletClient = this.walletProvider.getEvmWalletClient();
        if (!walletClient.account) {
            throw new Error("Wallet client account is undefined");
        }

        try {
            const hash = await walletClient.sendTransaction({
                account: walletClient.account,
                to: recipientAddress,
                value: parseEther(params.amount),
                data: params.data as Hex,

                kzg: {
                    blobToKzgCommitment: (_: ByteArray): ByteArray => {
                        throw new Error("Function not implemented.");
                    },
                    computeBlobKzgProof: (
                        _blob: ByteArray,
                        _commitment: ByteArray
                    ): ByteArray => {
                        throw new Error("Function not implemented.");
                    },
                },
                maxFeePerBlobGas: BigInt(0), // Add required property
                blobs: [], // Add required property
                chain: undefined,
            });
                // kzg: {
                //     blobToKzgCommitment: function (_: ByteArray): ByteArray {
                //         throw new Error("Function not implemented.");
                //     },
                //     computeBlobKzgProof: function (
                //         _blob: ByteArray,
                //         _commitment: ByteArray
                //     ): ByteArray {
                //         throw new Error("Function not implemented.");
                //     },
                // },


            return {
                hash,
                from: walletClient.account.address, // Now guaranteed to be defined
                to: params.toAddress,
                value: parseEther(params.amount),
                data: params.data as Hex,
            };

        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

const buildTransferDetails = async (
    state: State,
    runtime: IAgentRuntime,
    _wp: WalletProvider
): Promise<TransferParams> => {
    const context = composeContext({
        state,
        template: transferTemplate,
    });

    const transferDetails = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as TransferParams;

    return transferDetails;
};

export const transferAction: Action = {
    name: "transfer",
    description: "Transfer tokens between addresses on the same chain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>, // Replace `any` with a safer type
        callback?: HandlerCallback
    ) => {
        
        // Create a new variable to avoid reassigning the parameter
        let updatedState = state;
        
        if (!updatedState) {
            updatedState = (await runtime.composeState(message)) as State;
        } else {
            updatedState = await runtime.updateRecentMessageState(updatedState);
        }

        elizaLogger.debug("Transfer action handler called");
        const walletProvider = await initWalletProvider(runtime);
        const action = new TransferAction(walletProvider);

        // Compose transfer context
        const paramOptions = await buildTransferDetails(
            updatedState, // Use the new variable
            runtime,
            walletProvider
        );
        
        // // Compose transfer context
        // const paramOptions = await buildTransferDetails(
        //     state,
        //     runtime,
        //     walletProvider
        // );

        try {
            const transferResp = await action.transfer(paramOptions);
            if (callback) {
                callback({
                    text: `Successfully transferred ${paramOptions.amount} tokens to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.hash}`,
                    content: {
                        success: true,
                        hash: transferResp.hash,
                        amount: formatEther(transferResp.value),
                        recipient: transferResp.to,
                        chain: walletProvider.getCurrentChain().name,
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
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("SEI_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "assistant",
                content: {
                    text: "I'll help you transfer 1 SEI to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SEND_TOKENS",
                },
            },
            {
                user: "user",
                content: {
                    text: "Transfer 1 SEI to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "SEND_TOKENS",
                },
            },
        ],
    ],
    similes: ["SEND_TOKENS", "TOKEN_TRANSFER", "MOVE_TOKENS", "SEND_SEI"],
};

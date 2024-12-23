import {
    ActionExample,
    composeContext,
    Content,
    elizaLogger,
    generateObject,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import { validateMplBubblegumConfig } from "../environment";
import { getWalletKey } from "../utils";
import { MplBubblegumProvider } from "../providers/bubblegumProvider";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { PublicKey } from "@metaplex-foundation/umi";

export interface TransferContent extends Content {
    assetId: string;
    newLeafOwner: string;
}

function isTransferContent(
    _runtime: IAgentRuntime,
    content: any
): content is TransferContent {
    console.log("Content for transfer", content);
    return (
        typeof content.assetId === "string" &&
        typeof content.newLeafOwner === "string"
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Ensure that all extracted values, especially public key addresses, are complete and include every character as they appear in the messages. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "assetId": "54dQ8cfHsW1YfKYpmdVZhWpb9iSi6Pac82Nf7sg3bVb",
    "newLeafOwner": "G2FAbFQPFa5qKXCetoFZQEvF9BVvCKbvUZvodpVidnoY"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Asset Id
- New Leaf Owner  (new owner public key)

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SEND_COMPRESSED_NFT",
    similes: ["TRANSFER_COMPRESSED_NFT", "SEND_CNFT", "TRANSFER_CNFT"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating config for user:", message.userId);
        await validateMplBubblegumConfig(runtime);
        return true;
    },
    description:
        "Transfer compressed NFT (cNFT) from the agent wallet to another address",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting SEND_COMPRESSED_NFT handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const transferContext = composeContext({
            state,
            template: transferTemplate,
        });

        const content = await generateObject({
            runtime,
            context: transferContext,
            modelClass: ModelClass.LARGE,
        });

        if (!isTransferContent(runtime, content)) {
            console.error("Invalid content for SEND_COMPRESSED_NFT action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            const { keypair: agentKeypair } = await getWalletKey(runtime);

            const RPC_URL = runtime.getSetting("MPL_BUBBLEGUM_RPC_URL");

            const agentKeypairAdapter = fromWeb3JsKeypair(agentKeypair);

            const mplBubblegumProvider = new MplBubblegumProvider(
                RPC_URL,
                agentKeypairAdapter
            );

            const { signature, result } = await mplBubblegumProvider.transfer(
                content.assetId as PublicKey,
                content.newLeafOwner as PublicKey
            );

            console.log("Transfer successful", signature);

            if (callback) {
                callback({
                    text: `Successfully transferred ${content.assetId} to ${content.newLeafOwner}\nTransaction: ${signature}`,
                    content: {
                        success: true,
                        signature,
                        recipient: content.newLeafOwner,
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error in transfer", error);
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
                    text: "Send BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump now...",
                    action: "SEND_COMPRESSED_NFT",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa\nTransaction: 5KtPn3DXXzHkb7VAVHZGwXJQqww39ASnrf7YkyJoF2qAGEpBEEGvRHLnnTG8ZVwKqNHMqSckWVGnsQAgfH5pbxEb",
                },
            },
        ],
    ] as ActionExample[][],
};

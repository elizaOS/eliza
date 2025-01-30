import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import type { TransactionHash } from "genlayer-js/types";
import { ClientProvider } from "../providers/client";

export const waitForTransactionReceiptAction: Action = {
    name: "WAIT_FOR_TRANSACTION_RECEIPT",
    similes: ["WAIT_FOR_TRANSACTION_RECEIPT"],
    description: "Wait for a transaction receipt from the GenLayer protocol",
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("GENLAYER_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        elizaLogger.info("Starting wait for transaction receipt action");
        elizaLogger.debug("User message:", message.content.text);

        const clientProvider = new ClientProvider(runtime);
        // Extract transaction hash from message
        const hashMatch = message.content.text.match(/0x[a-fA-F0-9]{64}/);
        if (!hashMatch) {
            elizaLogger.error("No valid transaction hash found in message");
            throw new Error("No valid transaction hash found in message");
        }

        elizaLogger.info(`Waiting for receipt of transaction: ${hashMatch[0]}`);
        const result = await clientProvider.client.waitForTransactionReceipt({
            hash: hashMatch[0] as TransactionHash,
        });

        elizaLogger.success("Successfully received transaction receipt");
        elizaLogger.debug("Transaction receipt:", result);
        await callback(
            {
                text: `Transaction receipt received: ${JSON.stringify(result, null, 2)}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Wait for receipt of transaction 0x1234567890123456789012345678901234567890123456789012345678901234",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Waiting for transaction receipt...",
                    action: "WAIT_FOR_TRANSACTION_RECEIPT",
                },
            },
        ],
    ],
};

import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { ClientProvider } from "../providers/client";

export const getCurrentNonceAction: Action = {
    name: "GET_CURRENT_NONCE",
    similes: ["GET_CURRENT_NONCE"],
    description: "Get current nonce for an address from the GenLayer protocol",
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
        elizaLogger.info("Starting get current nonce action");
        elizaLogger.debug("User message:", message.content.text);

        const clientProvider = new ClientProvider(runtime);
        // Extract address from message
        const addressMatch = message.content.text.match(/0x[a-fA-F0-9]{40}/);
        if (!addressMatch) {
            elizaLogger.error("No valid address found in message");
            throw new Error("No valid address found in message");
        }

        elizaLogger.info(
            `Getting current nonce for address: ${addressMatch[0]}`
        );
        const result = await clientProvider.client.getCurrentNonce({
            address: addressMatch[0],
        });

        elizaLogger.success(`Successfully retrieved nonce: ${result}`);
        await callback(
            {
                text: `Current nonce for address ${addressMatch[0]}: ${result}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get current nonce for address 0xE2632a044af0Bc2f0a1ea1E9D9694cc1e1783208",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The current nonce is:",
                    action: "GET_CURRENT_NONCE",
                },
            },
        ],
    ],
};

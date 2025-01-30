import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { ClientProvider } from "../providers/client";

export const getContractSchemaAction: Action = {
    name: "GET_CONTRACT_SCHEMA",
    similes: ["GET_CONTRACT_SCHEMA"],
    description: "Get contract schema from the GenLayer protocol",
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
        elizaLogger.info("Starting get contract schema action");
        elizaLogger.debug("User message:", message.content.text);

        const clientProvider = new ClientProvider(runtime);
        // Extract address from message
        const addressMatch = message.content.text.match(/0x[a-fA-F0-9]{40}/);
        if (!addressMatch) {
            elizaLogger.error("No valid address found in message");
            throw new Error("No valid address found in message");
        }

        elizaLogger.info(
            `Getting contract schema for address: ${addressMatch[0]}`
        );
        const result = await clientProvider.client.getContractSchema(
            addressMatch[0]
        );

        elizaLogger.success("Successfully retrieved contract schema");
        elizaLogger.debug("Contract schema:", result);
        await callback(
            {
                text: `Contract schema: ${JSON.stringify(result, null, 2)}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get contract schema for address 0xE2632a044af0Bc2f0a1ea1E9D9694cc1e1783208",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here is the contract schema:",
                    action: "GET_CONTRACT_SCHEMA",
                },
            },
        ],
    ],
};

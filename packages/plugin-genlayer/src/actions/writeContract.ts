import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import type { WriteContractParams } from "../types";
import { ClientProvider } from "../providers/client";
import { getParamsWithLLM } from "../utils/llm";

const writeContractTemplate = `
# Task: Determine the contract address, function name, function arguments, and value for writing to the contract.

# Instructions: The user is requesting to write to a contract in the GenLayer protocol.

Here is the user's request:
{{userMessage}}

# Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "contractAddress": "<Contract Address>",
  "functionName": "<Function Name>",
  "functionArgs": [<Function Args>],
  "value": "<Value in BigInt>",
  "leaderOnly": <true/false>
}
\`\`\`
`;

export const writeContractAction: Action = {
    name: "WRITE_CONTRACT",
    similes: ["WRITE_CONTRACT"],
    description: "Write to a contract in the GenLayer protocol",
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
        elizaLogger.info("Starting write contract action");
        elizaLogger.debug("User message:", message.content.text);

        const clientProvider = new ClientProvider(runtime);
        const options = await getParamsWithLLM<WriteContractParams>(
            runtime,
            message,
            writeContractTemplate
        );

        if (!options) {
            elizaLogger.error("Failed to parse write contract parameters");
            throw new Error("Failed to parse write contract parameters");
        }

        elizaLogger.debug("Parsed parameters:", options);
        elizaLogger.info(
            `Writing to contract ${options.contractAddress} with function ${options.functionName}`
        );

        const result = await clientProvider.client.writeContract({
            address: options.contractAddress,
            functionName: options.functionName,
            args: options.functionArgs,
            value: options.value,
            leaderOnly: options.leaderOnly,
        });

        elizaLogger.success(
            `Successfully wrote to contract. Transaction hash: ${result}`
        );
        await callback(
            {
                text: `Successfully wrote to contract. Transaction hash: ${result}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Write to the GenLayer contract at 0xE2632a044af0Bc2f0a1ea1E9D9694cc1e1783208 by calling `set_value` with argument 42 and value 0",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Writing to contract with set_value(42)",
                    action: "WRITE_CONTRACT",
                },
            },
        ],
    ],
};

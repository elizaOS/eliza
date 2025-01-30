import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";
import type { ReadContractParams } from "../types";
import { ClientProvider } from "../providers/client";
import { getParamsWithLLM } from "../utils/llm";

const readContractTemplate = `
# Task: Determine the contract address, function name, and function arguments to read from the contract.

# Instructions: The user is requesting to read a contract from the GenLayer protocol.

Here is the user's request:
{{userMessage}}

# Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "contractAddress": "<Contract Address>",
  "functionName": "<Function Name>",
  "functionArgs": [<Function Args>]
}
\`\`\`
`;

export const readContractAction: Action = {
    name: "READ_CONTRACT",
    similes: ["READ_CONTRACT"],
    description: "Read a contract from the GenLayer protocol",
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
        const clientProvider = new ClientProvider(runtime);
        const options = await getParamsWithLLM<ReadContractParams>(
            runtime,
            message,
            readContractTemplate
        );
        if (!options)
            throw new Error("Failed to parse read contract parameters");
        const result = await clientProvider.client.readContract({
            address: options.contractAddress,
            functionName: options.functionName,
            args: options.functionArgs,
        });
        await callback(
            {
                text: `Here is the result of the contract call: ${result}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Read the GenLayer contract at 0xE2632a044af0Bc2f0a1ea1E9D9694cc1e1783208 by calling `get_have_coin` with no arguments",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here is the output of the contract call:",
                    action: "READ_CONTRACT",
                },
            },
        ],
    ],
};

import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import fs from "fs";
import type { DeployContractParams } from "../types";
import { ClientProvider } from "../providers/client";
import { getParamsWithLLM } from "../utils/llm";

const deployContractTemplate = `
# Task: Determine the contract code file path and constructor arguments for deploying a contract.

# Instructions: The user is requesting to deploy a contract to the GenLayer protocol.

<latest user message>
{{userMessage}}
</latest user message>

<data from recent messages>
{{recentMessagesData}}
</data from recent messages>

# Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "code_file": "<Contract Code File Path>",
  "args": [<Constructor Args>],
  "leaderOnly": <true/false>
}
\`\`\`
`;

export const deployContractAction: Action = {
    name: "DEPLOY_CONTRACT",
    similes: ["DEPLOY_CONTRACT"],
    description: "Deploy a contract to the GenLayer protocol",
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("GENLAYER_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        elizaLogger.info("Starting deploy contract action");
        elizaLogger.debug("User message:", message.content.text);

        const clientProvider = new ClientProvider(runtime);
        const options = await getParamsWithLLM<DeployContractParams>(
            runtime,
            message,
            deployContractTemplate,
            state
        );

        if (!options) {
            elizaLogger.error("Failed to parse deploy contract parameters");
            throw new Error("Failed to parse deploy contract parameters");
        }

        elizaLogger.debug("Parsed parameters:", options);
        elizaLogger.info(
            "Deploying contract with code length:",
            options.code_file.length
        );

        const code = await fs.readFileSync(options.code_file, "utf8");

        const result = await clientProvider.client.deployContract({
            code: code,
            args: options.args,
            leaderOnly: options.leaderOnly,
        });

        elizaLogger.success(
            `Successfully sent contract for deployment. Transaction hash: ${result}`
        );
        await callback(
            {
                text: `Successfully sent contract for deployment. Transaction hash: ${result}`,
            },
            []
        );
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy a new contract from /home/az/yeagerai/genlayer-studio/examples/contracts/wizard_of_coin.py with the argument 'true'",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Deploying contract...",
                    action: "DEPLOY_CONTRACT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please help me deploy a contract",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Sure! I'll help you deploy a contract. Please provide the code file path and constructor arguments.",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "The code file is /home/az/yeagerai/genlayer-studio/examples/contracts/wizard_of_coin.py",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Understood, I'll help you deploy the contract from /home/az/yeagerai/genlayer-studio/examples/contracts/wizard_of_coin.py. Now, please provide the constructor arguments.",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "The constructor argument is 'true'",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Perfect, I'll help you deploy the contract from /home/az/yeagerai/genlayer-studio/examples/contracts/wizard_of_coin.py with the argument 'true'.",
                    action: "DEPLOY_CONTRACT",
                },
            },
        ],
    ],
};

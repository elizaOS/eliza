import type { Action } from "@elizaos/core";
import { type ActionExample, type HandlerCallback, type IAgentRuntime, type Memory, type State, elizaLogger } from "@elizaos/core";
import { registerVoter } from "mind-randgen-sdk";
import { isAddress } from "viem";

export const registerAction: Action = {
    name: "MIND_REGISTER_VOTER",
    similes: [
        "MIND_VOTER_REGISTRATION",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        if (isAddress(runtime.getSetting("MIND_COLD_WALLET_ADDRESS")) && runtime.getSetting("MIND_HOT_WALLET_PRIVATE_KEY")) {
            return true;
        }
        return false;
    },
    description: "Register as a voter so that user can vote in Mind Network Randgen Hub.",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Mind Network MIND_REGISTER_VOTER handler...");

        try {
            await registerVoter();
            const reply = "You have registered successfully."
            elizaLogger.success(reply);
            if (callback) {
                callback({
                    text: reply,
                    content: {},
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error during voter registration:", error);
            if (callback) {
                callback({
                    text: `Error during voter registration: ${error.message}`,
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
                    text: "I want to register in Mind Network so that I can vote.",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll do the registration for you.",
                    action: "MIND_REGISTER_VOTER",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "You have registered successfully in Mind Network.",
                },
            },
        ], [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you help me to register as a voter in Mind Network?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll register for you.",
                    action: "MIND_REGISTER_VOTER",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "You have registered successfully in Mind Network.",
                },
            },
        ],
    ] as ActionExample[][],
};
import type { Action } from "@elizaos/core";
import { type ActionExample, type HandlerCallback, type IAgentRuntime, type Memory, type State, elizaLogger } from "@elizaos/core";
import { checkColdWalletReward } from "mind-randgen-sdk";
import { isAddress, formatEther } from "viem";

export const checkRewardAction: Action = {
    name: "MIND_CHECK_VOTING_REWARD",
    similes: [
        "MIND_GET_VOTING_REWARD",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const address = runtime.getSetting("MIND_COLD_WALLET_ADDRESS");
        if (!address) {
            throw new Error("MIND_COLD_WALLET_ADDRESS is not configured");
        }
        if (!isAddress(address)) {
            throw new Error("Invalid cold wallet address format");
        }
        return true;
    },
    description: "Get user's voting reward amount earned via voting in Mind Network.",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Mind Network MIND_CHECK_VOTING_REWARD handler...");

        try {
            const rewardAmount = await checkColdWalletReward();
            const reply = `Your voting reward amount is ${formatEther(rewardAmount)} vFHE.`
            elizaLogger.success(reply);
            if (callback) {
                callback({
                    text: reply,
                    content: {},
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error during checking voting reward:", error);
            if (callback) {
                callback({
                    text: `Error during checking voting reward: ${error.message}`,
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
                    text: "I want to check my Mind Network voting reward.",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll check how much reward you have earned.",
                    action: "MIND_CHECK_VOTING_REWARD",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Your voting reward amount is 8888.8888 vFHE.",
                },
            },
        ], [
            {
                user: "{{user1}}",
                content: {
                    text: "How many vFHE tokens I have earned for voting?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll check how much reward you have earned in Mind Network.",
                    action: "MIND_CHECK_VOTING_REWARD",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Your voting reward amount is 8888.8888 vFHE.",
                },
            },
        ],
    ] as ActionExample[][],
};
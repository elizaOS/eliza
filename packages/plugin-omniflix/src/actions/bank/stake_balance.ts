import {
    elizaLogger,
    HandlerCallback,
    type Memory,
    type State,
    ActionExample,
    Action,
    IAgentRuntime,
} from "@elizaos/core";
import stakeBalanceExamples from "../../action_examples/bank/stake_balance.ts";
import { WalletProvider, walletProvider } from "../../providers/wallet";

export class GetStakeBalanceAction {
    async getStakedBalance(
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ): Promise<{ balance: number; address: string }> {
        try {
            // Extract address from message if provided
            const messageText = message.content?.text?.toLowerCase() || "";
            const addressMatch = messageText.match(/omniflix[a-zA-Z0-9]{39}/);
            let queryAddress: string;

            if (addressMatch) {
                // Use the address provided in the message
                queryAddress = addressMatch[0];
            } else {
                // Fallback to wallet address from environment
                const wallet: WalletProvider = await walletProvider.get(
                    runtime,
                    message,
                    state
                );
                queryAddress = await wallet.getAddress();
            }

            const wallet: WalletProvider = await walletProvider.get(
                runtime,
                message,
                state
            );
            const client = await wallet.getClient();

            elizaLogger.info(
                `Checking staked balance for address: ${queryAddress}`
            );

            const balance = await client.getBalanceStaked(queryAddress);
            if (!balance) {
                return {
                    balance: 0,
                    address: queryAddress,
                };
            }
            const balanceInFLIX: number = Number(balance.amount) / 10 ** 6;

            elizaLogger.info(
                `Staked balance of ${queryAddress} is ${balanceInFLIX} FLIX`
            );
            return {
                balance: balanceInFLIX,
                address: queryAddress,
            };
        } catch (error) {
            throw new Error(`Staked balance check failed: ${error.message}`);
        }
    }
}

export default {
    name: "GET_STAKE_BALANCE",
    description:
        "Retrieve the staked balance of a specified blockchain address in FLIX tokens.",
    similes: [
        "check staked balance",
        "staked balance inquiry",
        "account staked balance",
    ],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting GET_STAKE_BALANCE handler...");

        try {
            const action = new GetStakeBalanceAction();
            const stakedBalance = await action.getStakedBalance(
                runtime,
                message,
                state
            );

            if (callback) {
                callback({
                    text: `Successfully retrieved staked balance of ${stakedBalance.address}\nStaked Balance: ${stakedBalance.balance} FLIX`,
                    content: {
                        success: true,
                        amount: stakedBalance.balance,
                        address: stakedBalance.address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error checking staked balance: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: stakeBalanceExamples as ActionExample[][],
} as Action;

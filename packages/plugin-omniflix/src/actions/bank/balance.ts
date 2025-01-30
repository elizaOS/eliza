import {
    elizaLogger,
    HandlerCallback,
    type Memory,
    type State,
    type Action,
    type ActionExample,
    type IAgentRuntime,
} from "@elizaos/core";
import balanceExamples from "../../action_examples/bank/balance";
import { WalletProvider, walletProvider } from "../../providers/wallet";

export class GetBalanceAction {
    async getBalance(
        runtime: IAgentRuntime,
        message: Memory,
        _state: State
    ): Promise<{ balance: number; address: string }> {
        try {
            let rpcEndpoint =
                runtime.getSetting("rpcEndpoint") ||
                process.env.OMNIFLIX_RPC_ENDPOINT;
            if (!rpcEndpoint) {
                rpcEndpoint = "https://rpc.omniflix.network:443";
            }

            const wallet: WalletProvider = await walletProvider.get(
                runtime,
                message,
                _state
            );
            const client = await wallet.getClient();

            // Try to get address from message, fallback to wallet address
            const addressMatch = message.content?.text?.match(
                /omniflix[a-zA-Z0-9]{39}/
            );
            let address: string;

            if (addressMatch) {
                address = addressMatch[0];
            } else {
                address = await wallet.getAddress();
                if (!address) {
                    throw new Error("No wallet address available");
                }
            }

            elizaLogger.info(`Checking balance for address: ${address}`);

            const balance = await client.getBalance(address, "uflix");
            if (!balance) {
                return {
                    balance: 0,
                    address: address,
                };
            }
            const balanceInFLIX: number = Number(balance.amount) / 10 ** 6;

            elizaLogger.info(`Balance of ${address} is ${balanceInFLIX} FLIX`);
            return {
                balance: balanceInFLIX,
                address: address,
            };
        } catch (error) {
            throw new Error(`Balance check failed: ${error.message}`);
        }
    }
}

export default {
    name: "GET_BALANCE",
    description:
        "Retrieve the balance of a specified blockchain address in FLIX tokens.",
    similes: ["check balance", "balance inquiry", "account balance"],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting GET_BALANCE handler...");

        try {
            const action = new GetBalanceAction();
            const { balance, address } = await action.getBalance(
                runtime,
                message,
                state
            );
            if (callback) {
                callback({
                    text: `Successfully retrieved balance of ${address}\nBalance: ${balance} FLIX`,
                    content: {
                        success: true,
                        amount: balance,
                        address: address,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Error checking balance: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: balanceExamples as ActionExample[][],
} as Action;

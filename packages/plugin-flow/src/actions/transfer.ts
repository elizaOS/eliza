import {
    composeContext,
    type Content,
    elizaLogger,
    generateObjectArray,
    ModelClass,
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import Exception from "../types/exception";
import { getFlowConnectorInstance } from "../providers/connector.provider";
import {
    FlowWalletProvider,
    isCadenceIdentifier,
    isEVMAddress,
    isFlowAddress,
} from "../providers/wallet.provider";
import { transferTemplate } from "../templates";
import { validateFlowConfig } from "../environment";
import type { TransactionResponse } from "../types";
import { transactions } from "../assets/transaction.defs";
import * as queries from "../queries";

/**
 * The generated content for the transfer action
 */
export interface TransferContent extends Content {
    token: string | null;
    amount: string;
    to: string;
    matched: boolean;
}

/**
 * Check if the content is a transfer content
 */
function isTransferContent(
    _runtime: IAgentRuntime,
    content: unknown
): content is TransferContent {
    elizaLogger.log("Content for transfer", content);
    return (
        content !== null &&
        typeof content === "object" &&
        ("token" in content) &&
        (!content.token ||
            (typeof content.token === "string" &&
                (isCadenceIdentifier(content.token) ||
                    isEVMAddress(content.token)))) &&
        "to" in content &&
        typeof content.to === "string" &&
        (isEVMAddress(content.to) || isFlowAddress(content.to)) &&
        "amount" in content &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number") &&
        "matched" in content &&
        typeof content.matched === "boolean"
    );
}

// FIXME: We need to use dynamic key index
const USE_KEY_INDEX = 0;

export class TransferAction {
    constructor(
        private walletProvider: FlowWalletProvider,
        public readonly useKeyIndex: number = USE_KEY_INDEX
    ) {}

    /**
     * Process the messages and generate the transfer content
     */
    async processMessages(
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ): Promise<TransferContent> {
   
        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Compose transfer context
        const transferContext = composeContext({
            state: currentState,
            template: transferTemplate,
        });

        // Generate transfer content
        const recommendations = await generateObjectArray({
            runtime,
            context: transferContext,
            modelClass: ModelClass.MEDIUM,
        });

        elizaLogger.debug("Recommendations", recommendations);

        // Convert array to object
        const content = recommendations[recommendations.length - 1];

        // Validate transfer content
        if (!isTransferContent(runtime, content)) {
            elizaLogger.error("Invalid content for SEND_COIN action.");
            throw new Exception(50100, "Invalid transfer content");
        }

        // Check if the content is matched
        if (!content.matched) {
            elizaLogger.error("Content does not match the transfer template.");
            throw new Exception(
                50100,
                "Content does not match the transfer template"
            );
        }
        return content;
    }

    async transfer(
        content: TransferContent,
        callback?: HandlerCallback
    ): Promise<TransactionResponse> {
        elizaLogger.log("Starting Flow Plugin's SEND_COIN handler...");

        const resp: TransactionResponse = {
            signer: {
                address: this.walletProvider.address,
                keyIndex: this.useKeyIndex,
            },
            txid: "",
        };
        const logPrefix = `Address: ${resp.signer.address}, using keyIdex: ${resp.signer.keyIndex}\n`;

        // Parsed fields
        const recipient = content.to;
        const amount =
            typeof content.amount === "number"
                ? content.amount
                : Number.parseFloat(content.amount);

        // Check if the wallet has enough balance to transfer
        const accountInfo = await queries.queryAccountBalanceInfo(
            this.walletProvider,
            this.walletProvider.address
        );
        const totalBalance =
            accountInfo.balance + (accountInfo.coaBalance ?? 0);

        // Check if the amount is valid
        if (totalBalance < amount) {
            elizaLogger.error("Insufficient balance to transfer.");
            if (callback) {
                callback({
                    text: `${logPrefix} Unable to process transfer request. Insufficient balance.`,
                    content: {
                        error: "Insufficient balance",
                    },
                });
            }
            throw new Exception(50100, "Insufficient balance to transfer");
        }

        try {
            // Execute transfer
            const authz = this.walletProvider.buildAuthorization(
                this.useKeyIndex
            ); // use default private key

            // For different token types, we need to handle the token differently
            if (!content.token) {
                elizaLogger.log(
                    `${logPrefix} Sending ${amount} FLOW to ${recipient}...`
                );
                // Transfer FLOW token
                resp.txid = await this.walletProvider.sendTransaction(
                    transactions.mainFlowTokenDynamicTransfer,
                    (arg, t) => [
                        arg(recipient, t.String),
                        arg(amount.toFixed(1), t.UFix64),
                    ],
                    authz
                );
            } else if (isCadenceIdentifier(content.token)) {
                // Transfer Fungible Token on Cadence side
                const [_, tokenAddr, tokenContractName] =
                    content.token.split(".");
                elizaLogger.log(
                    `${logPrefix} Sending ${amount} A.${tokenAddr}.${tokenContractName} to ${recipient}...`
                );
                resp.txid = await this.walletProvider.sendTransaction(
                    transactions.mainFTGenericTransfer,
                    (arg, t) => [
                        arg(amount.toFixed(1), t.UFix64),
                        arg(recipient, t.Address),
                        arg(`0x${tokenAddr}`, t.Address),
                        arg(tokenContractName, t.String),
                    ],
                    authz
                );
            } else if (isEVMAddress(content.token)) {
                // Transfer ERC20 token on EVM side
                // we need to update the amount to be in the smallest unit
                const decimals = await queries.queryEvmERC20Decimals(
                    this.walletProvider,
                    content.token
                );
                const adjustedAmount = BigInt(amount * (10 ** decimals));

                elizaLogger.log(
                    `${logPrefix} Sending ${adjustedAmount} ${content.token}(EVM) to ${recipient}...`
                );

                resp.txid = await this.walletProvider.sendTransaction(
                    transactions.mainEVMTransferERC20,
                    (arg, t) => [
                        arg(content.token, t.String),
                        arg(recipient, t.String),
                        // Convert the amount to string, the string should be pure number, not a scientific notation
                        arg(adjustedAmount.toString(), t.UInt256),
                    ],
                    authz
                );
            }

            elizaLogger.log(`${logPrefix} Sent transaction: ${resp.txid}`);

            // call the callback with the transaction response
            if (callback) {
                const tokenName = content.token || "FLOW";
                const baseUrl =
                    this.walletProvider.network === "testnet"
                        ? "https://testnet.flowscan.io"
                        : "https://flowscan.io";
                const txURL = `${baseUrl}/tx/${resp.txid}/events`;
                callback({
                    text: `${logPrefix} Successfully transferred ${content.amount} ${tokenName} to ${content.to}\nTransaction: [${resp.txid}](${txURL})`,
                    content: {
                        success: true,
                        txid: resp.txid,
                        token: content.token,
                        to: content.to,
                        amount: content.amount,
                    },
                });
            }
        } catch (e: unknown) {
            elizaLogger.error("Error in sending transaction:", e);
            if (callback) {
                callback({
                    text: `${logPrefix} Unable to process transfer request. Error in sending transaction.`,
                    content: {
                        error: e instanceof Error ? e.message : String(e),
                    },
                });
            }
            if (e instanceof Exception) {
                throw e;
            }
            
            throw new Exception(
                50100,
                `Error in sending transaction: ${e instanceof Error ? e.message : String(e)}`
            );
        }

        elizaLogger.log("Completed Flow Plugin's SEND_COIN handler.");

        return resp;
    }
}

export const transferAction = {
    name: "SEND_COIN",
    similes: [
        "SEND_TOKEN",
        "SEND_TOKEN_ON_FLOW",
        "TRANSFER_TOKEN_ON_FLOW",
        "TRANSFER_TOKENS_ON_FLOW",
        "TRANSFER_FLOW",
        "SEND_FLOW",
        "PAY_BY_FLOW",
    ],
    description:
        "Call this action to transfer any fungible token/coin from the agent's Flow wallet to another address",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateFlowConfig(runtime);
        const flowConnector = await getFlowConnectorInstance(runtime);
        const walletProvider = new FlowWalletProvider(runtime, flowConnector);
        try {
            await walletProvider.syncAccountInfo();
            // TODO: We need to check if the key index is valid
        } catch {
            elizaLogger.error("Failed to sync account info");
            return false;
        }
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const flowConnector = await getFlowConnectorInstance(runtime);
        const walletProvider = new FlowWalletProvider(runtime, flowConnector);
        const action = new TransferAction(walletProvider);
        let content: TransferContent;
        try {
            content = await action.processMessages(runtime, message, state);
        } catch (err) {
            elizaLogger.error("Error in processing messages:", err.message);
            if (callback) {
                callback({
                    text: `Unable to process transfer request. Invalid content: ${err.message}`,
                    content: {
                        error: "Invalid content",
                    },
                });
            }
            return false;
        }

        try {
            const res = await action.transfer(content, callback);
            elizaLogger.log(
                `Transfer action response: ${res.signer.address}[${res.signer.keyIndex}] - ${res.txid}`
            );
        } catch {
            return false;
        }
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 FLOW to 0xa2de93114bae3e73",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sending 1 FLOW tokens now, pls wait...",
                    action: "SEND_COIN",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 FLOW - A.1654653399040a61.FlowToken to 0xa2de93114bae3e73",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sending 1 FLOW tokens now, pls wait...",
                    action: "SEND_COIN",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1000 FROTH - 0xb73bf8e6a4477a952e0338e6cc00cc0ce5ad04ba to 0x000000000000000000000002e44fbfbd00395de5",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sending 1000 FROTH tokens now, pls wait...",
                    action: "SEND_COIN",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;

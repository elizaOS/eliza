import {
    elizaLogger,
    composeContext,
    type Content,
    type HandlerCallback,
    ModelClass,
    generateObject,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { z } from "zod";
import { sleep, base64ToHex } from "../util.ts";
import {
    initWalletProvider,
    type WalletProvider,
    nativeWalletProvider,
} from "../providers/wallet";
import { internal } from "@ton/ton";

export interface TransferContent extends Content {
    recipient: string;
    amount: string | number;
}

function isTransferContent(content: Content): content is TransferContent {
    console.log("Content for transfer", content);
    return (
        typeof content.recipient === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number")
    );
}

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4",
    "amount": "1"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- Recipient wallet address
- Amount to transfer

Respond with a JSON markdown block containing only the extracted values.`;

// Add interface for contract methods
interface TonWalletContract {
    getSeqno: () => Promise<number>;
}

interface ActionOptions {
    [key: string]: unknown;
}

export class TransferAction {
    private walletProvider: WalletProvider;

    constructor(walletProvider: WalletProvider) {
        this.walletProvider = walletProvider;
    }

    async transfer(params: TransferContent): Promise<string> {
        console.log(
            `Transferring: ${params.amount} tokens to (${params.recipient})`,
        );
        // { recipient: 'xx', amount: '0\\.3'}

        const walletClient = this.walletProvider.getWalletClient();
        const contract = walletClient.open(this.walletProvider.wallet);

        try {
            // Create a transfer
            const seqno: number = await contract.getSeqno();
            await sleep(1500);
            const transfer = contract.createTransfer({
                seqno,
                secretKey: this.walletProvider.keypair.secretKey,
                messages: [
                    internal({
                        value: params.amount.toString().replace(/\\/g, ""),
                        to: params.recipient,
                        body: "eliza ton wallet plugin",
                        bounce: false,
                    }),
                ],
            });
            await sleep(1500);
            await contract.send(transfer);
            console.log("Transaction sent, still waiting for confirmation...");
            await sleep(1500);
            //this.waitForTransaction(seqno, contract);
            const state = await walletClient.getContractState(
                this.walletProvider.wallet.address,
            );
            const { lt: _, hash: lastHash } = state.lastTransaction;
            return base64ToHex(lastHash);
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }

    async waitForTransaction(seqno: number, contract: TonWalletContract) {
        let currentSeqno = seqno;
        const startTime = Date.now();
        const TIMEOUT = 120000; // 2 minutes

        while (currentSeqno === seqno) {
            if (Date.now() - startTime > TIMEOUT) {
                throw new Error("Transaction confirmation timed out after 2 minutes");
            }
            await sleep(2000);
            currentSeqno = await contract.getSeqno();
        }
        console.log("transaction confirmed!");
    }
}

const buildTransferDetails = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
): Promise<TransferContent> => {
    const walletInfo = await nativeWalletProvider.get(runtime, message, state);
    state.walletInfo = walletInfo;

    // Initialize or update state
    let currentState = state;
    if (!currentState) {
        currentState = (await runtime.composeState(message)) as State;
    } else {
        currentState = await runtime.updateRecentMessageState(currentState);
    }

    // Define the schema for the expected output
    const transferSchema = z.object({
        recipient: z.string(),
        amount: z.union([z.string(), z.number()]),
    });

    // Compose transfer context
    const transferContext = composeContext({
        state,
        template: transferTemplate,
    });

    // Generate transfer content with the schema
    const content = await generateObject({
        runtime,
        context: transferContext,
        schema: transferSchema,
        modelClass: ModelClass.SMALL,
    });

    let transferContent: TransferContent = content.object as TransferContent;

    if (transferContent === undefined) {
        transferContent = content as unknown as TransferContent;
    }

    return transferContent;
};

export default {
    name: "SEND_TON_TOKEN",
    similes: ["SEND_TON", "SEND_TON_TOKENS"],
    description:
        "Call this action to send TON tokens to another wallet address. Supports sending any amount of TON to any valid TON wallet address. Transaction will be signed and broadcast to the TON blockchain.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: ActionOptions,
        callback?: HandlerCallback,
    ) => {
        elizaLogger.log("Starting SEND_TOKEN handler...");

        const transferDetails = await buildTransferDetails(
            runtime,
            message,
            state,
        );

        // Validate transfer content
        if (!isTransferContent(transferDetails)) {
            console.error("Invalid content for TRANSFER_TOKEN action.");
            if (callback) {
                callback({
                    text: "Unable to process transfer request. Invalid content provided.",
                    content: { error: "Invalid transfer content" },
                });
            }
            return false;
        }

        try {
            // TODO check token balance before transfer
            const walletProvider = await initWalletProvider(runtime);
            const action = new TransferAction(walletProvider);
            const hash = await action.transfer(transferDetails);

            if (callback) {
                callback({
                    // TODO wait for transaction to complete
                    text: `Successfully transferred ${transferDetails.amount} TON to ${transferDetails.recipient}, Transaction: ${hash}`,
                    content: {
                        success: true,
                        hash: hash,
                        amount: transferDetails.amount,
                        recipient: transferDetails.recipient,
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error during token transfer:", error);
            if (callback) {
                callback({
                    text: `Error transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: transferTemplate,
    // eslint-disable-next-line
    validate: async (_runtime: IAgentRuntime) => {
        //console.log("Validating TON transfer from user:", message.userId);
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 1 TON tokens to EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll send 1 TON tokens now...",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 1 TON tokens to EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4, Transaction: c8ee4a2c1bd070005e6cd31b32270aa461c69b927c3f4c28b293c80786f78b43",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer 0.5 TON to EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Processing transfer of 0.5 TON...",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 0.5 TON to EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N, Transaction: c8ee4a2c1bd070005e6cd31b32270aa461c69b927c3f4c28b293c80786f78b43",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please move 2.5 TON to EQByzSQE5Mf_UBf5YYVF_fRhP_oZwM_h7mGAymWBjxkY5yVm",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Initiating transfer of 2.5 TON...",
                    action: "SEND_TON_TOKEN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent 2.5 TON to EQByzSQE5Mf_UBf5YYVF_fRhP_oZwM_h7mGAymWBjxkY5yVm, Transaction: c8ee4a2c1bd070005e6cd31b32270aa461c69b927c3f4c28b293c80786f78b43",
                },
            },
        ],
    ],
};

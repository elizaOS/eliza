import {
    type Action,
    composeContext,
    generateObjectDeprecated,
    type IAgentRuntime,
    ModelClass,
    type State,
} from "@elizaos/core";
import { initWalletProvider, type WalletProvider } from "../providers/wallet";
import { bn } from "fuels";
import { transferTemplate } from "../templates";

type TransferParams = {
    toAddress: string;
    amount: string;
};

export class TransferAction {
    constructor(private walletProvider: WalletProvider) {}

    async transfer(params: TransferParams) {
        try {
            const { toAddress, amount } = params;
            const res = await this.walletProvider.wallet.transfer(
                toAddress,
                bn.parseUnits(amount)
            );
            const tx = await res.waitForResult();
            return tx;
        } catch (error) {
            throw new Error(`Transfer failed: ${error.message}`);
        }
    }
}

const buildTransferDetails = async (state: State, runtime: IAgentRuntime) => {
    const context = composeContext({
        state,
        template: transferTemplate,
    });

    const transferDetails = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as TransferParams;

    return transferDetails;
};

export const transferAction: Action = {
    name: "transfer",
    description: "Transfer Fuel ETH between addresses on Fuel Ignition",
    handler: async (runtime, _message, state, _options, callback) => {
        const walletProvider = await initWalletProvider(runtime);
        const action = new TransferAction(walletProvider);

        const paramOptions = await buildTransferDetails(state, runtime);

        try {
            const transferResp = await action.transfer(paramOptions);
            if (callback) {
                callback({
                    text: `Successfully transferred ${paramOptions.amount} ETH to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.id}`,
                    content: {
                        success: true,
                        hash: transferResp.id,
                        amount: paramOptions.amount,
                        recipient: paramOptions.toAddress,
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
    // template: transferTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("FUEL_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "assistant",
                content: {
                    text: "I'll help you transfer 1 ETH to 0x8F8afB12402C9a4bD9678Bec363E51360142f8443FB171655eEd55dB298828D1",
                    action: "SEND_TOKENS",
                },
            },
            {
                user: "user",
                content: {
                    text: "Transfer 1 ETH to 0x8F8afB12402C9a4bD9678Bec363E51360142f8443FB171655eEd55dB298828D1",
                    action: "SEND_TOKENS",
                },
            },
        ],
    ],
    similes: ["TRANSFER_FUEL_ETH"],
};

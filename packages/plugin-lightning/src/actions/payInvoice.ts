import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
    composeContext,
    generateObject,
    ModelClass,
    elizaLogger,
} from "@elizaos/core";

import {
    initLightningProvider,
    LightningProvider,
} from "../providers/lightning";
import { PayResult } from "astra-lightning";
import { PayArgs } from "../types";
import { payInvoiceTemplate } from "../templates";

export { payInvoiceTemplate };

type ExtendedPayResult = PayResult & { outgoing_channel: string };
export class PayInvoiceAction {
    constructor(private lightningProvider: LightningProvider) {
        this.lightningProvider = lightningProvider;
    }

    async getAvalibleChannelId(): Promise<string> {
        const { channels } = await this.lightningProvider.getLndChannel();
        const filteredActiveChannels = channels.filter(
            (channel) => channel.is_active === true
        );
        const sortedChannels = filteredActiveChannels.sort(
            (a, b) => b.local_balance - a.local_balance
        );
        if (sortedChannels.length > 0) {
            return sortedChannels[0].id;
        }
        return "";
    }
    async payInvoice(params: PayArgs): Promise<ExtendedPayResult> {
        const outgoing_channel = await this.getAvalibleChannelId();
        if (!outgoing_channel) {
            throw new Error("no avalible channel");
        }
        const requestArgs = {
            outgoing_channel: outgoing_channel,
            ...params,
        };
        const retPayInvoice = await this.lightningProvider.payInvoice(
            requestArgs
        );
        return {
            ...retPayInvoice,
            outgoing_channel: outgoing_channel,
        };
    }
}

export const payInvoiceAction = {
    name: "PAY_INVOICE",
    description: "Make a payment.",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: any,
        callback?: any
    ) => {
        elizaLogger.log("payInvoice action handler called");
        const lightningProvider = await initLightningProvider(runtime);
        const action = new PayInvoiceAction(lightningProvider);

        // Compose bridge context
        const payInvoiceContext = composeContext({
            state,
            template: payInvoiceTemplate,
        });
        const content = await generateObject({
            runtime,
            context: payInvoiceContext,
            modelClass: ModelClass.LARGE,
        });

        const payInvoiceOptions: PayArgs = {
            request: content.request,
            outgoing_channel: content.outgoing_channel,
        };

        try {
            const payInvoiceResp = await action.payInvoice(payInvoiceOptions);
            elizaLogger.log("🚀 ~ payInvoiceResp:", payInvoiceResp);

            if (callback) {
                const text = "";
                if (payInvoiceResp.is_confirmed) {
                    callback({
                        text: `Successfully paid invoice ${content.request} from ${payInvoiceResp.outgoing_channel};\nAmount: ${payInvoiceResp.tokens};\nFee: ${payInvoiceResp.fee};\nPayment Hash: ${payInvoiceResp.id};`,
                        content: { success: true },
                    });
                } else {
                    callback({
                        text: `Failed to payInvoice ${content.request} from ${content.outgoing_channel};\r\n Amount: ${payInvoiceResp.tokens};`,
                        content: {
                            success: false,
                        },
                    });
                }
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error in payInvoice handler:", error);
            if (callback) {
                callback({
                    text: `Error: ${error.message || "An error occurred"}`,
                });
            }
            return false;
        }
    },
    template: payInvoiceTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const cert = runtime.getSetting("LND_TLS_CERT");
        const macaroon = runtime.getSetting("LND_MACAROON");
        const socket = runtime.getSetting("LND_SOCKET");
        return !!cert && !!macaroon && !!socket;
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Pay invoice for lnbrc...",
                    action: "PAY_INVOICE",
                },
            },
        ],
    ],
    similes: ["PAY_INVOICE", "MAKE_PAYMENT"],
};

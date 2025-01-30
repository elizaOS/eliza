import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
    composeContext,
    generateObjectDeprecated,
    ModelClass,
    elizaLogger,
} from "@elizaos/core";

import {
    initLightningProvider,
    type LightningProvider,
} from "../providers/lightning";

import { createInvoiceTemplate } from "../templates";
import type { CreateInvoiceResult } from "astra-lightning";
import type { CreateInvoiceArgs } from "../types";
export { createInvoiceTemplate };

export class CreateInvoiceAction {
    constructor(private lightningProvider: LightningProvider) {
        this.lightningProvider = lightningProvider;
    }

    async createInvoice(
        params: CreateInvoiceArgs,
    ): Promise<CreateInvoiceResult> {
        if (!params.tokens) {
            throw new Error("tokens is required.");
        }
        const retCreateInvoice =
            await this.lightningProvider.createInvoice(params);
        return retCreateInvoice;
    }
}

export const createInvoiceAction = {
    name: "CREATE_INVOICE",
    description: "Create a Lightning invoice.",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: (response: {
            text: string;
            content?: { success: boolean; invoice?: string };
        }) => void,
    ) => {
        elizaLogger.log("CreateInvoice action handler called");
        const lightningProvider = await initLightningProvider(runtime);
        const action = new CreateInvoiceAction(lightningProvider);

        // Compose bridge context
        const createInvoiceContext = composeContext({
            state,
            template: createInvoiceTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: createInvoiceContext,
            modelClass: ModelClass.LARGE,
        });

        const createInvoiceOptions = {
            tokens: content.tokens,
        };

        try {
            const createInvoiceResp =
                await action.createInvoice(createInvoiceOptions);

            if (callback) {
                callback({
                    text: `Successfully created invoice for ${createInvoiceResp.tokens.toLocaleString()} sats\r\nInvoice: ${createInvoiceResp.request}`,
                    content: {
                        success: true,
                        invoice: createInvoiceResp.request,
                    },
                });
            }
            return true;
        } catch (error) {
            if (callback) {
                callback({ text: `Error: ${error.message}` });
            }
            return false;
        }
    },
    template: createInvoiceTemplate,
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
                    text: "Create an invoice for 1000 sats",
                    action: "CREATE_INVOICE",
                },
            },
        ],
    ],
    similes: ["CREATE_INVOICE"],
};

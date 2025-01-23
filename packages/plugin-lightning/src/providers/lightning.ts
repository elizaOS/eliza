import {
    type IAgentRuntime,
    type Provider,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import {
    authenticatedLndGrpc,
    type AuthenticatedLnd,
    type GetIdentityResult,
    type GetChannelsResult,
    getIdentity,
    getChannels,
    createInvoice,
    pay,
    type PayResult,
    type CreateInvoiceResult,
} from "astra-lightning";
import type { PayArgs, CreateInvoiceArgs } from "../types";
export class LightningProvider {
    private lndClient: AuthenticatedLnd;
    constructor(cert: string, macaroon: string, socket: string) {
        if (!cert || !macaroon || !socket) {
            throw new Error("Missing required LND credentials");
        }
        try {
            const { lnd } = authenticatedLndGrpc({
                cert: cert,
                macaroon: macaroon,
                socket: socket,
            });
            this.lndClient = lnd;
        } catch (error) {
            throw new Error(
                `Failed to initialize LND client: ${error.message}`,
            );
        }
    }
    async getLndIdentity(): Promise<GetIdentityResult> {
        try {
            return await getIdentity({ lnd: this.lndClient });
        } catch (error) {
            throw new Error(`Failed to get LND identity: ${error.message}`);
        }
    }
    async getLndChannel(): Promise<GetChannelsResult> {
        try {
            return await getChannels({ lnd: this.lndClient });
        } catch (error) {
            throw new Error(`Failed to get LND channels: ${error.message}`);
        }
    }
    async createInvoice(
        createInvoiceArgs: CreateInvoiceArgs,
    ): Promise<CreateInvoiceResult> {
        try {
            return await createInvoice({
                lnd: this.lndClient,
                ...createInvoiceArgs,
            });
        } catch (error) {
            throw new Error(`Failed to create invoice: ${error.message}`);
        }
    }
    async payInvoice(payInvoiceArgs: PayArgs): Promise<PayResult> {
        const ret = await pay({
            lnd: this.lndClient,
            ...payInvoiceArgs,
        });
        return ret;
    }
}

export const initLightningProvider = async (runtime: IAgentRuntime) => {
    const cert = runtime.getSetting("LND_TLS_CERT");
    const macaroon = runtime.getSetting("LND_MACAROON");
    const socket = runtime.getSetting("LND_SOCKET");
    return new LightningProvider(cert, macaroon, socket);
};

export const lndProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        _message: Memory,
        state?: State,
    ): Promise<string | null> {
        try {
            const lightningProvider = await initLightningProvider(runtime);
            const { public_key: nodePubkey } =
                await lightningProvider.getLndIdentity();
            const { channels } = await lightningProvider.getLndChannel();
            const agentName = state?.agentName || "The agent";
            return `${agentName}'s Lightning Node publickey: ${nodePubkey}\nChannel count: ${channels.length}`;
        } catch (error) {
            elizaLogger.error("Error in Lightning provider:", error.message);
            return null;
        }
    },
};

import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { WalletProvider } from "../providers/wallet";
import { licenseIPTemplate } from "../templates";
import type { LicenseIPParams } from "../types";
import type { MintLicenseTokensResponse } from "@story-protocol/core-sdk";
import { hasIpAttachedLicenseTerms } from "../queries";

export { licenseIPTemplate };

export class LicenseIPAction {
    constructor(private walletProvider: WalletProvider) {}

    async licenseIP(
        params: LicenseIPParams
    ): Promise<MintLicenseTokensResponse> {
        const storyClient = this.walletProvider.getStoryClient();
        const publicClient = this.walletProvider.getPublicClient();

        const hasLicenseTerms = await hasIpAttachedLicenseTerms(publicClient, {
            ipId: params.licensorIpId,
            licenseTemplate: "0x58E2c909D557Cd23EF90D14f8fd21667A5Ae7a93",
            licenseTermsId: BigInt(params.licenseTermsId),
        });
        // check if license terms are attached to the ip asset
        if (!hasLicenseTerms) {
            throw new Error("License terms are not attached to the IP Asset");
        }
        const response = await storyClient.license.mintLicenseTokens({
            licensorIpId: params.licensorIpId,
            licenseTermsId: params.licenseTermsId,
            amount: params.amount || 1,
            txOptions: { waitForTransaction: true },
        });

        return response;
    }
}

export const licenseIPAction = {
    name: "LICENSE_IP",
    description: "License an IP Asset on Story",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting LICENSE_IP handler...");

        // initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        const licenseIPContext = composeContext({
            state: currentState,
            template: licenseIPTemplate,
        });

        const content = await generateObjectDeprecated({
            runtime,
            context: licenseIPContext,
            modelClass: ModelClass.SMALL,
        });

        const walletProvider = new WalletProvider(runtime);
        const action = new LicenseIPAction(walletProvider);
        try {
            const response = await action.licenseIP(content);
            callback?.({
                text: `Successfully minted license tokens: ${response.licenseTokenIds.join(", ")}. Transaction Hash: ${response.txHash}. View it on the block explorer: https://odyssey.storyscan.xyz/tx/${response.txHash}`,
            });
            return true;
        } catch (e) {
            elizaLogger.error("Error licensing IP:", e.message);
            callback?.({ text: `Error licensing IP: ${e.message}` });
            return false;
        }
    },
    template: licenseIPTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("STORY_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I would like to license an IP.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sure! Please provide the ipId of the IP you want to license and the license terms id you want to attach.",
                    action: "LICENSE_IP",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "License an IP Asset 0x2265F2b8e47F98b3Bdf7a1937EAc27282954A4Db with license terms 1",
                },
            },
        ],
    ],
    similes: ["LICENSE", "LICENSE_IP", "LICENSE_IP_ASSET"],
};

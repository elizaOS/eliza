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
import { attachTermsTemplate } from "../templates";
import type {
    AttachLicenseTermsResponse,
    LicenseTerms,
    RegisterPILResponse,
} from "@story-protocol/core-sdk";
import type { AttachTermsParams } from "../types";
import { zeroAddress } from "viem";

export { attachTermsTemplate };

export class AttachTermsAction {
    constructor(private walletProvider: WalletProvider) {}

    async attachTerms(params: AttachTermsParams): Promise<{
        attachTermsResponse: AttachLicenseTermsResponse;
        registerPilTermsResponse: RegisterPILResponse;
    }> {
        const storyClient = this.walletProvider.getStoryClient();

        elizaLogger.log("params", params);

        const licenseTerms: LicenseTerms = {
            transferable: true,
            royaltyPolicy: params.commercialUse
                ? "0x28b4F70ffE5ba7A26aEF979226f77Eb57fb9Fdb6"
                : zeroAddress,
            defaultMintingFee: params.mintingFee
                ? BigInt(params.mintingFee)
                : BigInt(0),
            expiration: BigInt(0),
            commercialUse: params.commercialUse || false,
            commercialAttribution: false,
            commercializerChecker: zeroAddress,
            commercializerCheckerData: zeroAddress,
            commercialRevShare: params.commercialUse
                ? params.commercialRevShare
                : 0,
            commercialRevCeiling: BigInt(0),
            derivativesAllowed: true,
            derivativesAttribution: true,
            derivativesApproval: false,
            derivativesReciprocal: true,
            derivativeRevCeiling: BigInt(0),
            currency: "0xC0F6E387aC0B324Ec18EAcf22EE7271207dCE3d5",
            uri: "",
        };

        const registerPilTermsResponse =
            await storyClient.license.registerPILTerms({
                ...licenseTerms,
                txOptions: { waitForTransaction: true },
            });

        const attachTermsResponse =
            await storyClient.license.attachLicenseTerms({
                ipId: params.ipId,
                licenseTermsId: registerPilTermsResponse.licenseTermsId,
                txOptions: { waitForTransaction: true },
            });

        return { attachTermsResponse, registerPilTermsResponse };
    }
}

export const attachTermsAction = {
    name: "ATTACH_TERMS",
    description: "Attach license terms to an IP Asset on Story",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting ATTACH_TERMS handler...");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        const attachTermsContext = composeContext({
            state: currentState,
            template: attachTermsTemplate,
        });

        const content = await generateObjectDeprecated({
            runtime,
            context: attachTermsContext,
            modelClass: ModelClass.SMALL,
        });

        const walletProvider = new WalletProvider(runtime);
        const action = new AttachTermsAction(walletProvider);
        try {
            const response = await action.attachTerms(content);
            // if license terms were attached
            if (response.attachTermsResponse.success) {
                callback?.({
                    text: `Successfully attached license terms: ${response.registerPilTermsResponse.licenseTermsId}. Transaction Hash: ${response.attachTermsResponse.txHash}. View it on the block explorer: https://odyssey.storyscan.xyz/tx/${response.attachTermsResponse.txHash}`,
                });
                return true;
            }
            // if license terms were already attached
            callback?.({
                text: `License terms ${response.registerPilTermsResponse.licenseTermsId} were already attached to IP Asset ${content.ipId}`,
            });
            return true;
        } catch (e) {
            elizaLogger.error("Error licensing IP:", e.message);
            callback?.({ text: `Error licensing IP: ${e.message}` });
            return false;
        }
    },
    template: attachTermsTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("STORY_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I would like to attach license terms to my IP.",
                    action: "ATTACH_TERMS",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sure! What is the ipId? You should also tell me if you want to add a minting fee, or if you want to enable commercial use of your IP. If so, you can add a revenue share as well.",
                    action: "ATTACH_TERMS",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Attach commercial, 10% rev share license terms to IP Asset 0x2265F2b8e47F98b3Bdf7a1937EAc27282954A4Db",
                },
            },
        ],
    ],
    similes: ["ATTACH_TERMS", "ATTACH_TERMS_TO_IP"],
};

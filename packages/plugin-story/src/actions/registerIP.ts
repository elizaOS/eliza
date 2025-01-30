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
import pinataSDK from "@pinata/sdk";
import type { RegisterIpResponse } from "@story-protocol/core-sdk";
import { createHash } from "node:crypto";  // Added node: protocol
import { uploadJSONToIPFS } from "../functions/uploadJSONToIPFS";
import { WalletProvider } from "../providers/wallet";
import { registerIPTemplate } from "../templates";
import type { RegisterIPParams } from "../types";

export { registerIPTemplate };

export class RegisterIPAction {
    constructor(private walletProvider: WalletProvider) {}

    async registerIP(
        params: RegisterIPParams,
        runtime: IAgentRuntime
    ): Promise<RegisterIpResponse> {
        const storyClient = this.walletProvider.getStoryClient();

        // configure ip metadata
        const ipMetadata = storyClient.ipAsset.generateIpMetadata({
            title: params.title,
            description: params.description,
            ipType: params.ipType ? params.ipType : undefined,
        });

        // configure nft metadata
        const nftMetadata = {
            name: params.title,
            description: params.description,
        };

        const pinataJWT = runtime.getSetting("PINATA_JWT");
        if (!pinataJWT) throw new Error("PINATA_JWT not configured");
        const pinata = new pinataSDK({ pinataJWTKey: pinataJWT });

        // upload metadata to ipfs
        const ipIpfsHash = await uploadJSONToIPFS(pinata, ipMetadata);
        const ipHash = createHash("sha256")
            .update(JSON.stringify(ipMetadata))
            .digest("hex");
        const nftIpfsHash = await uploadJSONToIPFS(pinata, nftMetadata);
        const nftHash = createHash("sha256")
            .update(JSON.stringify(nftMetadata))
            .digest("hex");

        // register ip
        const response =
            await storyClient.ipAsset.mintAndRegisterIpAssetWithPilTerms({
                spgNftContract: "0xC81B2cbEFD1aA0227bf513729580d3CF40fd61dF",
                terms: [],
                ipMetadata: {
                    ipMetadataURI: `https://ipfs.io/ipfs/${ipIpfsHash}`,
                    ipMetadataHash: `0x${ipHash}`,
                    nftMetadataURI: `https://ipfs.io/ipfs/${nftIpfsHash}`,
                    nftMetadataHash: `0x${nftHash}`,
                },
                txOptions: { waitForTransaction: true },
            });

        return response;
    }
}

export const registerIPAction = {
    name: "REGISTER_IP",
    description: "Register an NFT as an IP Asset on Story",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting REGISTER_IP handler...");

        // initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        const registerIPContext = composeContext({
            state: currentState,
            template: registerIPTemplate,
        });

        const content = await generateObjectDeprecated({
            runtime,
            context: registerIPContext,
            modelClass: ModelClass.SMALL,
        });

        const walletProvider = new WalletProvider(runtime);
        const action = new RegisterIPAction(walletProvider);
        try {
            const response = await action.registerIP(content, runtime);
            callback?.({
                text: `Successfully registered IP ID: ${response.ipId}. Transaction Hash: ${response.txHash}. View it on the explorer: https://explorer.story.foundation/ipa/${response.ipId}`,
            });
            return true;
        } catch (e) {
            elizaLogger.error("Error registering IP:", e.message);
            callback?.({ text: `Error registering IP: ${e.message}` });
            return false;
        }
    },
    template: registerIPTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const privateKey = runtime.getSetting("STORY_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I would like to register my IP.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Sure! Please provide the title and description of your IP.",
                    action: "REGISTER_IP",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Register my IP titled 'My IP' with the description 'This is my IP'",
                },
            },
        ],
    ],
    similes: ["REGISTER_IP", "REGISTER_NFT"],
};

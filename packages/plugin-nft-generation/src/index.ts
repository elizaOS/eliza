import { Plugin } from "@elizaos/core";
import nftCollectionGeneration from "./actions/nftCollectionGeneration.ts";
import mintNFTAction from "./actions/mintNFTAction.ts";

export * from "./provider/wallet/walletSolana.ts";
export * from "./api.ts";

export async function sleep(ms: number = 3000) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export const nftGenerationPlugin: Plugin = {
    name: "nftCollectionGeneration",
    description: "Generate NFT Collections",
    actions: [nftCollectionGeneration, mintNFTAction],
    evaluators: [],
    providers: [],
};

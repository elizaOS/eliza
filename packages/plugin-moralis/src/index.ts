import { Plugin } from "@elizaos/core";
import getTokenPairs from "./actions/solana/getTokenPairs";
import getPairStats from "./actions/solana/getPairStats";
import getPairOHLCV from "./actions/solana/getPairOHLCV";
import getTokenStats from "./actions/solana/getTokenStats";
import getTokenPrice from "./actions/solana/getTokenPrice";
import getTokenMetadata from "./actions/solana/getTokenMetadata";

export const moralisPlugin: Plugin = {
    name: "moralis",
    description: "Moralis Plugin for Eliza",
    actions: [
        getTokenPairs,
        getPairStats,
        getPairOHLCV,
        getTokenStats,
        getTokenPrice,
        getTokenMetadata,
    ],
    evaluators: [],
    providers: [],
};

export default moralisPlugin;

import { Plugin } from "@elizaos/core";
import transfer from "./actions/transfer";
import { initiaWalletProvider } from "./providers/wallet";

export const initiaPlugin: Plugin = {
    name: "initiaPlugin",
    description: "Initia Plugin for Eliza",
    actions: [
        transfer,
    ],
    evaluators: [],
    providers: [initiaWalletProvider],
};

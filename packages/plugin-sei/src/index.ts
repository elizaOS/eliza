import type { Plugin } from "@elizaos/core";
import { evmWalletProvider } from "./providers/wallet.ts";

import { transferAction } from "./actions/transfer";

console.log("SEI IS BEING INITIALIZED")

export const seiPlugin: Plugin = {
    name: "sei",
    description: "Sei Plugin for Eliza",
    actions: [transferAction],
    evaluators: [],
    providers: [evmWalletProvider],
};

export default seiPlugin;

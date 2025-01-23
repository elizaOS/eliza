export * from "./actions/transfer";
export * from "./actions/balance";
export * from "./providers/wallet";
export * from "./types";

import type { Plugin } from "@elizaos/core";
import { transferAction } from "./actions/transfer";
import { balanceAction } from "./actions/balance";
import { cronosWalletProvider } from "./providers/wallet";

export const cronosPlugin: Plugin = {
    name: "cronos",
    description: "Cronos chain integration plugin",
    providers: [cronosWalletProvider],
    evaluators: [],
    services: [],
    actions: [transferAction, balanceAction],
};

export default cronosPlugin;
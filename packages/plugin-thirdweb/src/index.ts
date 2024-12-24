import { Plugin } from "@ai16z/eliza";
import { blockchainChatAction } from "./actions/chat";
export * as actions from "./actions/index.ts";

export const thirdwebPlugin: Plugin = {
    name: "PROVIDE_BLOCKCHAIN_DATA",
    description:
        "Search the blockchain with thirdweb Nebula for information about wallet addresses, token prices, token owners, transactions and their details.",
    actions: [blockchainChatAction],
    evaluators: [],
    providers: [],
};

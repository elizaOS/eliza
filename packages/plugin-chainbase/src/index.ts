import { Plugin } from "@elizaos/core";
import { retrieveTokenBalance } from "./actions/retrieveTokenBalance";
import { queryBlockChainData } from "./actions/queryData";

export const chainbasePlugin: Plugin = {
    name: "chainbase",
    description: "Chainbase Plugin for Eliza",
    actions: [retrieveTokenBalance, queryBlockChainData],
    providers: [],
    services: [],
};

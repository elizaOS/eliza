import { Plugin } from "@elizaos/core";
import { getTxnExecution } from "./actions/getTxnExecution";

export const blockendPlugin: Plugin = {
    name: "blockend",
    description: "Blockend plugin for executing transactions on chain",
    actions: [getTxnExecution],
    evaluators: [],
    providers: [],
};

export default blockendPlugin;

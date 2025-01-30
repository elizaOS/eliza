import type { Plugin } from "@elizaos/core";

export * as actions from "./actions/index.ts";
import { contractInteractionAction } from "./actions/actionContractInteraction.ts";

export const gelatoPlugin: Plugin = {
    name: "Gelato",
    description: "Gelato plugin for Eliza that relays transactions on chain",
    actions: [contractInteractionAction],
    evaluators: [],
    providers: [],
};
export default gelatoPlugin;

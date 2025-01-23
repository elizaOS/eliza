import { Plugin } from "@elizaos/core";
import { executeSwapAction } from "./actions/executeSwap.ts";


export const nitroPlugin: Plugin = {
    name: "Nitro",
    description: "Nitro Plugin for Eliza",
    actions: [executeSwapAction],
    evaluators: [],
    providers: [],
};

export default nitroPlugin;

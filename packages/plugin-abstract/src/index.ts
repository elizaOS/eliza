import { Plugin } from "@elizaos/core";

import transfer from "./actions/transfer.ts";

export const abstractPlugin: Plugin = {
    name: "abstract",
    description: "Abstract Plugin for Eliza",
    actions: [transfer],
    evaluators: [],
    providers: [],
};

export default abstractPlugin;

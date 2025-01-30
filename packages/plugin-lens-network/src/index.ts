import type { Plugin } from "@elizaos/core";

import transfer from "./actions/transfer.ts";

export const lensPlugin: Plugin = {
    name: "Lens",
    description: "Lens Plugin for Eliza",
    actions: [transfer],
    evaluators: [],
    providers: [],
};

export default lensPlugin;

import type { Plugin } from "@elizaos/core";
import providers from "./providers/index.ts";
import actions from "./actions/index.ts";

export const OmniflixPlugin: Plugin = {
    name: "omniflix",
    description: "Plugin for Omniflix",
    evaluators: [],
    actions,
    providers,
};

export default OmniflixPlugin;

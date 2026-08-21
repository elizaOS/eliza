import type { Plugin } from "@elizaos/core";
import { feedoProvider } from "./providers/feedoProvider";
import { storeFeedoAction } from "./actions/storeFeedo";

export const feedoPlugin: Plugin = {
    name: "feedo",
    description: "Decentralized, end-to-end encrypted permanent memory powered by Feedo Protocol",
    providers: [feedoProvider],
    actions: [storeFeedoAction],
    evaluators: [],
    services: [],
};

export default feedoPlugin;

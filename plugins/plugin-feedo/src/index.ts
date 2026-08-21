/**
 * ElizaOS Plugin for Feedo Protocol
 * Provides decentralized private memory storage and retrieval.
 */
import type { Plugin } from "@elizaos/core";
import { feedoProvider } from "./providers/feedoProvider";
import { storeFeedoAction } from "./actions/storeFeedo";

export const feedoPlugin: Plugin = {
    name: "feedo",
    description: "Decentralized private memory and hot-data search powered by Feedo Protocol",
    providers: [feedoProvider],
    actions: [storeFeedoAction],
    evaluators: [],
    services: [],
};

export default feedoPlugin;

import type { Plugin } from "@elizaos/core";
import { uploadAction } from "./actions/upload.ts";
import { storageClientEnvSchema } from "./environments.ts";
import { retrieveAction } from "./actions/retrieve.ts";
export * as actions from "./actions";

export const storagePlugin: Plugin = {
    name: "storage",
    description: "Plugin to manage files in a decentralized storage network",
    config: storageClientEnvSchema,
    actions: [uploadAction, retrieveAction],
    services: [],
    evaluators: [],
    providers: [],
};
export default storagePlugin;


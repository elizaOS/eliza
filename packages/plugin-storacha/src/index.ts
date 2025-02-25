import type { Plugin } from "@elizaos/core";
import { uploadAction } from "./actions/upload.ts";
import { storageClientEnvSchema } from "./environments.ts";
import { testAction } from "./actions/test.ts";
export * as actions from "./actions";

export const storagePlugin: Plugin = {
    name: "storage",
    description: "Plugin to manage files in a decentralized storage network",
    config: storageClientEnvSchema,
    actions: [uploadAction, testAction],
    services: [],
    evaluators: [],
    providers: [],
};
export default storagePlugin;


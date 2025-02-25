import type { Plugin } from "@elizaos/core";
import { uploadAction } from "./actions/upload.ts";

export * as actions from "./actions";

export const storagePlugin: Plugin = {
    name: "storage",
    description: "Plugin to upload files to Storacha Network",
    actions: [
        uploadAction,
    ],
    evaluators: [],
    providers: [],
};
export default storagePlugin;

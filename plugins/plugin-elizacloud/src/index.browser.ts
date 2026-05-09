import type { Plugin } from "@elizaos/core";

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud browser facade. Node-only routes and services are exported from the node entry.",
};

export * from "./types";
export default elizaOSCloudPlugin;

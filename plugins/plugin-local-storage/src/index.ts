import type { Plugin } from "@elizaos/core";

import { LocalFileStorageService } from "./services/local-storage";

export * from "./types";
export { LocalFileStorageService };

export const localStoragePlugin: Plugin = {
  name: "local-storage",
  description:
    "Local filesystem attachment storage (default fallback when Eliza Cloud storage is not connected)",
  services: [LocalFileStorageService],
  actions: [],
};

export default localStoragePlugin;

import type { Plugin } from "@elizaos/core";
import { AdvancedMemoryStorageService } from "./advanced-memory-storage-service";

export const advancedMemoryStoragePlugin: Plugin = {
  name: "advanced-memory-storage",
  description: "Registers plugin-sql advanced-memory storage for cloud runtimes",
  services: [AdvancedMemoryStorageService],
};

export default advancedMemoryStoragePlugin;

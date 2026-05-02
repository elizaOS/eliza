import type { Plugin } from "@elizaos/core";
import { createAdvancedMemoryPlugin } from "./advanced-memory";

export const advancedMemoryPlugin = createAdvancedMemoryPlugin() as unknown as Plugin;

export default advancedMemoryPlugin;

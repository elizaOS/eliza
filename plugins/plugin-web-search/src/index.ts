/** Credential-free public web search for Node and Worker runtimes. */
import type { Plugin } from "@elizaos/core";
import { webSearchEdgePlugin } from "./edge";

export const webSearchPlugin: Plugin = { ...webSearchEdgePlugin, name: "webSearch" };
export default webSearchPlugin;

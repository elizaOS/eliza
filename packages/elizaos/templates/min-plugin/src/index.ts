import type { Plugin } from "@elizaos/core";
import { infoProvider } from "./providers/info.js";

const PLUGIN_NAME = "__PLUGIN_NAME__";

const plugin: Plugin = {
  name: PLUGIN_NAME,
  description: `Runtime plugin: ${PLUGIN_NAME}.`,
  providers: [infoProvider],
};

export default plugin;
export { infoProvider, plugin };

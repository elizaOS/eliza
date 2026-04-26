import type { Plugin } from "@elizaos/core";
import { helloAction } from "./actions/hello.js";
import { infoProvider } from "./providers/info.js";

const PLUGIN_NAME = "__PLUGIN_NAME__";

const plugin: Plugin = {
  name: PLUGIN_NAME,
  description: `Runtime plugin: ${PLUGIN_NAME}.`,
  actions: [helloAction],
  providers: [infoProvider],
};

export default plugin;
export { plugin, helloAction, infoProvider };

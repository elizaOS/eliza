import type { Plugin } from "@elizaos/core";

/**
 * Browser entrypoint.
 *
 * The eliza-coder plugin requires filesystem/shell/git access and is therefore
 * Node-only. This stub avoids importing Node-only code in browser bundles.
 */
export const elizaCoderPlugin: Plugin = {
  name: "@elizaos/plugin-code",
  description: "Coder tools plugin (Node-only; browser stub)",
};

export default elizaCoderPlugin;

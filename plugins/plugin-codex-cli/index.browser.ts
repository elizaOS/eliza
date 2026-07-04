/**
 * Browser build stub for the node-only Codex provider. Its model handlers throw
 * because authentication reads ~/.codex/auth.json; the working implementation
 * lives in index.ts and is only reachable in a node runtime.
 */
import type { Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

const unsupported = async (): Promise<never> => {
  throw new Error("@elizaos/plugin-codex-cli is node-only because it reads ~/.codex/auth.json");
};

export const codexCliPlugin: Plugin = {
  name: "codex-cli",
  description: "ChatGPT Codex model provider using the codex CLI OAuth token cache (node-only)",
  config: {},
  async init(): Promise<void> {
    // Browser bundle intentionally does not import node:fs/node:crypto auth code.
  },
  models: {
    [ModelType.TEXT_SMALL]: unsupported,
    [ModelType.TEXT_LARGE]: unsupported,
  },
};

export default codexCliPlugin;

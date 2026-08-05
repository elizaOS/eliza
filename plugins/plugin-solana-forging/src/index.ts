import type { Plugin } from "@elizaos/core";
import { mintSolanaAgentAction } from "./actions/mint-agent.js";

export { buildMintAgentIntent, mintSolanaAgentAction } from "./actions/mint-agent.js";
export { readSolanaForgeConfig } from "./config.js";
export type { SolanaForgeConfig } from "./config.js";

export const solanaForgingPlugin: Plugin = {
  name: "@elizaos/plugin-solana-forging",
  description:
    "Cheshire Terminal Solana agent forging — Metaplex Core mint intents, optional dual-rail omni preview.",
  actions: [mintSolanaAgentAction],
  providers: [],
  services: [],
};

export default solanaForgingPlugin;

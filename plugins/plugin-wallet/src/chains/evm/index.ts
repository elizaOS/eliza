import type { Plugin, ServiceClass } from "@elizaos/core";
import { bridgeAction } from "./actions/bridge";
import { executeAction } from "./actions/gov-execute";
import { proposeAction } from "./actions/gov-propose";
import { queueAction } from "./actions/gov-queue";
import { voteAction } from "./actions/gov-vote";
import { swapAction } from "./actions/swap";
import { transferAction } from "./actions/transfer";
import { tokenBalanceProvider } from "./providers/get-balance";
import { evmWalletProvider } from "./providers/wallet";
import { EVMService } from "./service";

export { initWalletProvider, WalletProvider } from "./providers/wallet";
export type { SupportedChain } from "./types";

export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  evaluators: [],
  services: [EVMService] as ServiceClass[],
  actions: [
    transferAction,
    bridgeAction,
    swapAction,
    proposeAction,
    voteAction,
    queueAction,
    executeAction,
  ],
};

export default evmPlugin;

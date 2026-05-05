import type { Action, Plugin, ServiceClass } from "@elizaos/core";
import { walletRouterAction } from "../wallet-action";
import { executeAction } from "./actions/gov-execute";
import { proposeAction } from "./actions/gov-propose";
import { queueAction } from "./actions/gov-queue";
import { voteAction } from "./actions/gov-vote";
import { tokenBalanceProvider } from "./providers/get-balance";
import { evmWalletProvider } from "./providers/wallet";
import { EVMService } from "./service";

export { initWalletProvider, WalletProvider } from "./providers/wallet";
export {
  createEvmWalletChainHandler,
  EvmWalletChainHandler,
  type EvmExecutedTransaction,
  type EvmPreparedResult,
  type EvmRouterResult,
  type EvmWalletChainHandlerOptions,
  type EvmWalletMode,
  type EvmWalletSubaction,
} from "./chain-handler";
export type { SupportedChain } from "./types";

export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  evaluators: [],
  services: [EVMService] as ServiceClass[],
  actions: [
    walletRouterAction as Action,
    proposeAction as Action,
    voteAction as Action,
    queueAction as Action,
    executeAction as Action,
  ],
};

export default evmPlugin;

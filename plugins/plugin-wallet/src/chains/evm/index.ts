import type { Action, Plugin, ServiceClass } from "@elizaos/core";
import { walletRouterAction } from "../wallet-action";
import { tokenBalanceProvider } from "./providers/get-balance";
import { evmWalletProvider } from "./providers/wallet";
import { EVMService } from "./service";

export {
  createEvmWalletChainHandler,
  type EvmExecutedTransaction,
  type EvmPreparedResult,
  type EvmRouterResult,
  EvmWalletChainHandler,
  type EvmWalletChainHandlerOptions,
  type EvmWalletMode,
  type EvmWalletSubaction,
} from "./chain-handler";
export { initWalletProvider, WalletProvider } from "./providers/wallet";
export type { SupportedChain } from "./types";

export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  services: [EVMService] as ServiceClass[],
  actions: [walletRouterAction as Action],
};

export default evmPlugin;

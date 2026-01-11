/**
 * @elizaos/plugin-evm
 *
 * Multi-language EVM blockchain integration plugin for elizaOS.
 * This TypeScript implementation provides:
 * - Wallet management with TEE support
 * - Token transfers (native and ERC20)
 * - Token swaps via multiple aggregators
 * - Cross-chain bridges via LiFi
 * - DAO governance actions
 *
 * @packageDocumentation
 */

// Re-export actions
export {
  BridgeAction,
  bridgeAction,
  checkBridgeStatus,
} from "./actions/bridge";
export { SwapAction, swapAction } from "./actions/swap";
export { TransferAction, transferAction } from "./actions/transfer";
// Re-export constants
export * from "./constants";
// Re-export providers
export { tokenBalanceProvider } from "./providers/get-balance";
export {
  evmWalletProvider,
  initWalletProvider,
  WalletProvider,
} from "./providers/wallet";
// Re-export service
export { EVMService, type EVMWalletData } from "./service";
// Re-export templates
export * from "./templates";
// Re-export all types
export * from "./types";

// Import for plugin definition
import type { Plugin, Service } from "@elizaos/core";
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

/**
 * EVM Plugin for elizaOS
 *
 * Provides comprehensive EVM blockchain integration including:
 * - Multi-chain wallet management
 * - Token transfers
 * - DEX aggregator swaps
 * - Cross-chain bridges
 * - DAO governance actions (propose, vote, queue, execute)
 */
export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  evaluators: [],
  services: [EVMService as unknown as typeof Service],
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

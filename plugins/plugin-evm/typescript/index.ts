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

// Re-export all types
export * from "./types";

// Re-export constants
export * from "./constants";

// Re-export templates
export * from "./templates";

// Re-export actions
export { bridgeAction, BridgeAction, checkBridgeStatus } from "./actions/bridge";
export { swapAction, SwapAction } from "./actions/swap";
export { transferAction, TransferAction } from "./actions/transfer";

// Re-export providers
export { tokenBalanceProvider } from "./providers/get-balance";
export {
  evmWalletProvider,
  WalletProvider,
  initWalletProvider,
} from "./providers/wallet";

// Re-export service
export { EVMService, type EVMWalletData } from "./service";

// Import for plugin definition
import type { Plugin } from "@elizaos/core";
import { bridgeAction } from "./actions/bridge";
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
 */
export const evmPlugin: Plugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider, tokenBalanceProvider],
  evaluators: [],
  services: [EVMService],
  actions: [transferAction, bridgeAction, swapAction],
};

export default evmPlugin;

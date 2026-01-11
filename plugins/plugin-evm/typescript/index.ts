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


// Import for plugin definition
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

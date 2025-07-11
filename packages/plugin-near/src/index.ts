import type { Plugin } from '@elizaos/core';
import { walletProvider } from './providers/wallet';
import { executeSwap } from './actions/swap';
import { executeTransfer } from './actions/transfer';
import { storageActions } from './actions/storage';
import { crossChainActions } from './actions/crosschain';
import { escrowAction } from './actions/escrow';
import { WalletService } from './services/WalletService';
import { TransactionService } from './services/TransactionService';
import { SwapService } from './services/SwapService';
import { StorageService } from './services/StorageService';
import { CrossChainService } from './services/CrossChainService';
import { MarketplaceService } from './services/MarketplaceService';
import { GameService } from './services/GameService';
import { EscrowService } from './services/EscrowService';
import nearPluginTestSuite from './__tests__/e2e/near-plugin.test';
import storageServiceTestSuite from './__tests__/services/StorageService.test';

/**
 * NEAR Protocol plugin for ElizaOS
 *
 * This plugin provides:
 * - NEAR wallet management and transactions
 * - Token swaps on Ref Finance
 * - Cross-chain operations via NEAR Chain Signatures
 * - On-chain storage for agent memory
 * - Agent marketplace for services
 * - Multi-agent games
 */
export const nearPlugin: Plugin = {
  name: 'near',
  description: 'NEAR Protocol blockchain integration plugin for ElizaOS',

  providers: [walletProvider],
  actions: [executeTransfer, executeSwap, ...storageActions, ...crossChainActions, escrowAction],
  services: [
    WalletService as any,
    TransactionService as any,
    SwapService as any,
    StorageService as any,
    CrossChainService as any,
    MarketplaceService as any,
    GameService as any,
    EscrowService as any,
  ],
};

// Export all services for direct usage
export {
  WalletService,
  TransactionService,
  SwapService,
  StorageService,
  CrossChainService,
  MarketplaceService,
  GameService,
  EscrowService,
};

// Export all actions
export { executeTransfer, executeSwap, storageActions, crossChainActions, escrowAction };

// Export providers
export { walletProvider };

// Re-export types
export type {
  NearPluginConfig,
  NearToken,
  TokenBalance,
  TransferParams,
  SwapParams,
  TransactionResult,
  WalletInfo,
  SwapQuote,
  SwapRoute,
} from './core/types';

export {
  NearPluginError,
  NearErrorCode,
  isNearError,
  handleNearError,
  formatErrorMessage,
} from './core/errors';

export default nearPlugin;

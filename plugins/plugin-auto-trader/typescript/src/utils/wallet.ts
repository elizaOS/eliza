import { logger, type IAgentRuntime } from '@elizaos/core';
import { Keypair } from '@solana/web3.js';
import { decodeBase58 } from './utils.ts'; // decodeBase58 is imported from utils.ts

/**
 * Gets wallet keypair from runtime settings.
 * This function's primary use case is now limited, as private key handling
 * should be encapsulated within the @elizaos/plugin-solana.
 * It might be used for deriving the public key if needed before the Solana plugin
 * is fully initialized or for specific local operations not involving direct transaction signing by this plugin.
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
export function getWalletKeypair(runtime?: IAgentRuntime): Keypair {
  const privateKeyString = runtime?.getSetting('SOLANA_PRIVATE_KEY');
  if (!privateKeyString) {
    // It's important to distinguish this error source if multiple getWalletKeypair functions exist.
    throw new Error('No wallet private key configured (invoked from degenTrader/utils/wallet.ts)');
  }

  try {
    const privateKeyBytes = decodeBase58(privateKeyString);
    return Keypair.fromSecretKey(privateKeyBytes);
  } catch (error) {
    logger.error('Failed to create wallet keypair (in degenTrader/utils/wallet.ts):', error);
    throw error;
  }
}

// All other functions previously in this file (getWalletBalance, executeTrade, getTokenBalance, etc.)
// have been removed. Their functionality is now expected to be provided by the
// WalletService, which in turn utilizes the @elizaos/plugin-solana for actual blockchain interactions.
// This centralization aligns with the Eliza OS plugin architecture and promotes better separation of concerns.

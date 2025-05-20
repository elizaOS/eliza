import type { Plugin } from '@elizaos/core';
import { executeSwap } from './actions/swap';
import transferToken from './actions/transfer';
import { SOLANA_SERVICE_NAME } from './constants';
import { walletProvider } from './providers/wallet';
import { SolanaService } from './service';

export const solanaPlugin: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: 'Solana Plugin for Eliza',
  actions: [transferToken, executeSwap],
  evaluators: [],
  providers: [walletProvider],
  services: [SolanaService],
};
export default solanaPlugin;

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
  init: async (_, runtime: IAgentRuntime) => {
    console.log('solana init');

    const asking = 'solana';
    const serviceType = 'TRADER_CHAIN';
    let traderChainService = runtime.getService(serviceType) as any;
    while (!traderChainService) {
      console.log(asking, 'waiting for', serviceType, 'service...');
      traderChainService = runtime.getService(serviceType) as any;
      if (!traderChainService) {
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
      } else {
        console.log(asking, 'Acquired', serviceType, 'service...');
      }
    }

    const me = {
      name: 'Solana services',
    };
    traderChainService.registerChain(me);

    console.log('jupiter init done');
  },
};
export default solanaPlugin;

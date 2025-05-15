import type { Plugin, IAgentRuntime } from '@elizaos/core';

import { JupiterService } from './services/srv_jupiter';

export const jupiterPlugin: Plugin = {
  name: 'jupiterOS',
  description: 'jupiter plugin',
  actions: [],
  evaluators: [],
  providers: [],
  services: [JupiterService],
  init: async (_, runtime: IAgentRuntime) => {
    console.log('jupiter init');

    const asking = 'jupiter';
    const serviceType = 'solana';
    let solanaService = runtime.getService(serviceType) as any;
    while (!solanaService) {
      console.log(asking, 'waiting for', serviceType, 'service...');
      solanaService = runtime.getService(serviceType) as any;
      if (!solanaService) {
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
      } else {
        console.log(asking, 'Acquired', serviceType, 'service...');
      }
    }

    const me = {
      name: 'Jupiter DEX services',
    };
    solanaService.registerExchange(me);

    console.log('jupiter init done');
  },
};

export default jupiterPlugin;

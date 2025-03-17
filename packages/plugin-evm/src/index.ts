export * from './actions/bridge';
export * from './actions/swap';
export * from './actions/transfer';
export * from './providers/wallet';
export * from './service';
export * from './types';

import type { Plugin } from '@elizaos/core';
import { bridgeAction } from './actions/bridge';
import { swapAction } from './actions/swap';
import { transferAction } from './actions/transfer';
import { evmWalletProvider } from './providers/wallet';
import { EVMService } from './service';
import { EVM_SERVICE_NAME } from './constants';

export const evmPlugin: Plugin = {
  name: 'evm',
  description: 'EVM blockchain integration plugin',
  providers: [evmWalletProvider],
  evaluators: [],
  services: [EVMService],
  actions: [transferAction as any, bridgeAction as any, swapAction as any],
};

export default evmPlugin;

// import type { Plugin } from "@elizaos/core";
import { getAgentPublicAddressAction } from './actions/getAgentPublicAddress.ts';
import { getAgentWalletAddressProvider } from './providers/getAgentWalletAddressProvider.ts';

export const roflPlugin: any = {
  name: 'rofl',
  description: 'Rofl Plugin for Eliza',
  actions: [getAgentPublicAddressAction],
  evaluators: [],
  providers: [getAgentWalletAddressProvider],
};

export * from './actions/getAgentPublicAddress.ts';
export * from './providers/getAgentWalletAddressProvider.ts';
export * from './services/rofl.ts';

export default roflPlugin;

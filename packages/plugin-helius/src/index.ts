import type { Plugin } from '@elizaos/core';
import { heliusProvider } from './providers/helius';
export const heliusPlugin: Plugin = {
  name: 'helius',
  description: 'Helius data plugin',
  actions: [],
  evaluators: [],
  providers: [heliusProvider],
};

export default heliusPlugin;

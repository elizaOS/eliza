import type { Plugin } from '@elizaos/core';
import { believeAppProvider } from './providers/believe-app';
export const believeAppPlugin: Plugin = {
  name: 'belive.app',
  description: 'Belive.app data plugin',
  actions: [],
  evaluators: [],
  providers: [believeAppProvider],
};

export default believeAppPlugin;

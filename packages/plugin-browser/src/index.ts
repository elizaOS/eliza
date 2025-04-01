import type { Plugin } from '@elizaos/core';

import { BrowserService } from './services/browser';

export const browserPlugin: Plugin = {
  name: 'browser-plugin',
  description: 'Plugin for browser actions',
  services: [BrowserService],
  actions: [],
};

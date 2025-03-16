export * from './services/index';

import type { Plugin } from '@elizaos/core';

import { VideoService } from './services/index';

export const videoUnderstandingPlugin: Plugin = {
  name: 'video-understanding',
  description: 'Plugin for video understanding',
  services: [VideoService],
  actions: [],
};

export default videoUnderstandingPlugin;

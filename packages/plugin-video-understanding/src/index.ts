import type { Plugin } from '@elizaos/core';

import { VideoService as VideoUnderstandingService } from './services/video';

export const videoUnderstandingPlugin: Plugin = {
  name: 'video-understanding',
  description: 'Plugin for video understanding',
  services: [VideoUnderstandingService],
  actions: [],
};

export default videoUnderstandingPlugin;

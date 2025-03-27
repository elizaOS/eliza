import type { Plugin } from '@elizaos/core';
import { CommunityManagerService } from './communityService';

export const communityManagerPlugin: Plugin = {
  name: 'community manager plugin',
  description: 'community manager plugin plugin',
  evaluators: [],
  providers: [],
  actions: [],
  services: [CommunityManagerService],
};

export default communityManagerPlugin;

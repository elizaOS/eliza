import type { Plugin } from '@elizaos/core';
import { CommunityManagerService } from './communityService';

export const communityManagerPlugin: Plugin = {
  name: 'community-manager',
  description: 'Community Manager Plugin for Eliza',
  evaluators: [],
  providers: [],
  actions: [],
  services: [CommunityManagerService],
};

export default communityManagerPlugin;

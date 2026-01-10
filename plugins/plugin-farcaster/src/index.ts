import { FarcasterService } from './service.js';
import { FarcasterTestSuite } from './__tests__/suite.js';
import { farcasterActions } from './actions/index.js';
import { farcasterProviders } from './providers/index.js';
import { farcasterWebhookRoutes } from './routes/webhook.js';

// Export types and utilities for external use
export { EmbedManager, isEmbedUrl, isEmbedCast, type ProcessedEmbed } from './managers/embedManager.js';
export type { Cast, CastEmbed, Profile, FarcasterConfig } from './common/types.js';

const farcasterPlugin = {
  name: 'farcaster',
  description: 'Farcaster client plugin for sending and receiving casts',
  services: [FarcasterService],
  actions: farcasterActions,
  providers: farcasterProviders,
  routes: farcasterWebhookRoutes,
  tests: [new FarcasterTestSuite()],
};

export default farcasterPlugin;

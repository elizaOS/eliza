import { type Plugin } from '@elizaos/core';
import { sendToAdminAction } from './action';
import { adminChatProvider } from './provider';
import { autonomyRoutes } from './routes';
import { AutonomyService } from './service';
import { autonomyStatusProvider } from './status-provider';

/**
 * Autonomy plugin with settings-based control:
 * 1. Service: Autonomous loop controlled via AUTONOMY_ENABLED setting
 * 2. Admin Chat Provider: Admin history (autonomous context only)
 * 3. Status Provider: Shows autonomy status (regular chat only)
 * 4. Action: Send message to admin (autonomous context only)
 * 5. Routes: API for enable/disable/status/toggle/interval
 */
export const autonomyPlugin: Plugin = {
  name: 'autonomy',
  description: 'Autonomous loop plugin with settings-based control',

  services: [AutonomyService],
  providers: [adminChatProvider, autonomyStatusProvider],
  actions: [sendToAdminAction],
  routes: autonomyRoutes,
};

// Export action
export { sendToAdminAction } from './action';
// Export providers
export { adminChatProvider } from './provider';
export { autonomyStatusProvider } from './status-provider';
// Export routes
export { autonomyRoutes } from './routes';
// Export service
export { AutonomyService } from './service';
// Export types
export { AutonomousServiceType } from './types';
export type { AutonomyConfig, AutonomyStatus } from './types';

export default autonomyPlugin;

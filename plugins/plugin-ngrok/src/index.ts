import { elizaLogger, type Plugin } from '@elizaos/core';
import { tunnelSlotIsFree } from '@elizaos/plugin-tunnel';
import { NgrokTestSuite } from './__tests__/NgrokTestSuite';
import { NgrokService } from './services/NgrokService';

/**
 * Ngrok tunnel plugin.
 *
 * Implements the `ITunnelService` contract from `@elizaos/plugin-tunnel`.
 * Registers `serviceType="tunnel"` only when no other tunnel service has
 * already claimed the slot (first-active-wins coordination across
 * plugin-tunnel, plugin-elizacloud's CloudTunnelService, and this plugin).
 */
export const ngrokPlugin: Plugin = {
  name: 'ngrok',
  description: 'Ngrok tunnel backend. Coexists with plugin-tunnel via first-active-wins.',
  actions: [],
  tests: [new NgrokTestSuite()],
  init: async (_config, runtime) => {
    if (!tunnelSlotIsFree(runtime)) {
      elizaLogger.info(
        '[plugin-ngrok] another tunnel service already registered — skipping NgrokService'
      );
      return;
    }
    elizaLogger.info('[plugin-ngrok] registering NgrokService for serviceType="tunnel"');
    await runtime.registerService(NgrokService);
  },
};

export default ngrokPlugin;

export * from './services/NgrokService';

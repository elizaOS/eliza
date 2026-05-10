import { elizaLogger, promoteSubactionsToActions, type Plugin } from '@elizaos/core';
import { TunnelTestSuite } from './__tests__/TunnelTestSuite';
import { tunnelAction } from './actions/tunnel';
import { tunnelStateProvider } from './providers/tunnel-state';
import { checkTailscaleInstalled, LocalTunnelService } from './services/LocalTunnelService';
import { tunnelSlotIsFree } from './types';

/**
 * Local Tailscale-CLI tunnel plugin.
 *
 * Registers `serviceType = "tunnel"` ONLY when:
 *  1. No other tunnel service has already claimed the slot (first-active-wins
 *     across plugin-tunnel, plugin-elizacloud, plugin-ngrok), AND
 *  2. The `tailscale` CLI is on PATH.
 *
 * The Eliza Cloud (headscale) tunnel lives in `@elizaos/plugin-elizacloud`.
 * Ngrok lives in `@elizaos/plugin-ngrok`. Enable as many as you like — only
 * one will bind.
 */
export const tunnelPlugin: Plugin = {
  name: 'tunnel',
  description:
    'Local Tailscale-CLI tunnel backend (serve / funnel). Coexists with plugin-elizacloud and plugin-ngrok via first-active-wins registration.',
  actions: [...promoteSubactionsToActions(tunnelAction)],
  providers: [tunnelStateProvider],
  tests: [new TunnelTestSuite()],
  init: async (_config, runtime) => {
    if (!tunnelSlotIsFree(runtime)) {
      elizaLogger.info(
        '[plugin-tunnel] another tunnel service already registered — skipping LocalTunnelService'
      );
      return;
    }
    const installed = await checkTailscaleInstalled();
    if (!installed) {
      elizaLogger.info(
        '[plugin-tunnel] tailscale CLI not found on PATH — skipping LocalTunnelService'
      );
      return;
    }
    elizaLogger.info('[plugin-tunnel] registering LocalTunnelService for serviceType="tunnel"');
    await runtime.registerService(LocalTunnelService);
  },
};

export default tunnelPlugin;

export { tunnelAction } from './actions/tunnel';
export { type TunnelConfig, validateTunnelConfig } from './environment';
export { tunnelStateProvider } from './providers/tunnel-state';
// Public surface for consumers and sibling tunnel plugins.
export { checkTailscaleInstalled, LocalTunnelService } from './services/LocalTunnelService';
export {
  getTunnelService,
  type ITunnelService,
  type TunnelProvider,
  type TunnelStatus,
  tunnelSlotIsFree,
} from './types';

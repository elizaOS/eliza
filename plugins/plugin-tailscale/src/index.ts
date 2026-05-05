import { type Plugin, elizaLogger } from '@elizaos/core';
import { startTailscaleAction } from './actions/start-tailscale';
import { stopTailscaleAction } from './actions/stop-tailscale';
import { getTailscaleStatusAction } from './actions/get-tailscale-status';
import { CloudTailscaleService } from './services/CloudTailscaleService';
import { LocalTailscaleService } from './services/LocalTailscaleService';
import { selectTunnelBackend } from './services/TunnelBackendSelector';
import { TailscaleTestSuite } from './__tests__/TailscaleTestSuite';

/**
 * Plugin doesn't list any services upfront. The selector runs in `init()` and
 * registers exactly one Tailscale backend (local or cloud) under a backend
 * specific serviceType. Consumers should stay backend-agnostic via
 * `getTunnelService(runtime)`.
 */
export const tailscalePlugin: Plugin = {
  name: 'tailscale',
  description: 'Tunnel plugin with local Tailscale serve/funnel and cloud-proxy backends.',
  actions: [startTailscaleAction, stopTailscaleAction, getTailscaleStatusAction],
  tests: [new TailscaleTestSuite()],
  init: async (_config, runtime) => {
    const decision = selectTunnelBackend(runtime);
    elizaLogger.info(
      `[plugin-tailscale] tunnel backend: ${decision.backend.name} (${decision.reason})`,
    );
    await runtime.registerService(decision.backend);
  },
};

export default tailscalePlugin;

export { LocalTailscaleService } from './services/LocalTailscaleService';
export { CloudTailscaleService } from './services/CloudTailscaleService';
export { selectTunnelBackend, readBackendMode } from './services/TunnelBackendSelector';
export type { BackendDecision } from './services/TunnelBackendSelector';
export type { ITunnelService, TunnelStatus, TunnelProvider, TailscaleBackendMode } from './types';

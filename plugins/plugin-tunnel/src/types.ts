/**
 * Tunnel-service contract shared across all elizaOS tunnel plugins.
 *
 * All tunnel plugins (`@elizaos/plugin-tunnel`, `@elizaos/plugin-elizacloud`'s
 * cloud tunnel, `@elizaos/plugin-ngrok`) register under
 * `serviceType = "tunnel"` so consumers stay backend-agnostic via
 * the core `ServiceType.TUNNEL` slot. The runtime returns the FIRST registered
 * service for a given type, so plugins coordinate via conditional
 * registration: each plugin's `init` only registers if its credentials are
 * present and no other tunnel service has already claimed the slot.
 */

export {
  getTunnelService,
  tunnelSlotIsFree,
  type ITunnelService,
  type TunnelProvider,
  type TunnelStatus,
} from '@elizaos/core';

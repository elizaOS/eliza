/**
 * Tunnel-service contract shared across all elizaOS tunnel plugins.
 *
 * All tunnel plugins (`@elizaos/plugin-tunnel`, `@elizaos/plugin-elizacloud`'s
 * cloud tunnel, `@elizaos/plugin-ngrok`) register under
 * `serviceType = "tunnel"` so consumers stay backend-agnostic via
 * `runtime.getService("tunnel")`. The runtime returns the FIRST registered
 * service for a given type, so plugins coordinate via conditional
 * registration: each plugin's `init` only registers if its credentials are
 * present and no other tunnel service has already claimed the slot.
 */

import type { IAgentRuntime, Service } from '@elizaos/core';

declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    TUNNEL: 'tunnel';
  }
}

export type TunnelProvider = 'tailscale' | 'headscale' | 'ngrok';

export interface TunnelStatus {
  active: boolean;
  url: string | null;
  port: number | null;
  startedAt: Date | null;
  provider: TunnelProvider;
  /** Optional human label distinguishing backend variants (e.g. "local-cli", "eliza-cloud-headscale"). */
  backend?: string;
}

export interface ITunnelService {
  startTunnel(port?: number): Promise<string | undefined>;
  stopTunnel(): Promise<void>;
  getUrl(): string | null;
  isActive(): boolean;
  getStatus(): TunnelStatus;
}

/**
 * Backend-agnostic accessor. Returns the first registered service that
 * implements the tunnel contract; returns null if nothing is registered or
 * the registered service doesn't satisfy the shape (defensive guard against
 * an unrelated service registering under "tunnel").
 */
export function getTunnelService(runtime: IAgentRuntime): ITunnelService | null {
  const service = runtime.getService('tunnel');
  if (!service) return null;
  if (typeof (service as Partial<ITunnelService>).startTunnel !== 'function') {
    return null;
  }
  return service as Service & ITunnelService;
}

/**
 * True iff no tunnel service has claimed `serviceType="tunnel"` yet.
 * Used by tunnel plugins' `init` hooks to coordinate "first active wins".
 */
export function tunnelSlotIsFree(runtime: IAgentRuntime): boolean {
  return runtime.getService('tunnel') === null;
}

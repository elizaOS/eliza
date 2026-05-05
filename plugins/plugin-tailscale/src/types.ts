/**
 * Local tunnel-service contract for the Tailscale plugin.
 *
 * Mirrors the contract defined by `@elizaos/plugin-ngrok/types`. The generic
 * `"tunnel"` serviceType remains supported for other tunnel plugins, while
 * Tailscale's local and cloud backends register under distinct serviceTypes so
 * static and runtime service collision checks can tell them apart.
 */

import type { IAgentRuntime, Service } from '@elizaos/core';

export const TUNNEL_SERVICE_TYPE = 'tunnel' as const;
export const TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE = 'tunnel:local' as const;
export const TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE = 'tunnel:cloud' as const;

declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    TUNNEL: typeof TUNNEL_SERVICE_TYPE;
    TAILSCALE_TUNNEL_LOCAL: typeof TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE;
    TAILSCALE_TUNNEL_CLOUD: typeof TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE;
  }
}

export type TunnelProvider = 'tailscale';

export interface TunnelStatus {
  active: boolean;
  url: string | null;
  port: number | null;
  startedAt: Date | null;
  provider: TunnelProvider;
}

export interface ITunnelService {
  startTunnel(port?: number): Promise<string | void>;
  stopTunnel(): Promise<void>;
  getUrl(): string | null;
  isActive(): boolean;
  getStatus(): TunnelStatus;
}

export type TailscaleBackendMode = 'local' | 'cloud' | 'auto';

/**
 * Backend-agnostic accessor. Tailscale checks its split local/cloud types first
 * and then falls back to the generic tunnel type for callers sharing this
 * helper with other tunnel providers.
 */
export function getTunnelService(runtime: IAgentRuntime): ITunnelService | null {
  const serviceTypes = [
    TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE,
    TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE,
    TUNNEL_SERVICE_TYPE,
  ];

  for (const serviceType of serviceTypes) {
    const service = runtime.getService(serviceType);
    if (service && typeof (service as Partial<ITunnelService>).startTunnel === 'function') {
      return service as Service & ITunnelService;
    }
  }

  return null;
}

/**
 * Local tunnel-service contract for the Tailscale plugin.
 *
 * Mirrors the contract defined by `@elizaos/plugin-ngrok/types`. Both plugins
 * register under `serviceType = "tunnel"` (added to the framework's
 * `ServiceTypeRegistry` via module augmentation below) so consumers stay
 * backend-agnostic via `runtime.getService("tunnel")`. They are mutually
 * exclusive — only one tunnel plugin can be enabled at a time.
 */

import type { IAgentRuntime, Service } from "@elizaos/core";

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    TUNNEL: "tunnel";
  }
}

export type TunnelProvider = "tailscale";

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

export type TailscaleBackendMode = "local" | "cloud" | "auto";

/**
 * Backend-agnostic accessor. Both bundled backends extend `Service` and
 * implement `ITunnelService`; the intersection cast is sound by construction.
 * The shape check guards against an unrelated service registering under
 * `"tunnel"`.
 */
export function getTunnelService(
  runtime: IAgentRuntime,
): ITunnelService | null {
  const service = runtime.getService("tunnel");
  if (!service) return null;
  if (typeof (service as Partial<ITunnelService>).startTunnel !== "function") {
    return null;
  }
  return service as Service & ITunnelService;
}

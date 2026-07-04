/**
 * Tailscale plugin re-exports the canonical tunnel-service contract from
 * `@elizaos/core`. Both backends (local CLI, cloud auth-key minter)
 * register under `serviceType="tunnel"`. Consumers should call
 * `getTunnelService(runtime)` from `@elizaos/core` to stay
 * backend-agnostic.
 */

export {
  getTunnelService,
  type ITunnelService,
  type TunnelProvider,
  type TunnelStatus,
} from "@elizaos/core";

export type TailscaleBackendMode = "local" | "cloud" | "auto";

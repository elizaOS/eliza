/**
 * Tailscale plugin re-exports the canonical tunnel-service contract from
 * `@elizaos/plugin-tunnel`. Both backends (local CLI, cloud auth-key minter)
 * register under `serviceType="tunnel"` and coordinate first-active-wins via
 * `tunnelSlotIsFree(runtime)`. Consumers should call `getTunnelService(runtime)`
 * from `@elizaos/plugin-tunnel` to stay backend-agnostic.
 */

export {
  getTunnelService,
  type ITunnelService,
  type TunnelProvider,
  type TunnelStatus,
  tunnelSlotIsFree,
} from "@elizaos/plugin-tunnel";

export type TailscaleBackendMode = "local" | "cloud" | "auto";

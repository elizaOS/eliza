import {
  elizaLogger,
  getConnectorAccountManager,
  type Plugin,
} from "@elizaos/core";
import { tunnelSlotIsFree } from "@elizaos/plugin-tunnel";
import { TailscaleTestSuite } from "./__tests__/TailscaleTestSuite";
import { createTailscaleConnectorAccountProvider } from "./connector-account-provider";
import { tailscaleStatusProvider } from "./providers/tailscale-status";
import { selectTunnelBackend } from "./services/TunnelBackendSelector";

/**
 * Plugin doesn't list any services upfront. The selector runs in `init()` and
 * registers exactly one Tailscale backend (local or cloud) under the canonical
 * `serviceType="tunnel"` slot from `@elizaos/plugin-tunnel`. Coordination with
 * other tunnel providers (ngrok, plugin-tunnel's local CLI, plugin-elizacloud's
 * cloud tunnel) is first-active-wins via `tunnelSlotIsFree(runtime)`.
 *
 * Consumers should stay backend-agnostic via `getTunnelService(runtime)` from
 * `@elizaos/plugin-tunnel`.
 *
 * The canonical TUNNEL action from `@elizaos/plugin-tunnel` handles start,
 * stop, and status. This plugin only contributes a provider/backend.
 */
export const tailscalePlugin: Plugin = {
  name: "tailscale",
  description:
    "Tunnel plugin with local Tailscale serve/funnel and cloud-proxy backends.",
  actions: [],
  providers: [tailscaleStatusProvider],
  tests: [new TailscaleTestSuite()],
  init: async (_config, runtime) => {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(
        createTailscaleConnectorAccountProvider(runtime),
      );
    } catch (err) {
      elizaLogger.warn(
        `[plugin-tailscale] failed to register ConnectorAccountManager provider: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!tunnelSlotIsFree(runtime)) {
      elizaLogger.info(
        "[plugin-tailscale] another tunnel service already registered — skipping Tailscale backend",
      );
      return;
    }

    const decision = selectTunnelBackend(runtime);
    elizaLogger.info(
      `[plugin-tailscale] tunnel backend: ${decision.backend.name} (${decision.reason})`,
    );
    await runtime.registerService(decision.backend);
  },
};

export default tailscalePlugin;

export * from "./accounts";
export { createTailscaleConnectorAccountProvider } from "./connector-account-provider";
export { CloudTailscaleService } from "./services/CloudTailscaleService";
export { LocalTailscaleService } from "./services/LocalTailscaleService";
export type { BackendDecision } from "./services/TunnelBackendSelector";
export {
  readBackendMode,
  selectTunnelBackend,
} from "./services/TunnelBackendSelector";
export type {
  ITunnelService,
  TailscaleBackendMode,
  TunnelProvider,
  TunnelStatus,
} from "./types";

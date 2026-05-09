import {
  elizaLogger,
  getConnectorAccountManager,
  type Plugin,
} from "@elizaos/core";
import { TailscaleTestSuite } from "./__tests__/TailscaleTestSuite";
import { tailscaleAction } from "./actions/tailscale";
import { createTailscaleConnectorAccountProvider } from "./connector-account-provider";
import { tailscaleStatusProvider } from "./providers/tailscale-status";
import { selectTunnelBackend } from "./services/TunnelBackendSelector";

/**
 * Plugin doesn't list any services upfront. The selector runs in `init()` and
 * registers exactly one Tailscale backend (local or cloud) under a backend
 * specific serviceType. Consumers should stay backend-agnostic via
 * `getTunnelService(runtime)`.
 *
 * Single TAILSCALE action handles start/stop. Live status flows through the
 * `tailscaleStatus` provider every turn, so reading tunnel state does not need
 * a dedicated action dispatch.
 */
export const tailscalePlugin: Plugin = {
  name: "tailscale",
  description:
    "Tunnel plugin with local Tailscale serve/funnel and cloud-proxy backends.",
  actions: [tailscaleAction],
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

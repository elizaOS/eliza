/**
 * Install the app-core implementation of the agent host bridge.
 *
 * `@elizaos/app-core` is the host layer above `@elizaos/agent`; the agent
 * runtime consumes a small set of host capabilities (OS wallet-key hydration,
 * vault bootstrap/access, the account-pool singleton, build-variant flags, and
 * the cloud-SSO pair route) through the downward-injection seam defined in
 * `@elizaos/agent/runtime/host-bridge`. This module wires the real app-core
 * implementations into that seam so the agent never imports `@elizaos/app-core`
 * (breaking the former `agent ↔ app-core` cycle, #9626).
 *
 * Called once from the app-core boot funnel before the runtime starts.
 * Idempotent — repeated calls re-install the same bridge cheaply.
 */

import {
  type AgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { getBuildVariant, isStoreBuild } from "@elizaos/core";
import { handleCloudPairRoute } from "../api/cloud-pair-route";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "../security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "../services/account-pool";
import { runVaultBootstrap } from "../services/vault-bootstrap";
import { sharedVault } from "../services/vault-mirror";

let installed = false;

export function installAgentHostBridge(): void {
  const bridge: AgentHostBridge = {
    hydrateWalletKeysFromNodePlatformSecureStore,
    runVaultBootstrap,
    sharedVault,
    getDefaultAccountPool,
    applyAccountPoolApiCredentials: (options) =>
      applyAccountPoolApiCredentials(options),
    startAccountPoolKeepAlive: () => startAccountPoolKeepAlive(),
    getBuildVariant,
    isStoreBuild,
    handleCloudPairRoute,
  };
  setAgentHostBridge(bridge);
  installed = true;
}

/** Whether the app-core bridge has been installed in this process. */
export function isAgentHostBridgeInstalled(): boolean {
  return installed;
}

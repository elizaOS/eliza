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
import { getAccountPoolBrokerSnapshot } from "../api/account-pool-broker-routes";
import { resolveAuthorizedRouteRole } from "../api/auth";
import { handleCloudPairRoute } from "../api/cloud-pair-route";
import {
  captureWalletEnvBootBaseline,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "../security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "../services/account-pool";
import {
  createAccountPoolConsumerKey,
  listAccountPoolConsumerKeys,
  rotateAccountPoolConsumerKey,
  updateAccountPoolConsumerKey,
} from "../services/account-pool-consumer-metering";
import { runVaultBootstrap } from "../services/vault-bootstrap";
import { sharedVault } from "../services/vault-mirror";

let installed = false;

export function installAgentHostBridge(): void {
  const resolveHttpRequestAuthorization: NonNullable<
    AgentHostBridge["resolveHttpRequestAuthorization"]
  > = async (req, runtime, options) => {
    const resolved = await resolveAuthorizedRouteRole(req, {
      allowCookieAuth: options.allowCookieAuth,
      state: {
        current: runtime,
      },
    });
    return resolved.ok
      ? {
          ok: true,
          role: resolved.role,
          ...(resolved.identityId ? { identityId: resolved.identityId } : {}),
          ...(resolved.principal ? { principal: resolved.principal } : {}),
        }
      : { ok: false, role: "NONE" };
  };
  const bridge: AgentHostBridge = {
    captureWalletEnvBootBaseline,
    hydrateWalletKeysFromNodePlatformSecureStore,
    runVaultBootstrap,
    sharedVault,
    getDefaultAccountPool,
    getAccountPoolBrokerSnapshot,
    // Owner-dashboard consumer-key admin (#16478). Thin passthrough: the
    // metering store stays the single authority; plaintext keys surface only
    // in the create/rotate return values and are never logged or persisted.
    getAccountPoolConsumerKeyAdmin: () => ({
      list: listAccountPoolConsumerKeys,
      create: (input) => createAccountPoolConsumerKey(input),
      update: (id, input) => updateAccountPoolConsumerKey(id, input),
      rotate: (id) => rotateAccountPoolConsumerKey(id),
    }),
    applyAccountPoolApiCredentials: (options) =>
      applyAccountPoolApiCredentials(options),
    startAccountPoolKeepAlive: () => startAccountPoolKeepAlive(),
    getBuildVariant,
    isStoreBuild,
    handleCloudPairRoute,
    resolveHttpRequestAuthorization,
    isHttpRequestAuthorized: async (req, runtime) =>
      (
        await resolveHttpRequestAuthorization(req, runtime, {
          allowCookieAuth: true,
        })
      ).ok,
  };
  setAgentHostBridge(bridge);
  installed = true;
}

/** Whether the app-core bridge has been installed in this process. */
export function isAgentHostBridgeInstalled(): boolean {
  return installed;
}

import {
  type AgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import {
  applyAccountPoolApiCredentials,
  createAccountPoolConsumerKey,
  getDefaultAccountPool,
  listAccountPoolConsumerKeys,
  rotateAccountPoolConsumerKey,
  startAccountPoolKeepAlive,
  updateAccountPoolConsumerKey,
} from "@elizaos/auth/accounts";
import { getBuildVariant, isStoreBuild } from "@elizaos/host";
import { registerAppRoutePluginLoader } from "@elizaos/host/protocol";
import { getAccountPoolBrokerSnapshot } from "../api/account-pool-broker-routes";
import {
  resolveAuthorizedRouteRole,
  resolveSessionTokenRole,
} from "../api/auth";
import { subscribeSessionRevocations } from "../api/auth/sessions";
import { handleCloudPairRoute } from "../api/cloud-pair-route";
import { resolveCloudRuntimeOwner } from "../api/cloud-runtime-owner";
import { handleDesktopAuthBootstrapRoute } from "../api/desktop-auth-bootstrap-routes";
import {
  captureWalletEnvBootBaseline,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "../security/hydrate-wallet-keys-from-platform-store";
import { runVaultBootstrap } from "../services/vault-bootstrap";
import { sharedVault } from "../services/vault-mirror";

/**
 * Install the app implementation of the agent host bridge.
 *
 * `@elizaos/app` is the host layer above `@elizaos/agent`; the agent
 * runtime consumes a small set of host capabilities (OS wallet-key hydration,
 * vault bootstrap/access, the account-pool singleton, build-variant flags, and
 * the cloud-SSO pair route) through the downward-injection seam defined in
 * `@elizaos/agent/runtime/host-bridge`. This module wires the real app
 * implementations into that seam so the agent never imports `@elizaos/app`
 * (breaking the former `agent ↔ app` cycle, #9626).
 *
 * Called once from the app boot funnel before the runtime starts.
 * Idempotent — repeated calls re-install the same bridge cheaply.
 */

let installed = false;

export function installAgentHostBridge(): void {
  registerAppRoutePluginLoader(
    "remote-browser-controller",
    async () =>
      (await import("@elizaos/plugin-browser/remote-controller"))
        .remoteBrowserControllerPlugin,
  );

  const resolveHttpRequestAuthorization: NonNullable<
    AgentHostBridge["resolveHttpRequestAuthorization"]
  > = async (req, runtime, options) => {
    if (req.headers["x-eliza-cloud-owner-proof"] !== undefined) {
      if (options.allowBearerAuth === false) return { ok: false, role: "NONE" };
      return resolveCloudRuntimeOwner(req, runtime);
    }
    const resolved = await resolveAuthorizedRouteRole(req, {
      allowCookieAuth: options.allowCookieAuth,
      allowTrustedLocalBypass: options.allowTrustedLocalBypass,
      allowBearerAuth: options.allowBearerAuth,
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
  // WebSocket bearer resolution (#13985): paired devices authenticate the
  // realtime socket with the same revocable machine-session id REST accepts,
  // resolved through the identical session-store machinery. Fail-closed:
  // an unknown/expired/revoked session or an unavailable store denies.
  const resolveSessionTokenAuthorization: NonNullable<
    AgentHostBridge["resolveSessionTokenAuthorization"]
  > = async (token, runtime) => {
    const resolved = await resolveSessionTokenRole(token, {
      state: { current: runtime },
      scope: "hostBridge/sessionTokenAuthorization",
    });
    return resolved
      ? {
          ok: true,
          role: resolved.role,
          ...(resolved.identityId ? { identityId: resolved.identityId } : {}),
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
    handleDesktopAuthBootstrapRoute: (req, res, runtime) =>
      handleDesktopAuthBootstrapRoute(req, res, {
        current: runtime,
        pendingAgentName: null,
        pendingRestartReasons: [],
      }),
    resolveHttpRequestAuthorization,
    resolveSessionTokenAuthorization,
    subscribeSessionRevocations,
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

/** Whether the app bridge has been installed in this process. */
export function isAgentHostBridgeInstalled(): boolean {
  return installed;
}

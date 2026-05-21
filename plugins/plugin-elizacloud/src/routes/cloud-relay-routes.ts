/**
 * Cloud gateway relay status route.
 *
 * Exposes the current state of the CloudManagedGatewayRelayService
 * so the UI can show whether this local instance is registered with
 * Eliza Cloud and actively receiving routed messages.
 *
 *   GET /api/cloud/relay-status
 *
 * The relay service lives in plugin-elizacloud and registers itself
 * as a runtime service named "cloud-managed-gateway-relay". We query
 * it via the runtime.getService interface to avoid a build-time dep.
 */

import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import {
  buildHomeRemoteRunnerAccessUrl,
  buildHomeRemoteRunnerSshTunnel,
} from "./home-remote-runner-access-url";

interface RelayServiceLike {
  getSessionInfo(): {
    sessionId: string | null;
    organizationId: string | null;
    userId: string | null;
    agentName: string | null;
    platform: string | null;
    lastSeenAt: string | null;
    status: "idle" | "registered" | "polling" | "error" | "stopped";
  };
}

export interface CloudRelayRouteState {
  runtime?: {
    getService(type: string): unknown;
    getSetting?: (key: string) => string | boolean | number | null;
  };
}

export async function handleCloudRelayRoute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudRelayRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (method !== "GET" || pathname !== "/api/cloud/relay-status") {
    return false;
  }

  if (!state.runtime) {
    helpers.json(res, {
      available: false,
      status: "no_runtime",
      reason: "Runtime not initialized",
    });
    return true;
  }

  // Try known service names used across package boundaries.
  const service = (state.runtime.getService("CLOUD_MANAGED_GATEWAY_RELAY") ??
    state.runtime.getService("cloud-managed-gateway-relay") ??
    state.runtime.getService(
      "cloudManagedGatewayRelay",
    )) as RelayServiceLike | null;

  if (!service || typeof service.getSessionInfo !== "function") {
    helpers.json(res, {
      available: false,
      status: "not_registered",
      reason:
        "Gateway relay service not active. Connect to Eliza Cloud in Settings to enable instance routing.",
    });
    return true;
  }

  try {
    const info = service.getSessionInfo();
    helpers.json(res, {
      available: true,
      ...info,
      accessUrl: buildHomeRemoteRunnerAccessUrl({
        sessionId: info.sessionId,
      }),
      ssh: buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl:
          readRuntimeSetting(state.runtime, "ELIZA_HOME_REMOTE_RUNNER_URL") ??
          process.env.ELIZA_HOME_REMOTE_RUNNER_URL ??
          readRuntimeSetting(state.runtime, "ELIZA_HOME_RUNNER_URL") ??
          process.env.ELIZA_HOME_RUNNER_URL,
        sshTarget:
          readRuntimeSetting(
            state.runtime,
            "ELIZA_HOME_REMOTE_RUNNER_SSH_TARGET",
          ) ??
          process.env.ELIZA_HOME_REMOTE_RUNNER_SSH_TARGET ??
          readRuntimeSetting(state.runtime, "ELIZA_HOME_SSH_TARGET") ??
          process.env.ELIZA_HOME_SSH_TARGET,
        sshIdentity:
          readRuntimeSetting(
            state.runtime,
            "ELIZA_HOME_REMOTE_RUNNER_SSH_IDENTITY",
          ) ??
          process.env.ELIZA_HOME_REMOTE_RUNNER_SSH_IDENTITY ??
          readRuntimeSetting(state.runtime, "ELIZA_HOME_SSH_IDENTITY") ??
          process.env.ELIZA_HOME_SSH_IDENTITY,
        localPort:
          readRuntimeSetting(
            state.runtime,
            "ELIZA_HOME_REMOTE_RUNNER_SSH_LOCAL_PORT",
          ) ?? process.env.ELIZA_HOME_REMOTE_RUNNER_SSH_LOCAL_PORT,
      }),
    });
  } catch (err) {
    helpers.json(res, {
      available: false,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}

function readRuntimeSetting(
  runtime: CloudRelayRouteState["runtime"],
  key: string,
): string | null {
  const value = runtime?.getSetting?.(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

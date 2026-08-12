/**
 * Discovers reachable local gateway endpoints via the plugin bridge, feeding the
 * connect/handoff surfaces.
 */
import { ElizaError } from "@elizaos/core/client-public";
import { logger } from "@elizaos/logger";
import { invokeDesktopBridgeRequestWithTimeout } from "./electrobun-rpc";
import { isElectrobunRuntime } from "./electrobun-runtime";
import { getPlugins, isFeatureAvailable } from "./plugin-bridge";

export interface GatewayDiscoveryEndpoint {
  stableId: string;
  name: string;
  host: string;
  port: number;
  lanHost?: string;
  tailnetDns?: string;
  gatewayPort?: number;
  tlsEnabled: boolean;
  tlsFingerprintSha256?: string;
  isLocal: boolean;
}

interface GatewayDiscoveryTransportResult {
  gateways?: GatewayDiscoveryEndpoint[];
  status?: string;
}

export type GatewayDiscoveryOutcome =
  | { status: "ok"; gateways: GatewayDiscoveryEndpoint[] }
  | {
      status: "unsupported" | "unavailable" | "timeout" | "failed";
      gateways: [];
      detail: string;
    };

interface GatewayDiscoveryPlugin {
  startDiscovery?: (options?: {
    timeout?: number;
  }) => Promise<GatewayDiscoveryTransportResult>;
  stopDiscovery?: () => Promise<void>;
}

function asGatewayDiscoveryPlugin(
  value: unknown,
): GatewayDiscoveryPlugin | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as GatewayDiscoveryPlugin;
}

const validPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;

function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim();
  if (
    host.length === 0 ||
    host.length > 253 ||
    /[\s/@?#\\[\]]/.test(host) ||
    !/^[a-zA-Z0-9._:-]+$/.test(host)
  ) {
    return undefined;
  }
  return host;
}

function normalizeGateways(gateways: unknown): GatewayDiscoveryEndpoint[] {
  if (!Array.isArray(gateways)) {
    return [];
  }

  const normalized: GatewayDiscoveryEndpoint[] = [];
  for (const candidate of gateways) {
    if (!candidate || typeof candidate !== "object") continue;
    const gateway = candidate as Record<string, unknown>;
    const stableId =
      typeof gateway.stableId === "string" ? gateway.stableId.trim() : "";
    const name = typeof gateway.name === "string" ? gateway.name.trim() : "";
    const host = normalizeHost(gateway.host);
    if (
      stableId.length === 0 ||
      name.length === 0 ||
      !host ||
      !validPort(gateway.port) ||
      typeof gateway.tlsEnabled !== "boolean" ||
      typeof gateway.isLocal !== "boolean"
    ) {
      continue;
    }

    const endpoint: GatewayDiscoveryEndpoint = {
      stableId,
      name,
      host,
      port: gateway.port,
      tlsEnabled: gateway.tlsEnabled,
      isLocal: gateway.isLocal,
    };
    const lanHost = normalizeHost(gateway.lanHost);
    if (lanHost) endpoint.lanHost = lanHost;
    const tailnetDns = normalizeHost(gateway.tailnetDns);
    if (tailnetDns) endpoint.tailnetDns = tailnetDns;
    if (validPort(gateway.gatewayPort)) {
      endpoint.gatewayPort = gateway.gatewayPort;
    }
    if (
      typeof gateway.tlsFingerprintSha256 === "string" &&
      /^[a-fA-F0-9]{64}$/.test(gateway.tlsFingerprintSha256)
    ) {
      endpoint.tlsFingerprintSha256 =
        gateway.tlsFingerprintSha256.toLowerCase();
    }
    normalized.push(endpoint);
  }
  return normalized;
}

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs the LAN scan over the Electrobun desktop bridge. Desktop has no
 * Capacitor plugin registry, so `getPlugins().gateway.plugin` is an empty
 * object there; the equivalent mDNS backend is reached through the
 * `gateway:*` RPC methods instead.
 *
 * Unlike the Capacitor implementations, the desktop `startDiscovery` returns
 * as soon as the bonjour browser is armed — its payload carries whatever was
 * already cached (empty on a cold scan), and responses arrive later on the
 * browser's `up` events. Returning that first payload would therefore always
 * report zero gateways, so this waits out the scan window and then reads the
 * populated set back via `gateway:getDiscoveredGateways`.
 */
async function discoverViaDesktopBridge(
  timeoutMs: number,
): Promise<GatewayDiscoveryOutcome> {
  const rpcTimeoutMs = Math.max(250, Math.min(timeoutMs, 5_000));
  let discoveryStarted = false;
  try {
    const startedOutcome =
      await invokeDesktopBridgeRequestWithTimeout<GatewayDiscoveryTransportResult>(
        {
          rpcMethod: "gatewayStartDiscovery",
          ipcChannel: "gateway:startDiscovery",
          // The UI normally tears down immediately after collection. This longer
          // backend timer is a backstop if the renderer reloads mid-scan.
          params: { timeout: timeoutMs + rpcTimeoutMs * 2 },
          timeoutMs: rpcTimeoutMs,
        },
      );

    if (startedOutcome.status === "missing") {
      return {
        status: "unavailable",
        gateways: [],
        detail: "Desktop gateway discovery bridge is unavailable",
      };
    }
    if (startedOutcome.status === "timeout") {
      return {
        status: "timeout",
        gateways: [],
        detail: "Desktop gateway discovery did not start in time",
      };
    }
    if (startedOutcome.status === "rejected") {
      logger.warn(
        { error: startedOutcome.error },
        "[gateway-discovery] Desktop discovery failed to start",
      );
      return {
        status: "failed",
        gateways: [],
        detail: "Desktop gateway discovery failed to start",
      };
    }
    const started = startedOutcome.value;
    const startStatus = started.status?.trim();
    if (
      startStatus !== "Discovery started" &&
      startStatus !== "Already discovering"
    ) {
      return {
        status: startStatus?.toLowerCase().includes("unavailable")
          ? "unavailable"
          : "failed",
        gateways: [],
        detail: startStatus || "Desktop gateway discovery failed to start",
      };
    }
    discoveryStarted = true;

    await settle(timeoutMs);

    const collectedOutcome =
      await invokeDesktopBridgeRequestWithTimeout<GatewayDiscoveryTransportResult>(
        {
          rpcMethod: "gatewayGetDiscoveredGateways",
          ipcChannel: "gateway:getDiscoveredGateways",
          timeoutMs: rpcTimeoutMs,
        },
      );

    if (collectedOutcome.status === "timeout") {
      return {
        status: "timeout",
        gateways: [],
        detail: "Desktop gateway discovery results timed out",
      };
    }
    if (collectedOutcome.status === "rejected") {
      logger.warn(
        { error: collectedOutcome.error },
        "[gateway-discovery] Desktop discovery result collection failed",
      );
      return {
        status: "failed",
        gateways: [],
        detail: "Desktop gateway discovery result collection failed",
      };
    }

    const collected =
      collectedOutcome.status === "ok" ? collectedOutcome.value : null;
    return {
      status: "ok",
      // Prefer the settled read; use the start payload only when the collection
      // method itself is absent on an older desktop bridge.
      gateways: normalizeGateways(collected?.gateways ?? started.gateways),
    };
  } catch (error) {
    // error-policy:J4 an unexpected bridge failure becomes a distinct failed
    // outcome at this renderer boundary and remains observable in diagnostics.
    logger.warn({ error }, "[gateway-discovery] Desktop discovery failed");
    return {
      status: "failed",
      gateways: [],
      detail: "Desktop gateway discovery failed",
    };
  } finally {
    if (discoveryStarted) {
      // error-policy:J6 best-effort teardown of the desktop scan session.
      void invokeDesktopBridgeRequestWithTimeout<unknown>({
        rpcMethod: "gatewayStopDiscovery",
        ipcChannel: "gateway:stopDiscovery",
        timeoutMs: rpcTimeoutMs,
      }).then((outcome) => {
        if (outcome.status !== "ok" && outcome.status !== "missing") {
          logger.warn(
            {
              status: outcome.status,
              error: outcome.status === "rejected" ? outcome.error : undefined,
            },
            "[gateway-discovery] Failed to stop desktop discovery",
          );
        }
      });
    }
  }
}

export async function discoverGatewayEndpoints(args?: {
  timeoutMs?: number;
}): Promise<GatewayDiscoveryOutcome> {
  if (!isFeatureAvailable("gatewayDiscovery")) {
    return {
      status: "unsupported",
      gateways: [],
      detail: "Gateway discovery is unsupported on this platform",
    };
  }

  const requestedTimeoutMs = args?.timeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs)
      ? Math.min(60_000, Math.max(1, Math.trunc(requestedTimeoutMs)))
      : 1500;

  if (isElectrobunRuntime()) {
    return discoverViaDesktopBridge(timeoutMs);
  }

  const plugin = asGatewayDiscoveryPlugin(getPlugins().gateway.plugin);
  if (!plugin?.startDiscovery) {
    return {
      status: "unavailable",
      gateways: [],
      detail: "Native gateway discovery plugin is unavailable",
    };
  }

  try {
    const result = await plugin.startDiscovery({
      timeout: timeoutMs,
    });
    return { status: "ok", gateways: normalizeGateways(result?.gateways) };
  } catch (error) {
    // error-policy:J4 the native boundary exposes failure distinctly from an
    // empty successful scan and retains the original error in diagnostics.
    logger.warn({ error }, "[gateway-discovery] Discovery failed");
    return {
      status: "failed",
      gateways: [],
      detail: "Native gateway discovery failed",
    };
  } finally {
    // error-policy:J6 best-effort teardown of the native scan session.
    void plugin.stopDiscovery?.().catch((error) => {
      logger.warn(
        { error },
        "[gateway-discovery] Failed to stop native discovery",
      );
    });
  }
}

export function getPreferredGatewayHost(
  gateway: GatewayDiscoveryEndpoint,
): string {
  const preferred =
    normalizeHost(gateway.lanHost) ||
    normalizeHost(gateway.tailnetDns) ||
    normalizeHost(gateway.host);
  if (!preferred) {
    throw new ElizaError("Gateway endpoint has no valid host", {
      code: "GATEWAY_DISCOVERY_HOST_INVALID",
      context: { stableId: gateway.stableId },
    });
  }
  return preferred;
}

export function gatewayEndpointToApiBase(
  gateway: GatewayDiscoveryEndpoint,
): string {
  const scheme = gateway.tlsEnabled ? "https" : "http";
  const host = getPreferredGatewayHost(gateway);
  const port = gateway.gatewayPort ?? gateway.port;
  if (!validPort(port)) {
    throw new ElizaError("Gateway endpoint has no valid port", {
      code: "GATEWAY_DISCOVERY_PORT_INVALID",
      context: { stableId: gateway.stableId, port },
    });
  }
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${urlHost}:${port}`;
}

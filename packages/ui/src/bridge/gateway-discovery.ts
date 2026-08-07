/**
 * Discovers reachable local gateway endpoints via the plugin bridge, feeding the
 * connect/handoff surfaces.
 */
import { logger } from "@elizaos/logger";
import { invokeDesktopBridgeRequest } from "./electrobun-rpc";
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
  isLocal: boolean;
}

interface GatewayDiscoveryResult {
  gateways?: GatewayDiscoveryEndpoint[];
}

interface GatewayDiscoveryPlugin {
  startDiscovery?: (options?: {
    timeout?: number;
  }) => Promise<GatewayDiscoveryResult>;
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

function normalizeGateways(
  gateways: readonly GatewayDiscoveryEndpoint[] | undefined,
): GatewayDiscoveryEndpoint[] {
  if (!Array.isArray(gateways)) {
    return [];
  }

  return gateways.filter(
    (gateway) =>
      typeof gateway?.stableId === "string" &&
      typeof gateway?.name === "string" &&
      typeof gateway?.host === "string" &&
      typeof gateway?.port === "number",
  );
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
): Promise<GatewayDiscoveryEndpoint[]> {
  try {
    const started = await invokeDesktopBridgeRequest<GatewayDiscoveryResult>({
      rpcMethod: "gatewayStartDiscovery",
      ipcChannel: "gateway:startDiscovery",
      // Let the UI own teardown below rather than arming the backend's own
      // stop timer, so the collect read below is guaranteed to happen while
      // the scan session is still alive.
      params: {},
    });

    // No desktop bridge on this runtime (`invokeDesktopBridgeRequest` resolves
    // null when the RPC method is absent) — nothing to collect.
    if (started === null) {
      return [];
    }

    await settle(timeoutMs);

    const collected = await invokeDesktopBridgeRequest<GatewayDiscoveryResult>({
      rpcMethod: "gatewayGetDiscoveredGateways",
      ipcChannel: "gateway:getDiscoveredGateways",
    });

    // Prefer the settled read; fall back to the start payload's warm cache.
    return normalizeGateways(collected?.gateways ?? started?.gateways);
  } catch (error) {
    // error-policy:J4 a failed LAN scan reads as "no gateways discovered" —
    // discovery is a probe, and the warn keeps a broken bridge observable.
    logger.warn({ error }, "[gateway-discovery] Desktop discovery failed");
    return [];
  } finally {
    // error-policy:J6 best-effort teardown of the desktop scan session.
    void invokeDesktopBridgeRequest<unknown>({
      rpcMethod: "gatewayStopDiscovery",
      ipcChannel: "gateway:stopDiscovery",
    }).catch((error) => {
      logger.warn(
        { error },
        "[gateway-discovery] Failed to stop desktop discovery",
      );
    });
  }
}

export async function discoverGatewayEndpoints(args?: {
  timeoutMs?: number;
}): Promise<GatewayDiscoveryEndpoint[]> {
  if (!isFeatureAvailable("gatewayDiscovery")) {
    return [];
  }

  const timeoutMs = args?.timeoutMs ?? 1500;

  if (isElectrobunRuntime()) {
    return discoverViaDesktopBridge(timeoutMs);
  }

  const plugin = asGatewayDiscoveryPlugin(getPlugins().gateway.plugin);
  if (!plugin?.startDiscovery) {
    return [];
  }

  try {
    const result = await plugin.startDiscovery({
      timeout: timeoutMs,
    });
    return normalizeGateways(result?.gateways);
  } catch (error) {
    // error-policy:J4 a failed LAN scan reads as "no gateways discovered" —
    // discovery is a probe, and the warn keeps a broken plugin observable.
    logger.warn({ error }, "[gateway-discovery] Discovery failed");
    return [];
  } finally {
    // error-policy:J6 best-effort teardown of the native scan session.
    void plugin.stopDiscovery?.().catch(() => {});
  }
}

export function getPreferredGatewayHost(
  gateway: GatewayDiscoveryEndpoint,
): string {
  const preferred =
    gateway.lanHost?.trim() ||
    gateway.tailnetDns?.trim() ||
    gateway.host.trim();
  return preferred;
}

export function gatewayEndpointToApiBase(
  gateway: GatewayDiscoveryEndpoint,
): string {
  const scheme = gateway.tlsEnabled ? "https" : "http";
  const host = getPreferredGatewayHost(gateway);
  const port = gateway.gatewayPort ?? gateway.port;
  return `${scheme}://${host}:${port}`;
}

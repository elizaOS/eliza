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

export async function discoverGatewayEndpoints(args?: {
  timeoutMs?: number;
}): Promise<GatewayDiscoveryEndpoint[]> {
  if (!isFeatureAvailable("gatewayDiscovery")) {
    return [];
  }

  const plugin = asGatewayDiscoveryPlugin(getPlugins().gateway.plugin);
  if (!plugin?.startDiscovery) {
    return [];
  }

  try {
    const result = await plugin.startDiscovery({
      timeout: args?.timeoutMs ?? 1500,
    });
    return normalizeGateways(result?.gateways);
  } catch {
    return [];
  } finally {
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

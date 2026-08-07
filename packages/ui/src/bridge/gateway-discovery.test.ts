/**
 * Covers the gateway LAN-discovery bridge on both transports: the Capacitor
 * native plugin (iOS/Android) and the Electrobun desktop RPC. The desktop lane
 * regressed silently because `getPlugins().gateway.plugin` is an empty object
 * off-Capacitor, so discovery returned [] on desktop even though the
 * bonjour-service backend behind `gateway:*` was live.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
const isFeatureAvailable = vi.fn<(feature: string) => boolean>();
const getPlugins = vi.fn<() => { gateway: { plugin: unknown } }>();
const isElectrobunRuntime = vi.fn<() => boolean>();
const invokeDesktopBridgeRequest =
  vi.fn<
    (options: { rpcMethod: string; params?: unknown }) => Promise<unknown>
  >();

vi.mock("./plugin-bridge", () => ({
  isFeatureAvailable: (feature: string) => isFeatureAvailable(feature),
  getPlugins: () => getPlugins(),
}));

vi.mock("./electrobun-runtime", () => ({
  isElectrobunRuntime: () => isElectrobunRuntime(),
}));

vi.mock("./electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (options: {
    rpcMethod: string;
    params?: unknown;
  }) => invokeDesktopBridgeRequest(options),
}));

vi.mock("@elizaos/logger", () => ({
  logger: { warn: loggerWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  discoverGatewayEndpoints,
  gatewayEndpointToApiBase,
  getPreferredGatewayHost,
} from "./gateway-discovery";

const ENDPOINT = {
  stableId: "gw-1",
  name: "Studio Gateway",
  host: "192.168.1.40",
  port: 2138,
  tlsEnabled: false,
  isLocal: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureAvailable.mockReturnValue(true);
  isElectrobunRuntime.mockReturnValue(false);
  getPlugins.mockReturnValue({ gateway: { plugin: {} } });
});

describe("discoverGatewayEndpoints — capability gate", () => {
  it("returns nothing without scanning when discovery is unsupported", async () => {
    isFeatureAvailable.mockReturnValue(false);

    await expect(discoverGatewayEndpoints()).resolves.toEqual([]);
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
  });
});

describe("discoverGatewayEndpoints — Capacitor native transport", () => {
  it("scans through the native plugin and tears the session down", async () => {
    const startDiscovery = vi.fn().mockResolvedValue({ gateways: [ENDPOINT] });
    const stopDiscovery = vi.fn().mockResolvedValue(undefined);
    getPlugins.mockReturnValue({
      gateway: { plugin: { startDiscovery, stopDiscovery } },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 25 })).resolves.toEqual([
      ENDPOINT,
    ]);
    expect(startDiscovery).toHaveBeenCalledWith({ timeout: 25 });
    expect(stopDiscovery).toHaveBeenCalledTimes(1);
    // Native must not be routed through the desktop bridge.
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
  });

  it("degrades to an empty scan when the native plugin throws", async () => {
    const startDiscovery = vi.fn().mockRejectedValue(new Error("mdns down"));
    const stopDiscovery = vi.fn().mockResolvedValue(undefined);
    getPlugins.mockReturnValue({
      gateway: { plugin: { startDiscovery, stopDiscovery } },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual(
      [],
    );
    expect(stopDiscovery).toHaveBeenCalledTimes(1);
  });

  it("drops malformed endpoints missing required transport fields", async () => {
    getPlugins.mockReturnValue({
      gateway: {
        plugin: {
          startDiscovery: vi.fn().mockResolvedValue({
            gateways: [ENDPOINT, { stableId: "bad", name: "No Host" }],
          }),
          stopDiscovery: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual([
      ENDPOINT,
    ]);
  });
});

describe("discoverGatewayEndpoints — Electrobun desktop transport", () => {
  beforeEach(() => {
    isElectrobunRuntime.mockReturnValue(true);
  });

  it("collects gateways that arrive after the scan window, not the empty start payload", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async ({ rpcMethod }) => {
      // The desktop backend arms the browser and returns its cold cache.
      if (rpcMethod === "gatewayStartDiscovery") {
        return { gateways: [], status: "Discovery started" };
      }
      // Responses land on the browser's `up` events during the window.
      if (rpcMethod === "gatewayGetDiscoveredGateways") {
        return { gateways: [ENDPOINT] };
      }
      return undefined;
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 10 })).resolves.toEqual([
      ENDPOINT,
    ]);

    const methods = invokeDesktopBridgeRequest.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).toContain("gatewayStartDiscovery");
    expect(methods).toContain("gatewayGetDiscoveredGateways");
    expect(methods).toContain("gatewayStopDiscovery");
  });

  it("does not arm the backend stop timer, so the collect read stays in-session", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue({ gateways: [] });

    await discoverGatewayEndpoints({ timeoutMs: 5 });

    const start = invokeDesktopBridgeRequest.mock.calls.find(
      ([options]) => options.rpcMethod === "gatewayStartDiscovery",
    );
    expect(start?.[0].params).toEqual({});
  });

  it("falls back to the start payload's warm cache when the collect read is empty", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async ({ rpcMethod }) => {
      if (rpcMethod === "gatewayStartDiscovery") {
        return { gateways: [ENDPOINT], status: "Already discovering" };
      }
      return null;
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual([
      ENDPOINT,
    ]);
  });

  it("returns empty and skips collection when no desktop bridge is present", async () => {
    invokeDesktopBridgeRequest.mockResolvedValue(null);

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual(
      [],
    );

    const methods = invokeDesktopBridgeRequest.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).not.toContain("gatewayGetDiscoveredGateways");
  });

  it("degrades to an empty scan and still stops discovery when the bridge throws", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async ({ rpcMethod }) => {
      if (rpcMethod === "gatewayStartDiscovery") {
        throw new Error("bridge closed");
      }
      return undefined;
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual(
      [],
    );
    const methods = invokeDesktopBridgeRequest.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).toContain("gatewayStopDiscovery");
  });

  it("reports a best-effort stop failure without rejecting a successful scan", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async ({ rpcMethod }) => {
      if (rpcMethod === "gatewayGetDiscoveredGateways") {
        return { gateways: [ENDPOINT] };
      }
      if (rpcMethod === "gatewayStopDiscovery") {
        throw new Error("stop failed");
      }
      return { gateways: [] };
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual([
      ENDPOINT,
    ]);
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        "[gateway-discovery] Failed to stop desktop discovery",
      );
    });
  });

  it("never consults the Capacitor plugin registry on desktop", async () => {
    const startDiscovery = vi.fn();
    getPlugins.mockReturnValue({ gateway: { plugin: { startDiscovery } } });
    invokeDesktopBridgeRequest.mockResolvedValue({ gateways: [] });

    await discoverGatewayEndpoints({ timeoutMs: 5 });

    expect(startDiscovery).not.toHaveBeenCalled();
  });
});

describe("endpoint address resolution", () => {
  it("prefers the LAN host, then the tailnet name, then the raw address", () => {
    expect(
      getPreferredGatewayHost({ ...ENDPOINT, lanHost: "studio.local" }),
    ).toBe("studio.local");
    expect(
      getPreferredGatewayHost({ ...ENDPOINT, tailnetDns: "studio.ts.net" }),
    ).toBe("studio.ts.net");
    expect(getPreferredGatewayHost(ENDPOINT)).toBe("192.168.1.40");
  });

  it("builds the api base from the preferred host and gateway port", () => {
    expect(gatewayEndpointToApiBase(ENDPOINT)).toBe("http://192.168.1.40:2138");
    expect(
      gatewayEndpointToApiBase({
        ...ENDPOINT,
        lanHost: "studio.local",
        gatewayPort: 8443,
        tlsEnabled: true,
      }),
    ).toBe("https://studio.local:8443");
  });
});

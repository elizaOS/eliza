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
const invokeDesktopBridgeRequestWithTimeout =
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
  invokeDesktopBridgeRequestWithTimeout: (options: {
    rpcMethod: string;
    params?: unknown;
  }) => invokeDesktopBridgeRequestWithTimeout(options),
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
const ok = <T>(value: T) => ({ status: "ok" as const, value });

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureAvailable.mockReturnValue(true);
  isElectrobunRuntime.mockReturnValue(false);
  getPlugins.mockReturnValue({ gateway: { plugin: {} } });
});

describe("discoverGatewayEndpoints — capability gate", () => {
  it("returns nothing without scanning when discovery is unsupported", async () => {
    isFeatureAvailable.mockReturnValue(false);

    await expect(discoverGatewayEndpoints()).resolves.toEqual({
      status: "unsupported",
      gateways: [],
      detail: "Gateway discovery is unsupported on this platform",
    });
    expect(invokeDesktopBridgeRequestWithTimeout).not.toHaveBeenCalled();
  });

  it("reports an unavailable native plugin distinctly from an empty scan", async () => {
    await expect(discoverGatewayEndpoints()).resolves.toEqual({
      status: "unavailable",
      gateways: [],
      detail: "Native gateway discovery plugin is unavailable",
    });
  });
});

describe("discoverGatewayEndpoints — Capacitor native transport", () => {
  it("scans through the native plugin and tears the session down", async () => {
    const startDiscovery = vi.fn().mockResolvedValue({ gateways: [ENDPOINT] });
    const stopDiscovery = vi.fn().mockResolvedValue(undefined);
    getPlugins.mockReturnValue({
      gateway: { plugin: { startDiscovery, stopDiscovery } },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 25 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });
    expect(startDiscovery).toHaveBeenCalledWith({ timeout: 25 });
    expect(stopDiscovery).toHaveBeenCalledTimes(1);
    // Native must not be routed through the desktop bridge.
    expect(invokeDesktopBridgeRequestWithTimeout).not.toHaveBeenCalled();
  });

  it("degrades to an empty scan when the native plugin throws", async () => {
    const startDiscovery = vi.fn().mockRejectedValue(new Error("mdns down"));
    const stopDiscovery = vi.fn().mockResolvedValue(undefined);
    getPlugins.mockReturnValue({
      gateway: { plugin: { startDiscovery, stopDiscovery } },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "failed",
      gateways: [],
      detail: "Native gateway discovery failed",
    });
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

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });
  });

  it("reports a best-effort native stop failure without rejecting the scan", async () => {
    const stopDiscovery = vi.fn().mockRejectedValue(new Error("stop failed"));
    getPlugins.mockReturnValue({
      gateway: {
        plugin: {
          startDiscovery: vi.fn().mockResolvedValue({ gateways: [ENDPOINT] }),
          stopDiscovery,
        },
      },
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(
        { error: expect.any(Error) },
        "[gateway-discovery] Failed to stop native discovery",
      );
    });
  });
});

describe("discoverGatewayEndpoints — Electrobun desktop transport", () => {
  beforeEach(() => {
    isElectrobunRuntime.mockReturnValue(true);
  });

  it("collects gateways that arrive after the scan window, not the empty start payload", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async ({ rpcMethod }) => {
        // The desktop backend arms the browser and returns its cold cache.
        if (rpcMethod === "gatewayStartDiscovery") {
          return ok({ gateways: [], status: "Discovery started" });
        }
        // Responses land on the browser's `up` events during the window.
        if (rpcMethod === "gatewayGetDiscoveredGateways") {
          return ok({ gateways: [ENDPOINT] });
        }
        return ok(undefined);
      },
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 10 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });

    const methods = invokeDesktopBridgeRequestWithTimeout.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).toContain("gatewayStartDiscovery");
    expect(methods).toContain("gatewayGetDiscoveredGateways");
    expect(methods).toContain("gatewayStopDiscovery");
  });

  it("arms a backend backstop after the UI collection window", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockResolvedValue(
      ok({ gateways: [], status: "Discovery started" }),
    );

    await discoverGatewayEndpoints({ timeoutMs: 5 });

    const start = invokeDesktopBridgeRequestWithTimeout.mock.calls.find(
      ([options]) => options.rpcMethod === "gatewayStartDiscovery",
    );
    expect(start?.[0].params).toEqual({ timeout: 505 });
  });

  it("falls back to the start payload's warm cache when collection is unavailable", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async ({ rpcMethod }) => {
        if (rpcMethod === "gatewayStartDiscovery") {
          return ok({ gateways: [ENDPOINT], status: "Already discovering" });
        }
        if (rpcMethod === "gatewayGetDiscoveredGateways") {
          return { status: "missing" };
        }
        return ok(undefined);
      },
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });
  });

  it("reports unavailable and skips collection when no desktop bridge is present", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockResolvedValue({
      status: "missing",
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "unavailable",
      gateways: [],
      detail: "Desktop gateway discovery bridge is unavailable",
    });

    const methods = invokeDesktopBridgeRequestWithTimeout.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).not.toContain("gatewayGetDiscoveredGateways");
  });

  it("reports a failed start without fabricating a healthy empty scan", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async ({ rpcMethod }) => {
        if (rpcMethod === "gatewayStartDiscovery") {
          return { status: "rejected", error: new Error("bridge closed") };
        }
        return ok(undefined);
      },
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "failed",
      gateways: [],
      detail: "Desktop gateway discovery failed to start",
    });
    const methods = invokeDesktopBridgeRequestWithTimeout.mock.calls.map(
      ([options]) => options.rpcMethod,
    );
    expect(methods).not.toContain("gatewayStopDiscovery");
  });

  it("preserves the backend's explicit unavailable status", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockResolvedValue(
      ok({
        gateways: [],
        status: "Discovery unavailable (no mDNS module)",
      }),
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "unavailable",
      gateways: [],
      detail: "Discovery unavailable (no mDNS module)",
    });
  });

  it("bounds a wedged desktop start request", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockResolvedValue({
      status: "timeout",
    });

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "timeout",
      gateways: [],
      detail: "Desktop gateway discovery did not start in time",
    });
  });

  it("reports a best-effort stop failure without rejecting a successful scan", async () => {
    invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async ({ rpcMethod }) => {
        if (rpcMethod === "gatewayStartDiscovery") {
          return ok({ gateways: [], status: "Discovery started" });
        }
        if (rpcMethod === "gatewayGetDiscoveredGateways") {
          return ok({ gateways: [ENDPOINT] });
        }
        if (rpcMethod === "gatewayStopDiscovery") {
          return { status: "rejected", error: new Error("stop failed") };
        }
        return ok(undefined);
      },
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "ok",
      gateways: [ENDPOINT],
    });
    await vi.waitFor(() => {
      expect(loggerWarn).toHaveBeenCalledWith(
        { status: "rejected", error: expect.any(Error) },
        "[gateway-discovery] Failed to stop desktop discovery",
      );
    });
  });

  it("never consults the Capacitor plugin registry on desktop", async () => {
    const startDiscovery = vi.fn();
    getPlugins.mockReturnValue({ gateway: { plugin: { startDiscovery } } });
    invokeDesktopBridgeRequestWithTimeout.mockResolvedValue(
      ok({ gateways: [], status: "Discovery started" }),
    );

    await discoverGatewayEndpoints({ timeoutMs: 5 });

    expect(startDiscovery).not.toHaveBeenCalled();
  });

  it("sanitizes LAN-supplied connection fields and carries a valid fingerprint", async () => {
    const fingerprint = "A".repeat(64);
    invokeDesktopBridgeRequestWithTimeout.mockImplementation(
      async ({ rpcMethod }) => {
        if (rpcMethod === "gatewayStartDiscovery") {
          return ok({ gateways: [], status: "Discovery started" });
        }
        if (rpcMethod === "gatewayGetDiscoveredGateways") {
          return ok({
            gateways: [
              {
                ...ENDPOINT,
                lanHost: " bad/path ",
                tailnetDns: 42,
                gatewayPort: 70_000,
                tlsFingerprintSha256: fingerprint,
              },
            ],
          });
        }
        return ok(undefined);
      },
    );

    await expect(discoverGatewayEndpoints({ timeoutMs: 5 })).resolves.toEqual({
      status: "ok",
      gateways: [
        {
          ...ENDPOINT,
          tlsFingerprintSha256: fingerprint.toLowerCase(),
        },
      ],
    });
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
    expect(gatewayEndpointToApiBase({ ...ENDPOINT, host: "fe80::1" })).toBe(
      "http://[fe80::1]:2138",
    );
  });

  it("rejects malformed direct endpoint inputs", () => {
    expect(() =>
      gatewayEndpointToApiBase({ ...ENDPOINT, host: "bad/path" }),
    ).toThrow("Gateway endpoint has no valid host");
    expect(() =>
      gatewayEndpointToApiBase({ ...ENDPOINT, gatewayPort: 70_000 }),
    ).toThrow("Gateway endpoint has no valid port");
  });
});

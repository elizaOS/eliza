/**
 * Pins iOS runtime-config resolution: mode normalization, the IOS → MOBILE →
 * legacy-ANDROID env-key precedence, fullBun detection, cloud-base fallback,
 * and device-bridge/tunnel derivation. Env is injected per case because the
 * sibling resolvers take a plain RuntimeEnv record rather than reading the
 * Vite-inlined import.meta.env of their own module, so every branch here
 * exercises the real exported functions with no fakes.
 */

import { describe, expect, it } from "vitest";
import {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  resolveCloudApiBase,
  resolveIosRuntimeConfig,
} from "./ios-runtime";

describe("resolveCloudApiBase", () => {
  it("falls back to the shipped Eliza Cloud base when no override is set", () => {
    expect(resolveCloudApiBase({})).toBe(DEFAULT_ELIZA_CLOUD_BASE);
    expect(resolveCloudApiBase({})).toBe("https://eliza.app");
  });

  it("prefers VITE_ELIZA_CLOUD_BASE over VITE_CLOUD_BASE", () => {
    expect(
      resolveCloudApiBase({
        VITE_ELIZA_CLOUD_BASE: "https://primary.example",
        VITE_CLOUD_BASE: "https://secondary.example",
      }),
    ).toBe("https://primary.example");
  });

  it("uses VITE_CLOUD_BASE when the primary key is absent", () => {
    expect(
      resolveCloudApiBase({ VITE_CLOUD_BASE: "https://legacy.example" }),
    ).toBe("https://legacy.example");
  });

  it("strips trailing slashes but keeps interior path segments", () => {
    for (const [input, expected] of [
      ["https://cloud.example/", "https://cloud.example"],
      ["https://cloud.example///", "https://cloud.example"],
      ["https://cloud.example/base///", "https://cloud.example/base"],
    ] as const) {
      expect(resolveCloudApiBase({ VITE_ELIZA_CLOUD_BASE: input })).toBe(
        expected,
      );
    }
  });

  it("skips whitespace-only overrides and falls through to the next key", () => {
    expect(
      resolveCloudApiBase({
        VITE_ELIZA_CLOUD_BASE: "   ",
        VITE_CLOUD_BASE: "https://fallback.example",
      }),
    ).toBe("https://fallback.example");
    expect(resolveCloudApiBase({ VITE_CLOUD_BASE: "\t\n" })).toBe(
      "https://eliza.app",
    );
  });
});

describe("apiBaseToDeviceBridgeUrl", () => {
  it("upgrades https to wss and replaces the whole path", () => {
    expect(apiBaseToDeviceBridgeUrl("https://mac.example/base/path")).toBe(
      "wss://mac.example/api/local-inference/device-bridge",
    );
  });

  it("downgrades http to ws", () => {
    expect(apiBaseToDeviceBridgeUrl("http://10.0.0.2:3000")).toBe(
      "ws://10.0.0.2:3000/api/local-inference/device-bridge",
    );
  });

  it("keeps the port and drops query and fragment", () => {
    expect(
      apiBaseToDeviceBridgeUrl(
        "https://mac.example:8443/sub?token=secret#frag",
      ),
    ).toBe("wss://mac.example:8443/api/local-inference/device-bridge");
  });

  it("throws on input that is not a URL", () => {
    expect(() => apiBaseToDeviceBridgeUrl("not a url")).toThrow(TypeError);
  });
});

describe("resolveIosRuntimeConfig mode resolution", () => {
  const KEY = "VITE_ELIZA_IOS_RUNTIME_MODE";

  it("maps every documented alias to its runtime mode", () => {
    const aliases = [
      ["remote", "remote-mac"],
      ["remote-mac", "remote-mac"],
      ["mac", "remote-mac"],
      ["hybrid", "cloud-hybrid"],
      ["cloud-hybrid", "cloud-hybrid"],
      ["cloud+local", "cloud-hybrid"],
      ["cloud-local", "cloud-hybrid"],
      ["local", "local"],
      ["tunnel-to-mobile", "tunnel-to-mobile"],
      ["mobile-tunnel", "tunnel-to-mobile"],
      ["host-with-tunnel", "tunnel-to-mobile"],
      ["tunneled", "tunnel-to-mobile"],
    ] as const;
    for (const [value, expected] of aliases) {
      expect(resolveIosRuntimeConfig({ [KEY]: value }).mode).toBe(expected);
    }
  });

  it("tolerates casing and surrounding whitespace", () => {
    for (const value of [
      "REMOTE-MAC",
      "Local",
      "  tunnel-to-mobile  ",
      "\ttunneled\n",
    ]) {
      expect(resolveIosRuntimeConfig({ [KEY]: value }).mode).toBe(
        resolveIosRuntimeConfig({ [KEY]: value.trim().toLowerCase() }).mode,
      );
    }
  });

  it("defaults to cloud when the key is missing, blank, or unrecognised", () => {
    for (const value of [undefined, "", "   ", "bogus", "ssh"]) {
      expect(resolveIosRuntimeConfig({ [KEY]: value }).mode).toBe("cloud");
    }
    expect(resolveIosRuntimeConfig({}).mode).toBe("cloud");
  });

  it("prefers the IOS key over MOBILE and the legacy ANDROID key", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_RUNTIME_MODE: "remote-mac",
        VITE_ELIZA_MOBILE_RUNTIME_MODE: "local",
        VITE_ELIZA_ANDROID_RUNTIME_MODE: "tunneled",
      }).mode,
    ).toBe("remote-mac");
  });

  it("falls back to MOBILE when the IOS key is absent", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_MOBILE_RUNTIME_MODE: "local",
        VITE_ELIZA_ANDROID_RUNTIME_MODE: "tunneled",
      }).mode,
    ).toBe("local");
  });

  it("still honours the legacy ANDROID key when it is all that is set", () => {
    expect(
      resolveIosRuntimeConfig({ VITE_ELIZA_ANDROID_RUNTIME_MODE: "remote" })
        .mode,
    ).toBe("remote-mac");
  });

  it("skips a blank higher-priority key and uses the lower-priority one", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_RUNTIME_MODE: "   ",
        VITE_ELIZA_MOBILE_RUNTIME_MODE: "hybrid",
      }).mode,
    ).toBe("cloud-hybrid");
  });
});

describe("resolveIosRuntimeConfig api base and token", () => {
  it("omits apiBase and apiToken entirely when unset", () => {
    const config = resolveIosRuntimeConfig({});
    expect(config.apiBase).toBeUndefined();
    expect(config.apiToken).toBeUndefined();
    expect("apiBase" in config).toBe(false);
    expect("apiToken" in config).toBe(false);
  });

  it("prefers the IOS keys over MOBILE and strips trailing slashes from apiBase", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_IOS_API_BASE: "https://a.example//",
      VITE_ELIZA_MOBILE_API_BASE: "https://b.example",
      VITE_ELIZA_IOS_API_TOKEN: " ios-token ",
    });
    expect(config.apiBase).toBe("https://a.example");
    expect(config.apiToken).toBe("ios-token");
  });

  it("uses the MOBILE keys when the IOS keys are absent", () => {
    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_MOBILE_API_BASE: "https://b.example/",
      VITE_ELIZA_MOBILE_API_TOKEN: " mobile-token ",
    });
    expect(config.apiBase).toBe("https://b.example");
    expect(config.apiToken).toBe("mobile-token");
  });
});

describe("resolveIosRuntimeConfig fullBun detection", () => {
  it("is false by default", () => {
    expect(resolveIosRuntimeConfig({}).fullBun).toBe(false);
  });

  it("accepts the truthy string forms case-insensitively", () => {
    for (const value of ["1", "true", "TRUE", "yes", "On"]) {
      expect(
        resolveIosRuntimeConfig({ VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: value })
          .fullBun,
      ).toBe(true);
    }
  });

  it("lets an explicit boolean false win before later truthy keys are read", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: false,
        VITE_ELIZA_IOS_FULL_BUN_STRICT: "true",
      }).fullBun,
    ).toBe(false);
  });

  it("keeps scanning later keys when an earlier string is not truthy", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "off",
        VITE_ELIZA_IOS_FULL_BUN_SMOKE: "1",
      }).fullBun,
    ).toBe(true);
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "maybe",
        VITE_ELIZA_IOS_FULL_BUN_STRICT: "0",
        VITE_ELIZA_IOS_FULL_BUN_SMOKE: "no",
      }).fullBun,
    ).toBe(false);
  });
});

describe("resolveIosRuntimeConfig device bridge derivation", () => {
  it("derives a wss device-bridge URL from apiBase only in cloud-hybrid mode", () => {
    const hybrid = resolveIosRuntimeConfig({
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
      VITE_ELIZA_IOS_API_BASE: "https://192.168.1.10:3124/",
    });
    expect(hybrid.deviceBridgeUrl).toBe(
      "wss://192.168.1.10:3124/api/local-inference/device-bridge",
    );

    const remoteMac = resolveIosRuntimeConfig({
      VITE_ELIZA_IOS_RUNTIME_MODE: "remote-mac",
      VITE_ELIZA_IOS_API_BASE: "https://192.168.1.10:3124/",
    });
    expect(remoteMac.deviceBridgeUrl).toBeUndefined();
  });

  it("gives the explicit device-bridge URL precedence over the derived one, in any mode", () => {
    const explicit = {
      VITE_ELIZA_DEVICE_BRIDGE_URL: " wss://bridge.example/ws ",
    };
    expect(
      resolveIosRuntimeConfig({
        ...explicit,
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
        VITE_ELIZA_IOS_API_BASE: "https://192.168.1.10:3124/",
      }).deviceBridgeUrl,
    ).toBe("wss://bridge.example/ws");
    expect(resolveIosRuntimeConfig({ ...explicit }).deviceBridgeUrl).toBe(
      "wss://bridge.example/ws",
    );
  });

  it("derives nothing in cloud-hybrid without an apiBase", () => {
    expect(
      resolveIosRuntimeConfig({ VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid" })
        .deviceBridgeUrl,
    ).toBeUndefined();
  });

  it("passes through the device-bridge token when set", () => {
    const without = resolveIosRuntimeConfig({});
    expect(without.deviceBridgeToken).toBeUndefined();
    expect("deviceBridgeToken" in without).toBe(false);
    expect(
      resolveIosRuntimeConfig({ VITE_ELIZA_DEVICE_BRIDGE_TOKEN: " tok " })
        .deviceBridgeToken,
    ).toBe("tok");
  });
});

describe("resolveIosRuntimeConfig tunnel fields", () => {
  it("passes through relay URL and pairing token trimmed, only when set", () => {
    const unset = resolveIosRuntimeConfig({});
    expect(unset.tunnelRelayUrl).toBeUndefined();
    expect(unset.tunnelPairingToken).toBeUndefined();

    const config = resolveIosRuntimeConfig({
      VITE_ELIZA_IOS_RUNTIME_MODE: "tunneled",
      VITE_ELIZA_TUNNEL_RELAY_URL: " wss://relay.example/tunnel ",
      VITE_ELIZA_TUNNEL_PAIRING_TOKEN: " pair-123 ",
    });
    expect(config.mode).toBe("tunnel-to-mobile");
    expect(config.tunnelRelayUrl).toBe("wss://relay.example/tunnel");
    expect(config.tunnelPairingToken).toBe("pair-123");
  });
});

describe("resolveIosRuntimeConfig shape and purity", () => {
  it("returns exactly the minimal contract for an empty environment", () => {
    expect(resolveIosRuntimeConfig({})).toEqual({
      mode: "cloud",
      fullBun: false,
      cloudApiBase: "https://eliza.app",
    });
  });

  it("respects the cloud-base override inside the resolved config too", () => {
    expect(
      resolveIosRuntimeConfig({
        VITE_ELIZA_CLOUD_BASE: "https://cloud.internal//",
      }).cloudApiBase,
    ).toBe("https://cloud.internal");
  });

  it("ignores unrelated keys", () => {
    const config = resolveIosRuntimeConfig({
      ELIZA_RUNTIME_MODE: "remote-mac",
      NODE_ENV: "production",
    });
    expect(config.mode).toBe("cloud");
  });

  it("is pure — repeated calls with the same env agree", () => {
    const env = {
      VITE_ELIZA_IOS_RUNTIME_MODE: "cloud-hybrid",
      VITE_ELIZA_IOS_API_BASE: "https://mac.example/",
      VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "yes",
    };
    expect(resolveIosRuntimeConfig(env)).toEqual(resolveIosRuntimeConfig(env));
  });
});

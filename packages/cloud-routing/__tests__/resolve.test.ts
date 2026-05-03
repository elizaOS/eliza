import { describe, expect, it } from "vitest";
import {
  cloudServiceApisBaseUrl,
  isCloudConnected,
  resolveCloudRoute,
  toRuntimeSettings,
} from "../src/resolve.ts";
import type { RouteSpec } from "../src/types.ts";

type SettingValue = string | boolean | number | null;

function mockRuntime(
  settings: Record<string, SettingValue>,
): { getSetting: (key: string) => SettingValue } {
  return {
    getSetting(key: string): SettingValue {
      const value = settings[key];
      return value === undefined ? null : value;
    },
  };
}

const BASE_SPEC: RouteSpec = {
  service: "birdeye",
  localKeySetting: "BIRDEYE_API_KEY",
  upstreamBaseUrl: "https://public-api.birdeye.so",
  localKeyAuth: { kind: "header", headerName: "X-API-KEY" },
};

describe("resolveCloudRoute", () => {
  describe("local-key branch", () => {
    it("returns local-key with header auth", () => {
      const rt = mockRuntime({ BIRDEYE_API_KEY: "my-key" });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("local-key");
      if (route.source !== "local-key") throw new Error("unreachable");
      expect(route.baseUrl).toBe("https://public-api.birdeye.so");
      expect(route.headers).toEqual({ "X-API-KEY": "my-key" });
      expect(route.reason).toBe("local key set: BIRDEYE_API_KEY");
    });

    it("returns local-key with bearer auth", () => {
      const spec: RouteSpec = {
        ...BASE_SPEC,
        localKeyAuth: { kind: "bearer" },
      };
      const rt = mockRuntime({ BIRDEYE_API_KEY: "bearer-key" });
      const route = resolveCloudRoute(rt as never, spec);

      expect(route.source).toBe("local-key");
      if (route.source !== "local-key") throw new Error("unreachable");
      expect(route.headers).toEqual({
        Authorization: "Bearer bearer-key",
      });
    });

    it("returns local-key with query auth (empty headers)", () => {
      const spec: RouteSpec = {
        ...BASE_SPEC,
        localKeyAuth: { kind: "query", paramName: "api_key" },
      };
      const rt = mockRuntime({ BIRDEYE_API_KEY: "query-key" });
      const route = resolveCloudRoute(rt as never, spec);

      expect(route.source).toBe("local-key");
      if (route.source !== "local-key") throw new Error("unreachable");
      expect(route.headers).toEqual({});
    });
  });

  describe("cloud-proxy branch", () => {
    it("returns cloud-proxy when cloud is connected", () => {
      const rt = mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "cloud-key-123",
        ELIZAOS_CLOUD_ENABLED: "true",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("cloud-proxy");
      if (route.source !== "cloud-proxy") throw new Error("unreachable");
      expect(route.baseUrl).toBe(
        "https://www.elizacloud.ai/api/v1/apis/birdeye",
      );
      expect(route.headers).toEqual({
        Authorization: "Bearer cloud-key-123",
      });
      expect(route.reason).toBe("cloud proxy: ELIZAOS_CLOUD_API_KEY");
    });

    it("uses ELIZAOS_CLOUD_BASE_URL override", () => {
      const rt = mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "cloud-key",
        ELIZAOS_CLOUD_ENABLED: "1",
        ELIZAOS_CLOUD_BASE_URL: "https://custom-cloud.example.com/api/v2",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("cloud-proxy");
      if (route.source !== "cloud-proxy") throw new Error("unreachable");
      expect(route.baseUrl).toBe(
        "https://custom-cloud.example.com/api/v2/apis/birdeye",
      );
    });

    it("strips trailing slashes from cloud base URL", () => {
      const rt = mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "cloud-key",
        ELIZAOS_CLOUD_ENABLED: "true",
        ELIZAOS_CLOUD_BASE_URL: "https://custom-cloud.example.com/api/v2///",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      if (route.source !== "cloud-proxy") throw new Error("unreachable");
      expect(route.baseUrl).toBe(
        "https://custom-cloud.example.com/api/v2/apis/birdeye",
      );
    });
  });

  describe("precedence", () => {
    it("local key wins when both local and cloud are set", () => {
      const rt = mockRuntime({
        BIRDEYE_API_KEY: "local-wins",
        ELIZAOS_CLOUD_API_KEY: "cloud-key",
        ELIZAOS_CLOUD_ENABLED: "true",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("local-key");
    });
  });

  describe("disabled branch", () => {
    it("returns disabled when nothing is set", () => {
      const rt = mockRuntime({});
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("disabled");
      if (route.source !== "disabled") throw new Error("unreachable");
      expect(route.reason).toBe(
        "no local BIRDEYE_API_KEY and cloud not connected",
      );
    });

    it("returns disabled when cloud key set but enabled is false", () => {
      const rt = mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "cloud-key",
        ELIZAOS_CLOUD_ENABLED: "false",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("disabled");
    });
  });

  describe("trailing-slash hygiene", () => {
    it("strips trailing slashes from upstream base URL", () => {
      const spec: RouteSpec = {
        ...BASE_SPEC,
        upstreamBaseUrl: "https://public-api.birdeye.so///",
      };
      const rt = mockRuntime({ BIRDEYE_API_KEY: "key" });
      const route = resolveCloudRoute(rt as never, spec);

      if (route.source !== "local-key") throw new Error("unreachable");
      expect(route.baseUrl).toBe("https://public-api.birdeye.so");
    });
  });

  describe("empty/whitespace settings", () => {
    it("treats empty string as unset", () => {
      const rt = mockRuntime({ BIRDEYE_API_KEY: "" });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("disabled");
    });

    it("treats whitespace-only string as unset", () => {
      const rt = mockRuntime({ BIRDEYE_API_KEY: "   " });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("disabled");
    });

    it("treats whitespace cloud API key as unset", () => {
      const rt = mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "  \t  ",
        ELIZAOS_CLOUD_ENABLED: "true",
      });
      const route = resolveCloudRoute(rt as never, BASE_SPEC);

      expect(route.source).toBe("disabled");
    });
  });
});

describe("isCloudConnected", () => {
  it("returns false when API key is set but enabled is not true/1", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "key",
      ELIZAOS_CLOUD_ENABLED: "yes",
    });
    expect(isCloudConnected(rt as never)).toBe(false);
  });

  it("returns false when API key is set but enabled is missing", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "key",
    });
    expect(isCloudConnected(rt as never)).toBe(false);
  });

  it("returns true when enabled is boolean true", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "key",
      ELIZAOS_CLOUD_ENABLED: true,
    });
    expect(isCloudConnected(rt as never)).toBe(true);
  });

  it("returns true when enabled is string '1'", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "key",
      ELIZAOS_CLOUD_ENABLED: "1",
    });
    expect(isCloudConnected(rt as never)).toBe(true);
  });

  it("returns false when API key is empty", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    expect(isCloudConnected(rt as never)).toBe(false);
  });

  it("returns false when enabled is number 0", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "key",
      ELIZAOS_CLOUD_ENABLED: 0,
    });
    expect(isCloudConnected(rt as never)).toBe(false);
  });
});

describe("toRuntimeSettings", () => {
  it("coerces bigint settings to string", () => {
    const wrapped = toRuntimeSettings({
      getSetting: () => 42n,
    });
    expect(wrapped.getSetting("x")).toBe("42");
  });
});

describe("cloudServiceApisBaseUrl", () => {
  it("returns cloud apis base + bearer when connected", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "ck",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    const got = cloudServiceApisBaseUrl(rt as never, "dexscreener");
    expect(got).not.toBeNull();
    if (!got) throw new Error("unreachable");
    expect(got.baseUrl).toBe("https://www.elizacloud.ai/api/v1/apis/dexscreener");
    expect(got.headers.Authorization).toBe("Bearer ck");
  });

  it("returns null when cloud is not connected", () => {
    const rt = mockRuntime({});
    expect(cloudServiceApisBaseUrl(rt as never, "dexscreener")).toBeNull();
  });
});

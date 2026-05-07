import { describe, expect, it } from "vitest";
import {
  cloudServiceApisBaseUrl,
  isCloudConnected,
  resolveCloudRoute,
  toRuntimeSettings,
  type RuntimeSettings,
} from "./resolve.ts";
import type { RouteSpec } from "./types.ts";

function runtime(settings: Record<string, unknown>): RuntimeSettings {
  return {
    getSetting(key) {
      const value = settings[key];
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        value === null ||
        value === undefined
      ) {
        return value;
      }
      return String(value);
    },
  };
}

const spec: RouteSpec = {
  service: "quotes",
  localKeySetting: "QUOTES_API_KEY",
  upstreamBaseUrl: "https://quotes.example.com/",
  localKeyAuth: { kind: "header", headerName: "x-api-key" },
};

describe("resolveCloudRoute", () => {
  it("prefers local keys over cloud routing", () => {
    expect(
      resolveCloudRoute(
        runtime({
          QUOTES_API_KEY: "local-secret",
          ELIZAOS_CLOUD_API_KEY: "cloud-secret",
          ELIZAOS_CLOUD_ENABLED: true,
        }),
        spec,
      ),
    ).toMatchObject({
      source: "local-key",
      baseUrl: "https://quotes.example.com",
      headers: { "x-api-key": "local-secret" },
    });
  });

  it("routes through cloud when enabled and no local key exists", () => {
    expect(
      resolveCloudRoute(
        runtime({
          ELIZAOS_CLOUD_API_KEY: "cloud-secret",
          ELIZAOS_CLOUD_ENABLED: "1",
          ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1/",
        }),
        spec,
      ),
    ).toMatchObject({
      source: "cloud-proxy",
      baseUrl: "https://cloud.example.com/api/v1/apis/quotes",
      headers: { Authorization: "Bearer cloud-secret" },
    });
  });

  it("reports disabled when neither route is available", () => {
    expect(resolveCloudRoute(runtime({}), spec)).toMatchObject({
      source: "disabled",
    });
  });
});

describe("cloud routing helpers", () => {
  it("detects enabled cloud settings and builds service URLs", () => {
    const settings = runtime({
      ELIZAOS_CLOUD_API_KEY: "cloud-secret",
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1/",
    });

    expect(isCloudConnected(settings)).toBe(true);
    expect(cloudServiceApisBaseUrl(settings, "/media/")).toEqual({
      baseUrl: "https://cloud.example.com/api/v1/apis/media",
      headers: { Authorization: "Bearer cloud-secret" },
    });
  });

  it("narrows bigint runtime settings without depending on core types", () => {
    const settings = toRuntimeSettings({
      getSetting(key) {
        return key === "COUNT" ? 10n : undefined;
      },
    });

    expect(settings.getSetting("COUNT")).toBe("10");
  });
});

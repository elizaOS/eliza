/**
 * Deterministic unit and property tests for cloud-routing policy resolution.
 *
 * The harness uses in-memory runtime settings only; no network, cloud account,
 * or live provider is required.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATURE_POLICY,
  FEATURE_IDS,
  FEATURES,
  type Feature,
  type FeaturePolicy,
  getFeature,
  isFeature,
  isFeaturePolicy,
} from "./features.ts";
import * as publicApi from "./index.ts";
import {
  cloudServiceApisBaseUrl,
  getFeaturePolicy,
  getFeaturePolicyMap,
  isCloudConnected,
  type RuntimeSettings,
  resolveCloudRoute,
  resolveFeatureCloudRoute,
  toRuntimeSettings,
} from "./resolve.ts";
import type { CloudRouteSource, RouteSpec } from "./types.ts";

function runtime(settings: Record<string, unknown>): RuntimeSettings {
  return toRuntimeSettings({
    getSetting(key) {
      return settings[key];
    },
  });
}

const spec: RouteSpec = {
  service: "quotes",
  localKeySetting: "QUOTES_API_KEY",
  upstreamBaseUrl: "https://quotes.example.com/",
  localKeyAuth: { kind: "header", headerName: "x-api-key" },
};

const bearerSpec: RouteSpec = {
  ...spec,
  localKeyAuth: { kind: "bearer" },
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

  it("uses the production cloud API base URL when no override is configured", () => {
    expect(
      resolveCloudRoute(
        runtime({
          ELIZAOS_CLOUD_API_KEY: "cloud-secret",
          ELIZAOS_CLOUD_ENABLED: true,
        }),
        spec,
      ),
    ).toMatchObject({
      source: "cloud-proxy",
      baseUrl: "https://elizacloud.ai/api/v1/apis/quotes",
      headers: { Authorization: "Bearer cloud-secret" },
    });
  });

  it("uses Authorization bearer headers for local-key bearer auth routes", () => {
    expect(
      resolveCloudRoute(
        runtime({
          QUOTES_API_KEY: "local-secret",
        }),
        bearerSpec,
      ),
    ).toMatchObject({
      source: "local-key",
      baseUrl: "https://quotes.example.com",
      headers: { Authorization: "Bearer local-secret" },
    });
  });

  it("reports disabled when neither route is available", () => {
    expect(resolveCloudRoute(runtime({}), spec)).toEqual({
      source: "disabled",
      reason: "no local QUOTES_API_KEY and cloud not connected",
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

  it.each([
    "../admin",
    "media/../../billing",
    "https://evil.test/x",
    "?redirect=https://evil.test",
    "#fragment",
    "%2e%2e",
    "",
    "   ",
  ])("rejects unsafe cloud service names: %s", (service) => {
    const settings = runtime({
      ELIZAOS_CLOUD_API_KEY: "cloud-secret",
      ELIZAOS_CLOUD_ENABLED: true,
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1/",
    });

    expect(cloudServiceApisBaseUrl(settings, service)).toBeNull();
    expect(
      resolveFeatureCloudRoute(settings, "llm", { ...spec, service }, "cloud"),
    ).toEqual({
      source: "disabled",
      reason: 'feature "llm" pinned to cloud but cloud is not connected',
      feature: "llm",
      policy: "cloud",
    });
  });

  it("fuzzes cloud service names without escaping the cloud APIs prefix", () => {
    const settings = runtime({
      ELIZAOS_CLOUD_API_KEY: "cloud-secret",
      ELIZAOS_CLOUD_ENABLED: true,
      ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1/",
    });

    fc.assert(
      fc.property(fc.string({ maxLength: 128 }), (service) => {
        const route = cloudServiceApisBaseUrl(settings, service);
        const trimmed = service.trim().replace(/^\/+|\/+$/g, "");
        const isSafeService = /^[a-zA-Z0-9_-]+$/.test(trimmed);

        if (!isSafeService) {
          expect(route).toBeNull();
          return;
        }

        expect(route).not.toBeNull();
        expect(route?.baseUrl).toBe(
          `https://cloud.example.com/api/v1/apis/${trimmed}`,
        );
        expect(new URL(route?.baseUrl ?? "").origin).toBe(
          "https://cloud.example.com",
        );
      }),
      { numRuns: 500 },
    );
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/x",
    "https://user:pass@cloud.example.com/api/v1",
    "//evil.test/api/v1",
    "https://cloud.example.com/api/v1?x=1",
    "https://cloud.example.com/api/v1#frag",
  ])("rejects unsafe cloud base URLs: %s", (baseUrl) => {
    expect(
      cloudServiceApisBaseUrl(
        runtime({
          ELIZAOS_CLOUD_API_KEY: "cloud-secret",
          ELIZAOS_CLOUD_ENABLED: true,
          ELIZAOS_CLOUD_BASE_URL: baseUrl,
        }),
        "media",
      ),
    ).toBeNull();
  });

  it.each([
    [{ ELIZAOS_CLOUD_API_KEY: "cloud-secret", ELIZAOS_CLOUD_ENABLED: "false" }],
    [{ ELIZAOS_CLOUD_API_KEY: "cloud-secret", ELIZAOS_CLOUD_ENABLED: "0" }],
    [{ ELIZAOS_CLOUD_API_KEY: "cloud-secret", ELIZAOS_CLOUD_ENABLED: false }],
    [{ ELIZAOS_CLOUD_API_KEY: "cloud-secret", ELIZAOS_CLOUD_ENABLED: 1 }],
    [{ ELIZAOS_CLOUD_API_KEY: "  ", ELIZAOS_CLOUD_ENABLED: true }],
    [{ ELIZAOS_CLOUD_API_KEY: "cloud-secret", ELIZAOS_CLOUD_ENABLED: "  " }],
  ])("does not treat malformed cloud settings as connected", (settings) => {
    expect(isCloudConnected(runtime(settings))).toBe(false);
    expect(resolveCloudRoute(runtime(settings), spec)).toEqual({
      source: "disabled",
      reason: "no local QUOTES_API_KEY and cloud not connected",
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

  it("ignores non-scalar runtime settings instead of stringifying them into secrets", () => {
    const settings = toRuntimeSettings({
      getSetting(key) {
        if (key === "OBJECT") return { secret: "value" };
        if (key === "SYMBOL") return Symbol("secret");
        if (key === "FUNCTION") return () => "secret";
        return undefined;
      },
    });

    expect(settings.getSetting("OBJECT")).toBeUndefined();
    expect(settings.getSetting("SYMBOL")).toBeUndefined();
    expect(settings.getSetting("FUNCTION")).toBeUndefined();
  });
});

describe("per-feature routing registry", () => {
  it("exports the public package contract through the barrel", () => {
    expect(publicApi.FEATURES).toBe(FEATURES);
    expect(publicApi.FEATURE_IDS).toBe(FEATURE_IDS);
    expect(publicApi.FEATURE_POLICIES).toEqual(["local", "cloud", "auto"]);
    expect(publicApi.resolveCloudRoute).toBe(resolveCloudRoute);
    expect(publicApi.resolveFeatureCloudRoute).toBe(resolveFeatureCloudRoute);
    expect(publicApi.cloudServiceApisBaseUrl).toBe(cloudServiceApisBaseUrl);
    expect(publicApi.toRuntimeSettings).toBe(toRuntimeSettings);

    const route = publicApi.resolveCloudRoute(
      runtime({ QUOTES_API_KEY: "local-secret" }),
      spec,
    );
    expect(route.source).toBe("local-key");
  });

  it("exposes the exact feature registry and setting-key contract", () => {
    expect(FEATURES.map(({ id, settingKey }) => ({ id, settingKey }))).toEqual([
      { id: "llm", settingKey: "ELIZAOS_CLOUD_ROUTING_LLM" },
      { id: "rpc", settingKey: "ELIZAOS_CLOUD_ROUTING_RPC" },
      { id: "tool_use", settingKey: "ELIZAOS_CLOUD_ROUTING_TOOL_USE" },
      { id: "embeddings", settingKey: "ELIZAOS_CLOUD_ROUTING_EMBEDDINGS" },
      { id: "media", settingKey: "ELIZAOS_CLOUD_ROUTING_MEDIA" },
      { id: "tts", settingKey: "ELIZAOS_CLOUD_ROUTING_TTS" },
      { id: "stt", settingKey: "ELIZAOS_CLOUD_ROUTING_STT" },
    ]);
    expect(FEATURE_IDS).toEqual([
      "llm",
      "rpc",
      "tool_use",
      "embeddings",
      "media",
      "tts",
      "stt",
    ]);
  });

  it("exposes a non-empty, type-tagged feature list", () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    expect(FEATURE_IDS).toContain("llm");
    expect(FEATURE_IDS).toContain("rpc");
    expect(FEATURE_IDS).toContain("tool_use");
  });

  it("every registry entry has a unique id and a unique setting key", () => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const f of FEATURES) {
      expect(ids.has(f.id)).toBe(false);
      expect(keys.has(f.settingKey)).toBe(false);
      ids.add(f.id);
      keys.add(f.settingKey);
    }
  });

  it("isFeature / isFeaturePolicy guards work", () => {
    expect(isFeature("llm")).toBe(true);
    expect(isFeature("definitely-not-a-feature")).toBe(false);
    expect(isFeaturePolicy("local")).toBe(true);
    expect(isFeaturePolicy("cloud")).toBe(true);
    expect(isFeaturePolicy("auto")).toBe(true);
    expect(isFeaturePolicy("bogus")).toBe(false);
    expect(isFeaturePolicy(42)).toBe(false);
  });

  it("getFeature returns the definition for known ids and null otherwise", () => {
    const llm = getFeature("llm");
    expect(llm).not.toBeNull();
    expect(llm?.settingKey).toBe("ELIZAOS_CLOUD_ROUTING_LLM");
    expect(getFeature("unknown")).toBeNull();
  });
});

describe("getFeaturePolicy", () => {
  it("reads every registered feature setting key", () => {
    for (const feature of FEATURES) {
      expect(
        getFeaturePolicy(
          runtime({ [feature.settingKey]: "cloud" }),
          feature.id,
        ),
      ).toBe("cloud");
    }
  });

  it("returns the persisted policy for a known feature", () => {
    expect(
      getFeaturePolicy(runtime({ ELIZAOS_CLOUD_ROUTING_LLM: "local" }), "llm"),
    ).toBe("local");
    expect(
      getFeaturePolicy(runtime({ ELIZAOS_CLOUD_ROUTING_RPC: "cloud" }), "rpc"),
    ).toBe("cloud");
    expect(
      getFeaturePolicy(
        runtime({ ELIZAOS_CLOUD_ROUTING_TOOL_USE: "auto" }),
        "tool_use",
      ),
    ).toBe("auto");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(
      getFeaturePolicy(
        runtime({ ELIZAOS_CLOUD_ROUTING_LLM: "  CLOUD  " }),
        "llm",
      ),
    ).toBe("cloud");
  });

  it("falls back to the default policy when the value is invalid", () => {
    expect(
      getFeaturePolicy(
        runtime({ ELIZAOS_CLOUD_ROUTING_LLM: "nonsense" }),
        "llm",
      ),
    ).toBe(DEFAULT_FEATURE_POLICY);
  });

  it("falls back to the default policy when the value is unset", () => {
    expect(getFeaturePolicy(runtime({}), "llm")).toBe(DEFAULT_FEATURE_POLICY);
  });

  it("falls back to the default policy for unknown feature ids", () => {
    expect(
      getFeaturePolicy(
        runtime({ ELIZAOS_CLOUD_ROUTING_LLM: "local" }),
        "unknown-feature",
      ),
    ).toBe(DEFAULT_FEATURE_POLICY);
  });
});

describe("getFeaturePolicyMap", () => {
  it("returns one entry per registered feature with defaults applied", () => {
    const map = getFeaturePolicyMap(runtime({}));
    expect(Object.keys(map).sort()).toEqual([...FEATURE_IDS].sort());
    for (const id of FEATURE_IDS) {
      expect(map[id]).toBe(DEFAULT_FEATURE_POLICY);
    }
  });

  it("merges persisted values with defaults", () => {
    const map = getFeaturePolicyMap(
      runtime({
        ELIZAOS_CLOUD_ROUTING_LLM: "cloud",
        ELIZAOS_CLOUD_ROUTING_RPC: "local",
        ELIZAOS_CLOUD_ROUTING_TOOL_USE: "auto",
      }),
    );
    expect(map.llm).toBe("cloud");
    expect(map.rpc).toBe("local");
    expect(map.tool_use).toBe("auto");
    expect(map.embeddings).toBe(DEFAULT_FEATURE_POLICY);
  });
});

interface ResolveFixture {
  label: string;
  feature: Feature;
  policy: FeaturePolicy;
  localKeySet: boolean;
  cloudConnected: boolean;
  expectSource: CloudRouteSource;
}

const FIXTURES: ResolveFixture[] = [
  {
    label: "policy=local + local key set + cloud connected → local-key",
    feature: "llm",
    policy: "local",
    localKeySet: true,
    cloudConnected: true,
    expectSource: "local-key",
  },
  {
    label: "policy=local + local key set + cloud disconnected → local-key",
    feature: "llm",
    policy: "local",
    localKeySet: true,
    cloudConnected: false,
    expectSource: "local-key",
  },
  {
    label:
      "policy=local + no local key + cloud connected → disabled (no cloud fallback)",
    feature: "llm",
    policy: "local",
    localKeySet: false,
    cloudConnected: true,
    expectSource: "disabled",
  },
  {
    label: "policy=local + no local key + cloud disconnected → disabled",
    feature: "llm",
    policy: "local",
    localKeySet: false,
    cloudConnected: false,
    expectSource: "disabled",
  },
  {
    label:
      "policy=cloud + local key set + cloud connected → cloud-proxy (ignores local key)",
    feature: "rpc",
    policy: "cloud",
    localKeySet: true,
    cloudConnected: true,
    expectSource: "cloud-proxy",
  },
  {
    label:
      "policy=cloud + local key set + cloud disconnected → disabled (no local fallback)",
    feature: "rpc",
    policy: "cloud",
    localKeySet: true,
    cloudConnected: false,
    expectSource: "disabled",
  },
  {
    label: "policy=cloud + no local key + cloud connected → cloud-proxy",
    feature: "rpc",
    policy: "cloud",
    localKeySet: false,
    cloudConnected: true,
    expectSource: "cloud-proxy",
  },
  {
    label: "policy=cloud + no local key + cloud disconnected → disabled",
    feature: "rpc",
    policy: "cloud",
    localKeySet: false,
    cloudConnected: false,
    expectSource: "disabled",
  },
  {
    label:
      "policy=auto + local key set + cloud connected → local-key (local wins)",
    feature: "tool_use",
    policy: "auto",
    localKeySet: true,
    cloudConnected: true,
    expectSource: "local-key",
  },
  {
    label: "policy=auto + local key set + cloud disconnected → local-key",
    feature: "tool_use",
    policy: "auto",
    localKeySet: true,
    cloudConnected: false,
    expectSource: "local-key",
  },
  {
    label: "policy=auto + no local key + cloud connected → cloud-proxy",
    feature: "tool_use",
    policy: "auto",
    localKeySet: false,
    cloudConnected: true,
    expectSource: "cloud-proxy",
  },
  {
    label: "policy=auto + no local key + cloud disconnected → disabled",
    feature: "tool_use",
    policy: "auto",
    localKeySet: false,
    cloudConnected: false,
    expectSource: "disabled",
  },
];

describe("resolveFeatureCloudRoute", () => {
  for (const fixture of FIXTURES) {
    it(fixture.label, () => {
      const def = getFeature(fixture.feature);
      expect(def).not.toBeNull();
      const settings: Record<string, unknown> = {
        ...(def ? { [def.settingKey]: fixture.policy } : {}),
        ...(fixture.localKeySet
          ? { [spec.localKeySetting]: "local-secret" }
          : {}),
        ...(fixture.cloudConnected
          ? {
              ELIZAOS_CLOUD_API_KEY: "cloud-secret",
              ELIZAOS_CLOUD_ENABLED: true,
              ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1",
            }
          : {}),
      };

      const route = resolveFeatureCloudRoute(
        runtime(settings),
        fixture.feature,
        spec,
      );

      expect(route.source).toBe(fixture.expectSource);
      expect(route.feature).toBe(fixture.feature);
      expect(route.policy).toBe(fixture.policy);

      if (route.source === "local-key") {
        expect(route.baseUrl).toBe("https://quotes.example.com");
        expect(route.headers).toEqual({ "x-api-key": "local-secret" });
      } else if (route.source === "cloud-proxy") {
        expect(route.baseUrl).toBe(
          "https://cloud.example.com/api/v1/apis/quotes",
        );
        expect(route.headers).toEqual({ Authorization: "Bearer cloud-secret" });
      }
    });
  }

  it("reads the policy from settings when no override is passed", () => {
    const settings = runtime({
      ELIZAOS_CLOUD_ROUTING_LLM: "cloud",
      [spec.localKeySetting]: "local-secret",
      ELIZAOS_CLOUD_API_KEY: "cloud-secret",
      ELIZAOS_CLOUD_ENABLED: true,
    });

    const route = resolveFeatureCloudRoute(settings, "llm", spec);
    expect(route.source).toBe("cloud-proxy");
    expect(route.policy).toBe("cloud");
  });

  it("policyOverride beats the persisted setting", () => {
    const settings = runtime({
      ELIZAOS_CLOUD_ROUTING_LLM: "cloud",
      [spec.localKeySetting]: "local-secret",
    });
    const route = resolveFeatureCloudRoute(settings, "llm", spec, "local");
    expect(route.source).toBe("local-key");
    expect(route.policy).toBe("local");
  });

  it("uses Authorization bearer headers for feature-routed local keys", () => {
    const route = resolveFeatureCloudRoute(
      runtime({
        [bearerSpec.localKeySetting]: "local-secret",
        ELIZAOS_CLOUD_ROUTING_LLM: "local",
      }),
      "llm",
      bearerSpec,
    );

    expect(route).toMatchObject({
      source: "local-key",
      feature: "llm",
      policy: "local",
      baseUrl: "https://quotes.example.com",
      headers: { Authorization: "Bearer local-secret" },
    });
  });

  it("unknown feature ids fall back to auto without throwing", () => {
    const settings = runtime({
      [spec.localKeySetting]: "local-secret",
    });
    const route = resolveFeatureCloudRoute(
      settings,
      "not-a-real-feature",
      spec,
    );
    expect(route.source).toBe("local-key");
    expect(route.policy).toBe(DEFAULT_FEATURE_POLICY);
    expect(route.feature).toBe("not-a-real-feature");
  });

  it("preserves the feature id and policy in every result branch", () => {
    const disabled = resolveFeatureCloudRoute(
      runtime({}),
      "llm",
      spec,
      "cloud",
    );
    expect(disabled).toMatchObject({
      source: "disabled",
      feature: "llm",
      policy: "cloud",
    });
    expect(disabled.reason).toContain("llm");
  });

  it("dispatches off the registry without hard-coding feature ids", () => {
    for (const id of FEATURE_IDS) {
      const route = resolveFeatureCloudRoute(runtime({}), id, spec, "auto");
      expect(route.feature).toBe(id);
      expect(route.policy).toBe("auto");
    }
  });
});

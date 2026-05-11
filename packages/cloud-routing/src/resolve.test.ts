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

describe("per-feature routing registry", () => {
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
    // Persisted value for a key the registry doesn't know about is ignored.
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
  expectSource: "local-key" | "cloud-proxy" | "disabled";
}

/**
 * The full truth table for per-feature resolution. Three policies x
 * two local-key states x two cloud-connection states = 12 cases.
 */
const FIXTURES: ResolveFixture[] = [
  // policy=local
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
  // policy=cloud
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
  // policy=auto
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
      // Registry must contain every feature we're testing.
      expect(def).not.toBeNull();
      const settings: Record<string, unknown> = {
        // Per-feature policy comes from the registry-defined setting key.
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
    // disabled branch
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
    // Resolving every registered feature with policy=auto must not throw
    // and must echo the feature id back. This is the contract that lets
    // us add features without touching resolve.ts.
    for (const id of FEATURE_IDS) {
      const route = resolveFeatureCloudRoute(runtime({}), id, spec, "auto");
      expect(route.feature).toBe(id);
      expect(route.policy).toBe("auto");
    }
  });
});

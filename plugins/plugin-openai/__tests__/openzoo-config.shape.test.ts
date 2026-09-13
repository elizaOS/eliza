/**
 * Shape tests for OpenZoo-mode detection and usage-provider attribution.
 * Mocked runtime, no network. Mirrors cerebras-config.shape.test.ts: the
 * point is that requests handled and billed by OpenZoo (hosted host, or the
 * local `npx openzoo` gateway on :8402) stop being attributed to "openai".
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getApiKey,
  getBaseURL,
  getUsageProvider,
  isCerebrasMode,
  providerForEndpoint,
} from "../utils/config";

function buildRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => (key in settings ? (settings[key] ?? null) : null)),
  } as IAgentRuntime;
}

const ENV_KEYS = [
  "ELIZA_PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENZOO_BASE_URL",
  "CEREBRAS_BASE_URL",
  "EVOLINK_BASE_URL",
  "EVOLINK_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("providerForEndpoint host hardening", () => {
  // These assertions aim at the LIVE classifier getUsageProvider consults —
  // the mutants they exist to kill (includes-vs-endsWith, apex arm, gateway
  // port, hostile-input catch) must die on the code path that runs.
  it("classifies the hosted endpoint, apex domain, and ported host as openzoo", () => {
    expect(providerForEndpoint("https://api.openzoo.fun/v1")).toBe("openzoo");
    expect(providerForEndpoint("https://openzoo.fun/v1")).toBe("openzoo");
    expect(providerForEndpoint("https://openzoo.fun:8402/v1")).toBe("openzoo");
  });

  it("classifies the local gateway by exact host and port", () => {
    expect(providerForEndpoint("http://localhost:8402/v1")).toBe("openzoo");
    expect(providerForEndpoint("http://127.0.0.1:8402")).toBe("openzoo");
    expect(providerForEndpoint("http://localhost:84020/v1")).not.toBe("openzoo");
    expect(providerForEndpoint("http://localhost:9999/v1")).toBe("unknown");
  });

  it("does not classify lookalike hosts as openzoo", () => {
    expect(providerForEndpoint("https://notopenzoo.fun/v1")).toBe("unknown");
    expect(providerForEndpoint("https://openzoo.funhouse.example.com/v1")).toBe("unknown");
    expect(providerForEndpoint("https://openzoo.fun.evil.com/v1")).toBe("unknown");
  });

  it("does not classify names smuggled into paths, queries, or fragments", () => {
    expect(providerForEndpoint("https://evil.example.com/a.openzoo.fun/v1")).toBe("unknown");
    expect(providerForEndpoint("https://evil.example.com/?redirect=https://api.openzoo.fun/")).toBe(
      "unknown"
    );
    expect(providerForEndpoint("https://api.openai.com/v1#.openzoo.fun/")).toBe("openai");
  });

  it("returns unknown for hostile input, never a provider", () => {
    expect(providerForEndpoint("not a url")).toBe("unknown");
  });

  it("classifies the siblings and definitive OpenAI hosts", () => {
    expect(providerForEndpoint("https://api.cerebras.ai/v1")).toBe("cerebras");
    expect(providerForEndpoint("https://direct.evolink.ai/v1")).toBe("evolink");
    expect(providerForEndpoint("https://api.openai.com/v1")).toBe("openai");
  });
});

describe("key and endpoint belong to the same vendor", () => {
  // A contradictory environment must fail loudly (no key resolves, so the
  // client constructor throws) rather than send one vendor's key to another.
  it("does not select a sibling key when the declaration contradicts it", () => {
    const cerebras = buildRuntime({ ELIZA_PROVIDER: "openai", CEREBRAS_API_KEY: "csk-stale" });
    expect(isCerebrasMode(cerebras)).toBe(false);
    expect(getApiKey(cerebras)).toBeUndefined();

    const evolink = buildRuntime({ ELIZA_PROVIDER: "openai", EVOLINK_API_KEY: "evk-stale" });
    expect(getApiKey(evolink)).toBeUndefined();

    const cross = buildRuntime({ ELIZA_PROVIDER: "evolink", CEREBRAS_API_KEY: "csk-stale" });
    expect(isCerebrasMode(cross)).toBe(false);
    expect(getApiKey(cross)).toBeUndefined();
  });

  it("ignores sibling lookalikes smuggled into the URL's query or fragment", () => {
    // The predicates classify by PARSED host via providerForEndpoint, so a
    // cerebras.ai/evolink.ai string in a query or fragment must not flip the
    // key or the label while the request goes elsewhere with the OpenAI key.
    const query = buildRuntime({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://proxy.example.com/v1?next=.cerebras.ai/",
    });
    expect(isCerebrasMode(query)).toBe(false);
    expect(getUsageProvider(query)).toBe("openai");
    expect(getApiKey(query)).toBe("sk-openai");

    const fragment = buildRuntime({
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://proxy.example.com/v1#.evolink.ai/",
    });
    expect(getUsageProvider(fragment)).toBe("openai");
    expect(getApiKey(fragment)).toBe("sk-openai");
  });

  it("keeps key-alias inference for an undeclared environment", () => {
    const bare = buildRuntime({ CEREBRAS_API_KEY: "csk-live" });
    expect(isCerebrasMode(bare)).toBe(true);
    expect(getApiKey(bare)).toBe("csk-live");
  });
});

describe("attribution/endpoint agreement ratchet", () => {
  // The property this module is about: for every settings combination,
  // getUsageProvider names the service that the endpoint getBaseURL resolves
  // to. Table-driven so the next precedence change has to keep it true.
  const CASES: Array<{
    name: string;
    settings: Record<string, string>;
    endpointHost: string;
    provider: string;
  }> = [
    {
      name: "explicit openai + cerebras base URL",
      settings: { ELIZA_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.cerebras.ai/v1" },
      endpointHost: "api.cerebras.ai",
      provider: "cerebras",
    },
    {
      name: "explicit openai + stray EVOLINK_API_KEY",
      settings: { ELIZA_PROVIDER: "openai", EVOLINK_API_KEY: "evk-stale" },
      endpointHost: "api.openai.com",
      provider: "openai",
    },
    {
      name: "explicit openai + stray CEREBRAS_API_KEY",
      settings: { ELIZA_PROVIDER: "openai", CEREBRAS_API_KEY: "csk-stale" },
      endpointHost: "api.openai.com",
      provider: "openai",
    },
    {
      name: "explicit evolink + stray CEREBRAS_API_KEY",
      settings: { ELIZA_PROVIDER: "evolink", CEREBRAS_API_KEY: "csk-stale" },
      endpointHost: "direct.evolink.ai",
      provider: "evolink",
    },
    {
      name: "explicit openai + openzoo base URL",
      settings: { ELIZA_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.openzoo.fun/v1" },
      endpointHost: "api.openzoo.fun",
      provider: "openzoo",
    },
    {
      name: "explicit openzoo + openai base URL (explicit URL outranks the default)",
      settings: { ELIZA_PROVIDER: "openzoo", OPENAI_BASE_URL: "https://api.openai.com/v1" },
      endpointHost: "api.openai.com",
      provider: "openai",
    },
    {
      name: "bare explicit openzoo routes to the gateway",
      settings: { ELIZA_PROVIDER: "openzoo" },
      endpointHost: "localhost",
      provider: "openzoo",
    },
    {
      name: "explicit openzoo honours OPENZOO_BASE_URL and keeps attribution",
      settings: { ELIZA_PROVIDER: "openzoo", OPENZOO_BASE_URL: "http://localhost:9999/v1" },
      endpointHost: "localhost",
      provider: "openzoo",
    },
    {
      name: "custom CEREBRAS_BASE_URL on a non-vendor host keeps cerebras attribution",
      settings: { CEREBRAS_API_KEY: "csk-live", CEREBRAS_BASE_URL: "https://proxy.example.com/v1" },
      endpointHost: "proxy.example.com",
      provider: "cerebras",
    },
    {
      name: "custom EVOLINK_BASE_URL on a non-vendor host keeps evolink attribution",
      settings: { EVOLINK_API_KEY: "evk-live", EVOLINK_BASE_URL: "https://proxy.example.com/v1" },
      endpointHost: "proxy.example.com",
      provider: "evolink",
    },
    {
      name: "key-alias inference still applies when nothing is declared",
      settings: { CEREBRAS_API_KEY: "csk-live" },
      endpointHost: "api.cerebras.ai",
      provider: "cerebras",
    },
  ];

  for (const c of CASES) {
    it(`agrees for ${c.name}`, () => {
      const runtime = buildRuntime(c.settings);
      const endpoint = new URL(getBaseURL(runtime));
      expect(endpoint.hostname).toBe(c.endpointHost);
      expect(getUsageProvider(runtime)).toBe(c.provider);
    });
  }
});

describe("OPENZOO_BASE_URL override", () => {
  it("wins over the gateway default, port included, and keeps openzoo attribution", () => {
    const runtime = buildRuntime({
      ELIZA_PROVIDER: "openzoo",
      OPENZOO_BASE_URL: "http://localhost:9999/v1",
    });
    expect(getBaseURL(runtime)).toBe("http://localhost:9999/v1");
    expect(getUsageProvider(runtime)).toBe("openzoo");
  });

  it("treats ELIZA_PROVIDER case-insensitively end to end", () => {
    const runtime = buildRuntime({ ELIZA_PROVIDER: "OpenZoo" });
    expect(getBaseURL(runtime)).toBe("http://localhost:8402/v1");
    expect(getUsageProvider(runtime)).toBe("openzoo");
  });
});

describe("getUsageProvider with OpenZoo", () => {
  it("attributes hosted and gateway requests to openzoo", () => {
    expect(getUsageProvider(buildRuntime({ OPENAI_BASE_URL: "https://api.openzoo.fun/v1" }))).toBe(
      "openzoo"
    );
    expect(getUsageProvider(buildRuntime({ OPENAI_BASE_URL: "http://127.0.0.1:8402/v1" }))).toBe(
      "openzoo"
    );
  });

  it("still attributes cerebras and plain openai correctly", () => {
    expect(getUsageProvider(buildRuntime({ ELIZA_PROVIDER: "cerebras" }))).toBe("cerebras");
    expect(getUsageProvider(buildRuntime({ OPENAI_API_KEY: "sk-test" }))).toBe("openai");
  });

  it("attributes a malformed base URL to openai, never a provider", () => {
    expect(getUsageProvider(buildRuntime({ OPENAI_BASE_URL: "not a url" }))).toBe("openai");
  });

  it("keeps endpoint and attribution in agreement for a bare ELIZA_PROVIDER=openzoo", () => {
    const runtime = buildRuntime({ ELIZA_PROVIDER: "openzoo" });
    expect(getUsageProvider(runtime)).toBe("openzoo");
    expect(getBaseURL(runtime)).toBe("http://localhost:8402/v1");
  });

  it("lets an explicit ELIZA_PROVIDER win over a stray sibling key, in routing and attribution", () => {
    expect(
      getUsageProvider(
        buildRuntime({
          ELIZA_PROVIDER: "openzoo",
          CEREBRAS_API_KEY: "csk-stale",
        })
      )
    ).toBe("openzoo");
    expect(
      getUsageProvider(
        buildRuntime({
          ELIZA_PROVIDER: "openzoo",
          EVOLINK_API_KEY: "evk-stale",
        })
      )
    ).toBe("openzoo");
  });
});

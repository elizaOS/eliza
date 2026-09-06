// Verifies vast-endpoints map validation: malformed present config fails fast
// with a redacted error, while absence and valid precedence/aliasing resolve
// unchanged. Uses the real catalog with an injected env reader (deterministic).
import { describe, expect, test } from "bun:test";
import {
  resolveVastEndpointConfig,
  resolveVastFallbackModel,
  VastEndpointConfigError,
} from "./vast-endpoints";

const SECRET = "sk-vast-super-secret-token-DO-NOT-LEAK";

/** Build an env reader from a plain map; missing keys read as null. */
function readerFrom(env: Record<string, string | undefined>): (name: string) => string | null {
  return (name: string) => env[name] ?? null;
}

describe("resolveVastEndpointConfig endpoint-map validation", () => {
  test("absent VAST_ENDPOINTS_JSON falls back to global config (unchanged)", () => {
    const config = resolveVastEndpointConfig(
      "vast/eliza-1-27b",
      readerFrom({
        VAST_BASE_URL: "https://global.example.com/",
        VAST_API_KEY: "global-key",
      }),
    );
    expect(config).not.toBeNull();
    expect(config?.source).toBe("global");
    expect(config?.baseUrl).toBe("https://global.example.com");
    expect(config?.apiKey).toBe("global-key");
  });

  test("valid VAST_ENDPOINTS_JSON resolves dedicated endpoint precedence (unchanged)", () => {
    const config = resolveVastEndpointConfig(
      "vast/eliza-1-27b",
      readerFrom({
        VAST_ENDPOINTS_JSON: JSON.stringify({
          "vast/eliza-1-27b": {
            baseUrl: "https://dedicated.example.com/",
            apiKey: "dedicated-key",
            apiModelId: "eliza-27b-remote",
          },
        }),
        VAST_BASE_URL: "https://global.example.com",
        VAST_API_KEY: "global-key",
      }),
    );
    expect(config?.source).toBe("json");
    expect(config?.baseUrl).toBe("https://dedicated.example.com");
    expect(config?.apiKey).toBe("dedicated-key");
    expect(config?.apiModelId).toBe("eliza-27b-remote");
  });

  test("string endpoint entry is accepted and used as base URL (unchanged)", () => {
    const config = resolveVastEndpointConfig(
      "vast/eliza-1-27b",
      readerFrom({
        VAST_ENDPOINTS_JSON: JSON.stringify({
          "vast/eliza-1-27b": "https://string-endpoint.example.com/",
        }),
        VAST_API_KEY: "global-key",
      }),
    );
    expect(config?.source).toBe("json");
    expect(config?.baseUrl).toBe("https://string-endpoint.example.com");
  });

  test("malformed JSON present throws an actionable VastEndpointConfigError", () => {
    const reader = readerFrom({ VAST_ENDPOINTS_JSON: `{ "vast/eliza-1-27b": ${SECRET} }` });
    expect(() => resolveVastEndpointConfig("vast/eliza-1-27b", reader)).toThrow(
      VastEndpointConfigError,
    );
    try {
      resolveVastEndpointConfig("vast/eliza-1-27b", reader);
    } catch (error) {
      expect(error).toBeInstanceOf(VastEndpointConfigError);
      const message = (error as Error).message;
      expect(message).toContain("VAST_ENDPOINTS_JSON");
      expect(message).toContain("not valid JSON");
      // Redaction: the raw (secret-bearing) value must never appear.
      expect(message).not.toContain(SECRET);
    }
  });

  test("valid JSON but non-object (array) throws a clear error", () => {
    const reader = readerFrom({ VAST_ENDPOINTS_JSON: JSON.stringify(["not", "a", "map"]) });
    expect(() => resolveVastEndpointConfig("vast/eliza-1-27b", reader)).toThrow(
      /VAST_ENDPOINTS_JSON is set but is not a JSON object/,
    );
  });

  test("valid JSON but entry value of wrong type throws a clear error", () => {
    const reader = readerFrom({
      VAST_ENDPOINTS_JSON: JSON.stringify({ "vast/eliza-1-27b": 12345 }),
    });
    expect(() => resolveVastEndpointConfig("vast/eliza-1-27b", reader)).toThrow(
      /entry for "vast\/eliza-1-27b" must be a string base URL or an object/,
    );
  });

  test("object entry with a non-string field throws and does not leak the value", () => {
    const reader = readerFrom({
      VAST_ENDPOINTS_JSON: JSON.stringify({
        "vast/eliza-1-27b": { baseUrl: { host: SECRET } },
      }),
    });
    try {
      resolveVastEndpointConfig("vast/eliza-1-27b", reader);
      throw new Error("expected VastEndpointConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(VastEndpointConfigError);
      const message = (error as Error).message;
      expect(message).toContain('invalid "baseUrl" field');
      expect(message).not.toContain(SECRET);
    }
  });
});

describe("resolveVastFallbackModel fallback-map validation", () => {
  test("absent fallback map uses the built-in alias chain (unchanged)", () => {
    const fallback = resolveVastFallbackModel(
      "vast/eliza-1-27b",
      readerFrom({
        VAST_ENDPOINTS_JSON: JSON.stringify({
          "vast/eliza-1-9b": "https://nine-b.example.com",
        }),
        VAST_API_KEY: "global-key",
      }),
    );
    expect(fallback).toBe("vast/eliza-1-9b");
  });

  test("valid fallback map overrides the alias chain (unchanged)", () => {
    const fallback = resolveVastFallbackModel(
      "vast/eliza-1-27b",
      readerFrom({
        VAST_FALLBACK_MODEL_MAP_JSON: JSON.stringify({ "vast/eliza-1-27b": "vast/eliza-1-2b" }),
        VAST_ENDPOINTS_JSON: JSON.stringify({
          "vast/eliza-1-2b": "https://two-b.example.com",
        }),
        VAST_API_KEY: "global-key",
      }),
    );
    expect(fallback).toBe("vast/eliza-1-2b");
  });

  test("malformed fallback map present throws VastEndpointConfigError", () => {
    const reader = readerFrom({ VAST_FALLBACK_MODEL_MAP_JSON: "{ not json" });
    expect(() => resolveVastFallbackModel("vast/eliza-1-27b", reader)).toThrow(
      VastEndpointConfigError,
    );
  });

  test("fallback map with non-string entry throws a clear error", () => {
    const reader = readerFrom({
      VAST_FALLBACK_MODEL_MAP_JSON: JSON.stringify({ "vast/eliza-1-27b": { model: "x" } }),
    });
    expect(() => resolveVastFallbackModel("vast/eliza-1-27b", reader)).toThrow(
      /must map to a fallback model id string/,
    );
  });

  test("empty-string env var is treated as absent (legal), not malformed", () => {
    const reader = readerFrom({
      VAST_ENDPOINTS_JSON: "   ",
      VAST_BASE_URL: "https://global.example.com",
      VAST_API_KEY: "global-key",
    });
    const config = resolveVastEndpointConfig("vast/eliza-1-27b", reader);
    expect(config?.source).toBe("global");
  });
});

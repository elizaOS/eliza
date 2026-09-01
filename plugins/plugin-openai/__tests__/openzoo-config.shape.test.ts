/**
 * Shape tests for OpenZoo-mode detection and usage-provider attribution.
 * Mocked runtime, no network. Mirrors cerebras-config.shape.test.ts: the
 * point is that requests handled and billed by OpenZoo (hosted host, or the
 * local `npx openzoo` gateway on :8402) stop being attributed to "openai".
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBaseURL, getUsageProvider, isOpenZooMode } from "../utils/config";

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

describe("isOpenZooMode", () => {
  it("is on for the hosted endpoint", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.openzoo.fun/v1",
    });
    expect(isOpenZooMode(runtime)).toBe(true);
  });

  it("is on for the local gateway address", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "http://localhost:8402/v1",
    });
    expect(isOpenZooMode(runtime)).toBe(true);
  });

  it("is on for ELIZA_PROVIDER=openzoo regardless of URL", () => {
    const runtime = buildRuntime({ ELIZA_PROVIDER: "openzoo" });
    expect(isOpenZooMode(runtime)).toBe(true);
  });

  it("is on for the apex domain and a ported host", () => {
    expect(isOpenZooMode(buildRuntime({ OPENAI_BASE_URL: "https://openzoo.fun/v1" }))).toBe(true);
    expect(isOpenZooMode(buildRuntime({ OPENAI_BASE_URL: "https://openzoo.fun:8402/v1" }))).toBe(
      true
    );
  });

  it("is on for ELIZA_PROVIDER=openzoo case-insensitively", () => {
    expect(isOpenZooMode(buildRuntime({ ELIZA_PROVIDER: "OpenZoo" }))).toBe(true);
  });

  it("is off for plain OpenAI and for lookalike hosts", () => {
    expect(isOpenZooMode(buildRuntime({ OPENAI_BASE_URL: "https://api.openai.com/v1" }))).toBe(
      false
    );
    expect(isOpenZooMode(buildRuntime({ OPENAI_BASE_URL: "https://notopenzoo.fun/v1" }))).toBe(
      false
    );
    expect(
      isOpenZooMode(
        buildRuntime({
          OPENAI_BASE_URL: "https://openzoo.funhouse.example.com/v1",
        })
      )
    ).toBe(false);
    expect(isOpenZooMode(buildRuntime({}))).toBe(false);
  });

  it("is off when the name only appears in a path, query, or fragment", () => {
    expect(
      isOpenZooMode(
        buildRuntime({
          OPENAI_BASE_URL: "https://evil.example.com/a.openzoo.fun/v1",
        })
      )
    ).toBe(false);
    expect(
      isOpenZooMode(
        buildRuntime({
          OPENAI_BASE_URL: "https://evil.example.com/?redirect=https://api.openzoo.fun/",
        })
      )
    ).toBe(false);
    expect(
      isOpenZooMode(
        buildRuntime({
          OPENAI_BASE_URL: "https://api.openai.com/v1#.openzoo.fun/",
        })
      )
    ).toBe(false);
  });

  it("is off for a non-gateway localhost port", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    });
    expect(isOpenZooMode(runtime)).toBe(false);
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

  it("holds the malformed-URL catch branch to false", () => {
    expect(isOpenZooMode(buildRuntime({ OPENAI_BASE_URL: "not a url" }))).toBe(false);
  });

  it("keeps endpoint and attribution in agreement for a bare ELIZA_PROVIDER=openzoo", () => {
    const runtime = buildRuntime({ ELIZA_PROVIDER: "openzoo" });
    expect(getUsageProvider(runtime)).toBe("openzoo");
    expect(getBaseURL(runtime)).toBe("http://localhost:8402/v1");
  });

  it("lets an explicit ELIZA_PROVIDER win over a stray sibling key", () => {
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

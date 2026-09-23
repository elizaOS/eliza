/** Unit tests for the config resolvers, exercising setting-vs-env precedence, model/base-URL defaults, and the deprecated CoT-budget-to-thinking mapping against a stub runtime (no live API). */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getApiKeyOptional,
  getBaseURL,
  getCoTBudget,
  getLargeModel,
  getSmallModel,
  getThinkingConfig,
} from "../utils/config";

type Settings = Record<string, string | undefined>;

function runtimeWith(settings: Settings): IAgentRuntime {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as unknown as IAgentRuntime;
}

const originalEnv = { ...process.env };
const originalDocument = globalThis.document;

afterEach(() => {
  process.env = { ...originalEnv };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
});

describe("z.ai config", () => {
  it("reads the canonical ZAI_API_KEY setting", () => {
    const runtime = runtimeWith({ ZAI_API_KEY: "canonical-key" });

    expect(getApiKeyOptional(runtime)).toBe("canonical-key");
  });

  it("falls back to legacy Z_AI_API_KEY when canonical key is absent", () => {
    const runtime = runtimeWith({ Z_AI_API_KEY: "legacy-key" });

    expect(getApiKeyOptional(runtime)).toBe("legacy-key");
  });

  it("keeps ZAI_API_KEY authoritative when both key names are present", () => {
    const runtime = runtimeWith({ ZAI_API_KEY: "canonical-key", Z_AI_API_KEY: "legacy-key" });

    expect(getApiKeyOptional(runtime)).toBe("canonical-key");
  });

  it("falls back to environment values when runtime settings are empty", () => {
    process.env.ZAI_API_KEY = "env-key";
    process.env.ZAI_BASE_URL = "https://env.example.test/";
    const runtime = runtimeWith({ ZAI_API_KEY: "", ZAI_BASE_URL: "" });

    expect(getApiKeyOptional(runtime)).toBe("env-key");
    expect(getBaseURL(runtime)).toBe("https://env.example.test");
  });

  it("uses z.ai endpoint and model defaults", () => {
    const runtime = runtimeWith({});

    expect(getBaseURL(runtime)).toBe("https://api.z.ai/api/paas/v4");
    expect(getSmallModel(runtime)).toBe("glm-4.5-air");
    expect(getLargeModel(runtime)).toBe("glm-5.1");
  });

  it("normalizes trailing slashes without appending /v1", () => {
    const runtime = runtimeWith({ ZAI_BASE_URL: "https://api.z.ai/api/paas/v4/" });

    expect(getBaseURL(runtime)).toBe("https://api.z.ai/api/paas/v4");
  });

  it("rejects coding-plan base URLs in the direct API plugin", () => {
    const runtime = runtimeWith({ ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4" });

    expect(() => getBaseURL(runtime)).toThrow("Coding Plan");
  });

  it("rejects Anthropic-compatible coding-tool URLs in the direct API plugin", () => {
    const runtime = runtimeWith({ ZAI_BASE_URL: "https://api.z.ai/api/anthropic" });

    expect(() => getBaseURL(runtime)).toThrow("Anthropic-compatible");
  });

  it("prefers the browser proxy base URL in browser runtimes", () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });
    const runtime = runtimeWith({
      ZAI_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
      ZAI_BROWSER_BASE_URL: "https://proxy.example.test/zai///",
    });

    expect(getBaseURL(runtime)).toBe("https://proxy.example.test/zai");
  });

  it("uses specific chain-of-thought budgets before the shared budget", () => {
    const runtime = runtimeWith({
      ZAI_COT_BUDGET: "1000",
      ZAI_COT_BUDGET_SMALL: "2000",
      ZAI_COT_BUDGET_LARGE: "3000",
    });

    expect(getCoTBudget(runtime, "small")).toBe(2000);
    expect(getCoTBudget(runtime, "large")).toBe(3000);
  });

  it("ignores invalid chain-of-thought budgets", () => {
    const runtime = runtimeWith({ ZAI_COT_BUDGET_SMALL: "-1", ZAI_COT_BUDGET_LARGE: "nope" });

    expect(getCoTBudget(runtime, "small")).toBe(0);
    expect(getCoTBudget(runtime, "large")).toBe(0);
  });

  it("rejects partially numeric chain-of-thought budgets", () => {
    const runtime = runtimeWith({ ZAI_COT_BUDGET: "2048abc" });

    expect(getCoTBudget(runtime, "small")).toBe(0);
    expect(getThinkingConfig(runtime, "small")).toBeNull();
  });

  it("lets explicit thinking mode override deprecated budgets", () => {
    const runtime = runtimeWith({ ZAI_THINKING_TYPE: " DISABLED ", ZAI_COT_BUDGET: "2048" });

    expect(getThinkingConfig(runtime, "large")).toEqual({ type: "disabled" });
  });
});

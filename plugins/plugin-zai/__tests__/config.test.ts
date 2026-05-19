import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  getApiKeyOptional,
  getBaseURL,
  getCoTBudget,
  getLargeModel,
  getSmallModel,
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

afterEach(() => {
  process.env = { ...originalEnv };
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
});

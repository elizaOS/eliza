import { describe, expect, it } from "vitest";
import {
  FALLBACK_MODELS,
  MODEL_CATALOG_PROVIDERS,
  normalizeModelPreference,
} from "./coding-agent-settings-shared";

describe("coding-agent model settings contract", () => {
  it("loads the Cerebras catalog and retains every benchmarked fallback model", () => {
    expect(MODEL_CATALOG_PROVIDERS).toContain("cerebras");
    expect(FALLBACK_MODELS.cerebras.map((model) => model.value)).toEqual([
      "gemma-4-31b",
      "gpt-oss-120b",
      "zai-glm-4.7",
    ]);
  });

  it("turns the UI default sentinel into an empty provider override", () => {
    expect(normalizeModelPreference("__default__")).toBe("");
    expect(normalizeModelPreference("gpt-oss-120b")).toBe("gpt-oss-120b");
  });
});

import { describe, expect, it } from "vitest";
import { describeActiveModel, resolveModelProvider } from "./model-provider.js";

describe("eliza-code Cerebras model provider", () => {
  it("auto-detects a configured Cerebras credential", () => {
    expect(resolveModelProvider({ CEREBRAS_API_KEY: "csk-test" })).toBe(
      "cerebras",
    );
  });

  it("honors an explicit Cerebras provider selection", () => {
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "cerebras" })).toBe(
      "cerebras",
    );
  });

  it("reports the effective Cerebras large tier without exposing auth", () => {
    expect(
      describeActiveModel({
        CEREBRAS_API_KEY: "csk-test",
        CEREBRAS_SMALL_MODEL: "gemma-4-31b",
        CEREBRAS_LARGE_MODEL: "zai-glm-4.7",
      }),
    ).toBe("zai-glm-4.7");
  });
});

import { describe, expect, it } from "vitest";
import {
  type PluginParamInfo,
  validatePluginConfig,
} from "./plugin-validation";

const OPENAI_PARAMS: PluginParamInfo[] = [
  {
    key: "OPENAI_API_KEY",
    required: true,
    sensitive: true,
    type: "string",
    description: "OpenAI API key",
  },
  {
    key: "CEREBRAS_API_KEY",
    required: false,
    sensitive: true,
    type: "string",
    description: "Cerebras API key",
  },
];

describe("validatePluginConfig", () => {
  it("allows the OpenAI plugin to be configured by CEREBRAS_API_KEY", () => {
    const result = validatePluginConfig(
      "openai",
      "ai",
      "OPENAI_API_KEY",
      ["OPENAI_API_KEY", "CEREBRAS_API_KEY"],
      { CEREBRAS_API_KEY: "csk-test-key" },
      OPENAI_PARAMS,
    );

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("keeps the OpenAI-compatible plugin loud when neither key is set", () => {
    const result = validatePluginConfig(
      "openai",
      "ai",
      "OPENAI_API_KEY",
      ["OPENAI_API_KEY", "CEREBRAS_API_KEY"],
      {},
      OPENAI_PARAMS,
    );

    expect(result.errors).toEqual([
      {
        field: "OPENAI_API_KEY",
        message:
          "OPENAI_API_KEY or CEREBRAS_API_KEY is required but neither is set",
      },
    ]);
    expect(result.valid).toBe(false);
  });
});

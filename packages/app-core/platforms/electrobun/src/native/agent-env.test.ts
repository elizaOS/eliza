import { describe, expect, it } from "vitest";
import { applyWindowsNativeInferenceDefaults } from "./agent";

describe("applyWindowsNativeInferenceDefaults", () => {
  it("sets Windows native inference guards for the child runtime", () => {
    const env: Record<string, string> = {};

    applyWindowsNativeInferenceDefaults(env, "win32");

    expect(env.ELIZA_DISABLE_LOCAL_EMBEDDINGS).toBe("1");
    expect(env.GGML_NO_BACKTRACE).toBe("1");
  });

  it("preserves an explicit GGML_NO_BACKTRACE value", () => {
    const env: Record<string, string> = {
      GGML_NO_BACKTRACE: "custom",
    };

    applyWindowsNativeInferenceDefaults(env, "win32");

    expect(env.GGML_NO_BACKTRACE).toBe("custom");
  });

  it("does not mutate non-Windows child env", () => {
    const env: Record<string, string> = {};

    applyWindowsNativeInferenceDefaults(env, "linux");

    expect(env).toEqual({});
  });
});

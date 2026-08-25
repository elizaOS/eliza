/**
 * Unit coverage for the Code example's shared model-provider helpers:
 * explicit provider resolution (aliases, case/whitespace tolerance), key-based
 * auto-detect precedence, the ELIZA_CODE_* -> OPENAI_* env fill-in, and the
 * status-bar label fallback chain. Real deterministic harness: pure functions
 * over literal env records, no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  applyElizaCodeProviderEnv,
  describeActiveModel,
  resolveModelProvider,
} from "../model-provider.ts";

describe("resolveModelProvider", () => {
  it("resolves explicit ELIZA_CODE_PROVIDER including the claude alias", () => {
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "anthropic" })).toBe(
      "anthropic",
    );
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "claude" })).toBe(
      "anthropic",
    );
  });

  it("resolves explicit openai including the codex alias", () => {
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "openai" })).toBe(
      "openai",
    );
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "codex" })).toBe(
      "openai",
    );
  });

  it("trims and case-folds the explicit value", () => {
    expect(resolveModelProvider({ ELIZA_CODE_PROVIDER: "  OpenAI " })).toBe(
      "openai",
    );
    expect(
      resolveModelProvider({ ELIZA_CODE_MODEL_PROVIDER: "\tCLAUDE\n" }),
    ).toBe("anthropic");
  });

  it("falls back to ELIZA_CODE_MODEL_PROVIDER when ELIZA_CODE_PROVIDER is unset", () => {
    expect(resolveModelProvider({ ELIZA_CODE_MODEL_PROVIDER: "openai" })).toBe(
      "openai",
    );
  });

  it("prefers ELIZA_CODE_PROVIDER over ELIZA_CODE_MODEL_PROVIDER", () => {
    expect(
      resolveModelProvider({
        ELIZA_CODE_PROVIDER: "anthropic",
        ELIZA_CODE_MODEL_PROVIDER: "openai",
      }),
    ).toBe("anthropic");
  });

  it("ignores an unrecognized explicit value and auto-detects instead", () => {
    expect(
      resolveModelProvider({
        ELIZA_CODE_PROVIDER: "gemini",
        ANTHROPIC_API_KEY: "key-anthropic",
      }),
    ).toBe("anthropic");
  });

  it("auto-detects openai from OPENAI_API_KEY ahead of every other signal", () => {
    expect(
      resolveModelProvider({
        OPENAI_API_KEY: "key-openai",
        ELIZA_CODE_API_KEY: "key-forwarded",
        ANTHROPIC_API_KEY: "key-anthropic",
      }),
    ).toBe("openai");
  });

  it("treats a whitespace-only OPENAI_API_KEY as absent", () => {
    expect(
      resolveModelProvider({
        OPENAI_API_KEY: "   ",
        ANTHROPIC_API_KEY: "key-anthropic",
      }),
    ).toBe("anthropic");
  });

  it("maps the orchestrator-forwarded ELIZA_CODE_API_KEY to openai", () => {
    expect(resolveModelProvider({ ELIZA_CODE_API_KEY: "key-forwarded" })).toBe(
      "openai",
    );
    expect(
      resolveModelProvider({
        ELIZA_CODE_API_KEY: "key-forwarded",
        ANTHROPIC_API_KEY: "key-anthropic",
      }),
    ).toBe("openai");
  });

  it("auto-detects anthropic from ANTHROPIC_API_KEY alone", () => {
    expect(resolveModelProvider({ ANTHROPIC_API_KEY: "key-anthropic" })).toBe(
      "anthropic",
    );
  });

  it("throws when nothing is configured", () => {
    expect(() => resolveModelProvider({})).toThrowError(
      /No model provider configured/,
    );
    expect(() =>
      resolveModelProvider({
        OPENAI_API_KEY: " ",
        ELIZA_CODE_API_KEY: "",
        ANTHROPIC_API_KEY: "\t",
      }),
    ).toThrowError(/No model provider configured/);
  });
});

describe("applyElizaCodeProviderEnv", () => {
  it("copies ELIZA_CODE_* onto every unset OPENAI_* var in place", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_CODE_API_KEY: "key-sk",
      ELIZA_CODE_BASE_URL: "https://api.example.com/v1",
      ELIZA_CODE_MODEL_POWERFUL: "model-large",
      ELIZA_CODE_MODEL_FAST: "model-fast",
    };
    applyElizaCodeProviderEnv(env);
    expect(env.OPENAI_API_KEY).toBe("key-sk");
    expect(env.OPENAI_BASE_URL).toBe("https://api.example.com/v1");
    expect(env.OPENAI_LARGE_MODEL).toBe("model-large");
    expect(env.OPENAI_SMALL_MODEL).toBe("model-fast");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("model-fast");
    expect(env.ELIZA_CODE_PROVIDER).toBe("openai");
  });

  it("never overwrites an explicitly set OPENAI_* value", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "existing-key",
      OPENAI_BASE_URL: "https://existing.example.com/v1",
      OPENAI_LARGE_MODEL: "existing-large",
      OPENAI_SMALL_MODEL: "existing-small",
      OPENAI_MEDIUM_MODEL: "existing-medium",
      ELIZA_CODE_API_KEY: "new-key",
      ELIZA_CODE_BASE_URL: "https://new.example.com/v1",
      ELIZA_CODE_MODEL_POWERFUL: "new-large",
      ELIZA_CODE_MODEL_FAST: "new-fast",
    };
    applyElizaCodeProviderEnv(env);
    expect(env.OPENAI_API_KEY).toBe("existing-key");
    expect(env.OPENAI_BASE_URL).toBe("https://existing.example.com/v1");
    expect(env.OPENAI_LARGE_MODEL).toBe("existing-large");
    expect(env.OPENAI_SMALL_MODEL).toBe("existing-small");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("existing-medium");
    // The ELIZA_CODE_PROVIDER default lives inside the API-key branch, so it
    // must stay untouched when the key was already set.
    expect(env.ELIZA_CODE_PROVIDER).toBeUndefined();
  });

  it("fills OPENAI_API_KEY without clobbering an existing ELIZA_CODE_PROVIDER", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_CODE_API_KEY: "key-sk",
      ELIZA_CODE_PROVIDER: "anthropic",
    };
    applyElizaCodeProviderEnv(env);
    expect(env.OPENAI_API_KEY).toBe("key-sk");
    expect(env.ELIZA_CODE_PROVIDER).toBe("anthropic");
  });

  it("treats a whitespace-only OPENAI_API_KEY as missing and fills it", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "   ",
      ELIZA_CODE_API_KEY: "key-sk",
    };
    applyElizaCodeProviderEnv(env);
    expect(env.OPENAI_API_KEY).toBe("key-sk");
  });

  it("still fills OPENAI_MEDIUM_MODEL when OPENAI_SMALL_MODEL was already set", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_SMALL_MODEL: "kept-small",
      ELIZA_CODE_MODEL_FAST: "new-fast",
    };
    applyElizaCodeProviderEnv(env);
    expect(env.OPENAI_SMALL_MODEL).toBe("kept-small");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("new-fast");
  });

  it("leaves OPENAI_* untouched when ELIZA_CODE_* are unset or empty", () => {
    const unconfigured: Record<string, string | undefined> = {};
    applyElizaCodeProviderEnv(unconfigured);
    expect(unconfigured.OPENAI_API_KEY).toBeUndefined();
    expect(unconfigured.OPENAI_BASE_URL).toBeUndefined();

    const emptyValues: Record<string, string | undefined> = {
      ELIZA_CODE_API_KEY: "",
      ELIZA_CODE_BASE_URL: "",
      ELIZA_CODE_MODEL_POWERFUL: "",
      ELIZA_CODE_MODEL_FAST: "",
    };
    applyElizaCodeProviderEnv(emptyValues);
    expect(emptyValues.OPENAI_API_KEY).toBeUndefined();
    expect(emptyValues.OPENAI_BASE_URL).toBeUndefined();
    expect(emptyValues.OPENAI_LARGE_MODEL).toBeUndefined();
    expect(emptyValues.OPENAI_SMALL_MODEL).toBeUndefined();
    expect(emptyValues.ELIZA_CODE_PROVIDER).toBeUndefined();
  });
});

describe("describeActiveModel", () => {
  it("returns null when no provider can be resolved", () => {
    expect(describeActiveModel({})).toBeNull();
    expect(describeActiveModel({ ANTHROPIC_API_KEY: "  " })).toBeNull();
  });

  it("labels an openai provider by its large model, then its small model", () => {
    expect(
      describeActiveModel({
        OPENAI_API_KEY: "key-openai",
        OPENAI_LARGE_MODEL: "gpt-large",
        OPENAI_SMALL_MODEL: "gpt-small",
      }),
    ).toBe("gpt-large");
    expect(
      describeActiveModel({
        OPENAI_API_KEY: "key-openai",
        OPENAI_SMALL_MODEL: "gpt-small",
      }),
    ).toBe("gpt-small");
  });

  it("trims surrounding whitespace off the configured model name", () => {
    expect(
      describeActiveModel({
        ANTHROPIC_API_KEY: "key-anthropic",
        ANTHROPIC_LARGE_MODEL: "  cl-large  ",
      }),
    ).toBe("cl-large");
  });

  it("shows the bare provider when honored model vars are unset or blank", () => {
    expect(describeActiveModel({ OPENAI_API_KEY: "key-openai" })).toBe(
      "openai",
    );
    expect(
      describeActiveModel({
        OPENAI_API_KEY: "key-openai",
        OPENAI_LARGE_MODEL: "   ",
      }),
    ).toBe("openai");
    expect(
      describeActiveModel({
        ANTHROPIC_API_KEY: "key-anthropic",
        ANTHROPIC_SMALL_MODEL: "",
      }),
    ).toBe("anthropic");
  });

  it("labels an anthropic provider from its large then small models", () => {
    expect(
      describeActiveModel({
        ANTHROPIC_API_KEY: "key-anthropic",
        ANTHROPIC_LARGE_MODEL: "cl-large",
        ANTHROPIC_SMALL_MODEL: "cl-small",
      }),
    ).toBe("cl-large");
    expect(
      describeActiveModel({
        ANTHROPIC_API_KEY: "key-anthropic",
        ANTHROPIC_SMALL_MODEL: "cl-small",
      }),
    ).toBe("cl-small");
  });

  it("resolves via the codex alias while ignoring non-honored model vars", () => {
    expect(
      describeActiveModel({
        ELIZA_CODE_PROVIDER: "codex",
        OPENAI_MODEL: "not-a-honored-var",
      }),
    ).toBe("openai");
    expect(
      describeActiveModel({
        ELIZA_CODE_PROVIDER: "claude",
        ANTHROPIC_MODEL: "not-a-honored-var",
      }),
    ).toBe("anthropic");
  });

  it("masks the small model behind a nullish-set but blank large model", () => {
    // OPENAI_LARGE_MODEL is present-but-empty, so ?? keeps it and the label
    // degrades to the bare provider rather than showing the small model.
    expect(
      describeActiveModel({
        OPENAI_API_KEY: "key-openai",
        OPENAI_LARGE_MODEL: "",
        OPENAI_SMALL_MODEL: "gpt-small",
      }),
    ).toBe("openai");
  });
});

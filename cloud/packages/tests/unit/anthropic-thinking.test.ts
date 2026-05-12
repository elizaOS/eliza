import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  anthropicThinkingProviderOptions,
  mergeAnthropicCotProviderOptions,
  mergeGoogleImageModalitiesWithAnthropicCot,
  mergeProviderOptions,
  parseAnthropicCotBudgetFromEnv,
  parseAnthropicCotBudgetMaxFromEnv,
  parseThinkingBudgetFromCharacterSettings,
  resolveAnthropicThinkingBudgetTokens,
  supportsExtendedThinking,
} from "@/lib/providers/anthropic-thinking";

const COT_ENV_KEY = "ANTHROPIC_COT_BUDGET";
const COT_MAX_ENV_KEY = "ANTHROPIC_COT_BUDGET_MAX";

describe("resolveAnthropicThinkingBudgetTokens", () => {
  let prevBudget: string | undefined;
  let prevMax: string | undefined;

  beforeEach(() => {
    prevBudget = process.env[COT_ENV_KEY];
    prevMax = process.env[COT_MAX_ENV_KEY];
    delete process.env[COT_ENV_KEY];
    delete process.env[COT_MAX_ENV_KEY];
  });

  afterEach(() => {
    if (prevBudget === undefined) {
      delete process.env[COT_ENV_KEY];
    } else {
      process.env[COT_ENV_KEY] = prevBudget;
    }
    if (prevMax === undefined) {
      delete process.env[COT_MAX_ENV_KEY];
    } else {
      process.env[COT_MAX_ENV_KEY] = prevMax;
    }
  });

  test("returns null for non-Anthropic model", () => {
    const result = resolveAnthropicThinkingBudgetTokens("openai/gpt-5.5", {});
    expect(result).toBeNull();
  });

  test("returns null for Anthropic model that does not support extended thinking", () => {
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-haiku-4.5-5-20251001",
      {},
    );
    expect(result).toBeNull();
  });

  test("uses per-agent budget when provided for supported Anthropic model", () => {
    const result = resolveAnthropicThinkingBudgetTokens("anthropic/claude-sonnet-4.6", {}, 5000);
    expect(result).toBe(5000);
  });

  test("returns null when per-agent budget is 0 (explicitly disabled)", () => {
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-sonnet-4.6",
      { [COT_ENV_KEY]: "10000" },
      0,
    );
    expect(result).toBeNull();
  });

  test("falls back to env budget when per-agent budget is undefined", () => {
    const result = resolveAnthropicThinkingBudgetTokens("anthropic/claude-sonnet-4.6", {
      [COT_ENV_KEY]: "8000",
    });
    expect(result).toBe(8000);
  });

  test("returns null when both per-agent and env budgets are unset", () => {
    const result = resolveAnthropicThinkingBudgetTokens("anthropic/claude-sonnet-4.6", {});
    expect(result).toBeNull();
  });

  test("clamps budget to max cap when max is set and budget exceeds it", () => {
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-sonnet-4.6",
      { [COT_MAX_ENV_KEY]: "3000" },
      5000,
    );
    expect(result).toBe(3000);
  });

  test("does not clamp budget when under max cap", () => {
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-sonnet-4.6",
      { [COT_MAX_ENV_KEY]: "10000" },
      5000,
    );
    expect(result).toBe(5000);
  });

  test("clamps env fallback budget to max cap", () => {
    const result = resolveAnthropicThinkingBudgetTokens("anthropic/claude-sonnet-4.6", {
      [COT_ENV_KEY]: "15000",
      [COT_MAX_ENV_KEY]: "10000",
    });
    expect(result).toBe(10000);
  });

  test("returns null when env budget is 0 (explicitly disabled)", () => {
    const result = resolveAnthropicThinkingBudgetTokens("anthropic/claude-sonnet-4.6", {
      [COT_ENV_KEY]: "0",
    });
    expect(result).toBeNull();
  });

  test("per-agent budget takes precedence over env budget", () => {
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-sonnet-4.6",
      { [COT_ENV_KEY]: "5000" },
      3000,
    );
    expect(result).toBe(3000);
  });

  test("max cap of 0 means no cap, per-agent budget passes through", () => {
    // parseAnthropicCotBudgetMaxFromEnv returns null for "0" (meaning no cap),
    // so the per-agent budget of 5000 is returned unchanged.
    const result = resolveAnthropicThinkingBudgetTokens(
      "anthropic/claude-sonnet-4.6",
      { [COT_MAX_ENV_KEY]: "0" },
      5000,
    );
    expect(result).toBe(5000);
  });
});

describe("anthropic COT env", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[COT_ENV_KEY];
    delete process.env[COT_ENV_KEY];
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[COT_ENV_KEY];
    } else {
      process.env[COT_ENV_KEY] = prev;
    }
  });

  describe("parseAnthropicCotBudgetFromEnv", () => {
    test("unset and empty → null", () => {
      expect(parseAnthropicCotBudgetFromEnv({})).toBeNull();
      expect(parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "" })).toBeNull();
    });

    test("0 → null", () => {
      expect(parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "0" })).toBeNull();
    });

    test("positive integer → number", () => {
      expect(parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "1024" })).toBe(1024);
      expect(parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: " 2048 " })).toBe(2048);
    });

    test("invalid non-empty throws", () => {
      expect(() => parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "abc" })).toThrow(
        /non-negative integer/,
      );
      expect(() => parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "12.5" })).toThrow(
        /non-negative integer/,
      );
      expect(() => parseAnthropicCotBudgetFromEnv({ [COT_ENV_KEY]: "12x" })).toThrow(
        /non-negative integer/,
      );
    });
  });

  describe("anthropicThinkingProviderOptions", () => {
    test("non-anthropic model → {}", () => {
      expect(anthropicThinkingProviderOptions("gpt-4o", {})).toEqual({});
      expect(
        anthropicThinkingProviderOptions("openai/gpt-4o", {
          [COT_ENV_KEY]: "1024",
        }),
      ).toEqual({});
    });

    test("anthropic model + budget → thinking enabled", () => {
      const env = { [COT_ENV_KEY]: "1024" };
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env)).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
        },
      });
      expect(anthropicThinkingProviderOptions("claude-sonnet-4-6", env)).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
        },
      });
    });

    test("anthropic model + no budget → {}", () => {
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", {})).toEqual({});
    });

    test("per-agent 0 disables despite env default", () => {
      const env = { [COT_ENV_KEY]: "1024" };
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env, 0)).toEqual({});
    });

    test("per-agent budget overrides env default", () => {
      const env = { [COT_ENV_KEY]: "1024" };
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env, 2048)).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
        },
      });
    });

    test("ANTHROPIC_COT_BUDGET_MAX clamps per-agent budget", () => {
      const env = { [COT_ENV_KEY]: "1024", [COT_MAX_ENV_KEY]: "500" };
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env, 9000)).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 500 } },
        },
      });
    });

    test("ANTHROPIC_COT_BUDGET_MAX clamps env default when no per-agent override", () => {
      const env = { [COT_ENV_KEY]: "9000", [COT_MAX_ENV_KEY]: "1000" };
      expect(anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env)).toEqual({
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1000 } },
        },
      });
    });
  });

  describe("mergeAnthropicCotProviderOptions", () => {
    test("aliases mergeProviderOptions(undefined, anthropicThinking…)", () => {
      expect(mergeAnthropicCotProviderOptions("openai/gpt-4o", {})).toEqual({});
      const env = { [COT_ENV_KEY]: "1024" };
      expect(mergeAnthropicCotProviderOptions("anthropic/claude-sonnet-4.6", env)).toEqual(
        mergeProviderOptions(
          undefined,
          anthropicThinkingProviderOptions("anthropic/claude-sonnet-4.6", env),
        ),
      );
    });
  });
});

describe("mergeGoogleImageModalitiesWithAnthropicCot", () => {
  test("matches explicit google merge + anthropic fragment", () => {
    expect(mergeGoogleImageModalitiesWithAnthropicCot("google/gemini-2.5-flash-image", {})).toEqual(
      mergeProviderOptions(
        {
          providerOptions: {
            google: { responseModalities: ["TEXT", "IMAGE"] },
          },
        },
        anthropicThinkingProviderOptions("google/gemini-2.5-flash-image", {}),
      ),
    );
  });
});

describe("parseAnthropicCotBudgetMaxFromEnv", () => {
  test("unset → null", () => {
    expect(parseAnthropicCotBudgetMaxFromEnv({})).toBeNull();
  });

  test("positive → cap", () => {
    expect(parseAnthropicCotBudgetMaxFromEnv({ [COT_MAX_ENV_KEY]: "8192" })).toBe(8192);
  });
});

describe("parseThinkingBudgetFromCharacterSettings", () => {
  test("missing or invalid → undefined", () => {
    expect(parseThinkingBudgetFromCharacterSettings(undefined)).toBeUndefined();
    expect(parseThinkingBudgetFromCharacterSettings({})).toBeUndefined();
    expect(
      parseThinkingBudgetFromCharacterSettings({
        anthropicThinkingBudgetTokens: "nope",
      }),
    ).toBeUndefined();
  });

  test("integer ≥ 0", () => {
    expect(
      parseThinkingBudgetFromCharacterSettings({
        anthropicThinkingBudgetTokens: 0,
      }),
    ).toBe(0);
    expect(
      parseThinkingBudgetFromCharacterSettings({
        anthropicThinkingBudgetTokens: 42,
      }),
    ).toBe(42);
  });

  test("float input is rejected", () => {
    expect(
      parseThinkingBudgetFromCharacterSettings({
        anthropicThinkingBudgetTokens: 4000.9,
      }),
    ).toBeUndefined();
    expect(
      parseThinkingBudgetFromCharacterSettings({
        anthropicThinkingBudgetTokens: 1.1,
      }),
    ).toBeUndefined();
  });
});

describe("supportsExtendedThinking", () => {
  test("returns true for Claude Sonnet 4.6 variants", () => {
    expect(supportsExtendedThinking("claude-sonnet-4-6")).toBe(true);
    expect(supportsExtendedThinking("anthropic/claude-sonnet-4.6")).toBe(true);
  });

  test("returns true for Claude Opus 4.7 variants", () => {
    expect(supportsExtendedThinking("claude-opus-4-7")).toBe(true);
    expect(supportsExtendedThinking("anthropic/claude-opus-4.7")).toBe(true);
  });

  test("returns false for Claude Haiku (does not support thinking)", () => {
    expect(supportsExtendedThinking("claude-haiku-4-5-20251001")).toBe(false);
    expect(supportsExtendedThinking("anthropic/claude-haiku-4.5")).toBe(false);
  });

  test("returns false for non-Anthropic models", () => {
    expect(supportsExtendedThinking("gpt-5.5")).toBe(false);
    expect(supportsExtendedThinking("openai/gpt-4o")).toBe(false);
    expect(supportsExtendedThinking("google/gemini-pro")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(supportsExtendedThinking("CLAUDE-SONNET-4-6")).toBe(true);
    expect(supportsExtendedThinking("CLAUDE-OPUS-4-7")).toBe(true);
  });
});

describe("mergeProviderOptions", () => {
  test("empty + empty → {}", () => {
    expect(mergeProviderOptions(undefined, undefined)).toEqual({});
  });

  test("preserves google and adds anthropic", () => {
    const merged = mergeProviderOptions(
      {
        providerOptions: { google: { responseModalities: ["TEXT", "IMAGE"] } },
      },
      {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 512 } },
        },
      },
    );
    expect(merged).toEqual({
      providerOptions: {
        google: { responseModalities: ["TEXT", "IMAGE"] },
        anthropic: { thinking: { type: "enabled", budgetTokens: 512 } },
      },
    });
  });

  test("both sides anthropic → later wins shallow fields", () => {
    const merged = mergeProviderOptions(
      { providerOptions: { anthropic: { sendReasoning: false } } },
      {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 100 } },
        },
      },
    );
    expect(merged.providerOptions.anthropic).toEqual({
      sendReasoning: false,
      thinking: { type: "enabled", budgetTokens: 100 },
    });
  });

  test("non-deep-merged provider key in both base and extra — extra clobbers base", () => {
    // Note: Only anthropic and google keys are deep-merged.
    // Other provider keys (e.g. openai, mistral) are clobbered by outer spread.
    const merged = mergeProviderOptions(
      {
        providerOptions: {
          openai: { organizationId: "org-123", projectId: "proj-456" },
        },
      },
      { providerOptions: { openai: { organizationId: "org-789" } } },
    );
    // The entire openai object from extra replaces base — projectId is lost
    expect(merged.providerOptions.openai).toEqual({
      organizationId: "org-789",
    });
  });

  test("documents that non-deep-merged keys drop base fields on conflict", () => {
    // This test documents the expected (if surprising) behavior:
    // when both base and extra have a provider key that isn't in the deep-merge list,
    // the entire extra object replaces base, losing any fields only in base.
    const merged = mergeProviderOptions(
      { providerOptions: { mistral: { apiKey: "key-1", safeMode: true } } },
      { providerOptions: { mistral: { apiKey: "key-2" } } },
    );
    // safeMode is lost because mistral isn't deep-merged
    expect(merged.providerOptions.mistral).toEqual({ apiKey: "key-2" });
    expect((merged.providerOptions.mistral as { safeMode?: boolean }).safeMode).toBeUndefined();
  });
});

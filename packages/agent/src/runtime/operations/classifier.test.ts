/**
 * Unit coverage for the reload-tier classifier. Drives the real pure
 * function: first-match ordering, provider-family ties, empty and missing
 * config paths, and the defaultClassifier alias.
 */

import { describe, expect, it } from "vitest";
import {
  type ClassifyContext,
  classifyOperation,
  defaultClassifier,
} from "./classifier.ts";
import type { OperationIntent } from "./types.ts";

describe("classifyOperation", () => {
  describe("restart", () => {
    it("returns cold for an explicit restart intent", () => {
      expect(classifyOperation({ kind: "restart", reason: "manual" }, {})).toBe(
        "cold",
      );
    });

    it("returns cold regardless of restart reason text", () => {
      expect(classifyOperation({ kind: "restart", reason: "" }, {})).toBe(
        "cold",
      );
      expect(
        classifyOperation(
          { kind: "restart", reason: "provider switch to anthropic" },
          { currentProvider: "openai" },
        ),
      ).toBe("cold");
    });
  });

  describe("plugin-enable / plugin-disable", () => {
    it("returns cold when enabling a plugin", () => {
      expect(
        classifyOperation(
          { kind: "plugin-enable", pluginId: "plugin-sql" },
          {},
        ),
      ).toBe("cold");
    });

    it("returns cold when disabling a plugin", () => {
      expect(
        classifyOperation(
          { kind: "plugin-disable", pluginId: "plugin-sql" },
          {},
        ),
      ).toBe("cold");
    });

    it("returns cold for an empty plugin id", () => {
      expect(
        classifyOperation({ kind: "plugin-enable", pluginId: "" }, {}),
      ).toBe("cold");
      expect(
        classifyOperation({ kind: "plugin-disable", pluginId: "" }, {}),
      ).toBe("cold");
    });
  });

  describe("provider-switch", () => {
    const switchTo = (
      provider: string,
      extra?: Omit<
        Extract<OperationIntent, { kind: "provider-switch" }>,
        "kind" | "provider"
      >,
    ): OperationIntent => ({
      kind: "provider-switch",
      provider,
      ...extra,
    });

    it("returns cold when no current provider is set (first-time setup)", () => {
      expect(classifyOperation(switchTo("openai"), {})).toBe("cold");
      expect(
        classifyOperation(switchTo("openai"), { currentProvider: undefined }),
      ).toBe("cold");
    });

    it("returns cold when currentProvider is an empty string", () => {
      expect(
        classifyOperation(switchTo("openai"), { currentProvider: "" }),
      ).toBe("cold");
    });

    it("returns hot when the target is the same provider", () => {
      expect(
        classifyOperation(switchTo("openai"), { currentProvider: "openai" }),
      ).toBe("hot");
    });

    it("returns hot for a same-provider key-only swap", () => {
      expect(
        classifyOperation(
          switchTo("openai", { apiKeyRef: "providers.openai.api-key" }),
          { currentProvider: "openai", currentApiKey: "old-key" },
        ),
      ).toBe("hot");
    });

    it("returns hot for a same-provider primaryModel-only swap", () => {
      expect(
        classifyOperation(switchTo("openai", { primaryModel: "gpt-4.1" }), {
          currentProvider: "openai",
          currentPrimaryModel: "gpt-4o",
        }),
      ).toBe("hot");
    });

    it("returns hot when the same provider changes both key and primaryModel", () => {
      expect(
        classifyOperation(
          switchTo("anthropic", {
            apiKeyRef: "providers.anthropic.api-key",
            primaryModel: "claude-sonnet-4-5",
          }),
          { currentProvider: "anthropic" },
        ),
      ).toBe("hot");
    });

    it("returns warm when switching between providers in the openai family", () => {
      expect(
        classifyOperation(switchTo("openai-subscription"), {
          currentProvider: "openai",
        }),
      ).toBe("warm");
      expect(
        classifyOperation(switchTo("openai"), {
          currentProvider: "openai-subscription",
        }),
      ).toBe("warm");
    });

    it("returns warm when switching between providers in the anthropic family", () => {
      expect(
        classifyOperation(switchTo("anthropic-subscription"), {
          currentProvider: "anthropic",
        }),
      ).toBe("warm");
    });

    it("returns warm for moonshot ↔ kimi-coding-subscription (same family)", () => {
      expect(
        classifyOperation(switchTo("kimi-coding-subscription"), {
          currentProvider: "moonshot",
        }),
      ).toBe("warm");
    });

    it("returns cold when switching across provider families", () => {
      expect(
        classifyOperation(switchTo("anthropic"), { currentProvider: "openai" }),
      ).toBe("cold");
      expect(
        classifyOperation(switchTo("cerebras"), {
          currentProvider: "elizacloud",
        }),
      ).toBe("cold");
      expect(
        classifyOperation(switchTo("groq"), { currentProvider: "grok" }),
      ).toBe("cold");
    });

    it("returns cold when either provider has no catalog family", () => {
      expect(
        classifyOperation(switchTo("not-a-provider"), {
          currentProvider: "openai",
        }),
      ).toBe("cold");
      expect(
        classifyOperation(switchTo("openai"), {
          currentProvider: "not-a-provider",
        }),
      ).toBe("cold");
      expect(
        classifyOperation(switchTo("unknown-a"), {
          currentProvider: "unknown-b",
        }),
      ).toBe("cold");
    });

    it("does not treat unused ClassifyContext fields as a current provider", () => {
      const ctx: ClassifyContext = {
        currentApiKey: "sk-live",
        currentPrimaryModel: "gpt-4o",
      };
      expect(classifyOperation(switchTo("openai"), ctx)).toBe("cold");
    });
  });

  describe("config-reload", () => {
    it("returns cold when changedPaths is omitted", () => {
      expect(classifyOperation({ kind: "config-reload" }, {})).toBe("cold");
    });

    it("returns cold for an empty changedPaths list", () => {
      expect(
        classifyOperation({ kind: "config-reload", changedPaths: [] }, {}),
      ).toBe("cold");
    });

    it("returns hot when every path is under env.", () => {
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["env.OPENAI_API_KEY"] },
          {},
        ),
      ).toBe("hot");
    });

    it("returns hot when every path is under vars.", () => {
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["vars.timezone"] },
          {},
        ),
      ).toBe("hot");
    });

    it("returns hot when every path is under models.", () => {
      expect(
        classifyOperation(
          {
            kind: "config-reload",
            changedPaths: ["models.large", "models.small"],
          },
          {},
        ),
      ).toBe("hot");
    });

    it("returns hot when mixed paths are all hot-eligible prefixes", () => {
      expect(
        classifyOperation(
          {
            kind: "config-reload",
            changedPaths: ["env.FOO", "vars.bar", "models.large"],
          },
          {},
        ),
      ).toBe("hot");
    });

    it("returns cold when any path is outside the hot-eligible prefixes", () => {
      expect(
        classifyOperation(
          {
            kind: "config-reload",
            changedPaths: ["env.FOO", "plugins.enabled"],
          },
          {},
        ),
      ).toBe("cold");
    });

    it("returns cold for a single non-hot path", () => {
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["character.name"] },
          {},
        ),
      ).toBe("cold");
    });

    it("returns cold for prefix-like paths that do not start with a hot prefix", () => {
      expect(
        classifyOperation({ kind: "config-reload", changedPaths: ["env"] }, {}),
      ).toBe("cold");
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["vars"] },
          {},
        ),
      ).toBe("cold");
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["model.large"] },
          {},
        ),
      ).toBe("cold");
      expect(
        classifyOperation(
          { kind: "config-reload", changedPaths: ["x.env.FOO"] },
          {},
        ),
      ).toBe("cold");
    });

    it("treats the bare prefix strings env. vars. and models. as hot-eligible", () => {
      expect(
        classifyOperation(
          {
            kind: "config-reload",
            changedPaths: ["env.", "vars.", "models."],
          },
          {},
        ),
      ).toBe("hot");
    });
  });
});

describe("defaultClassifier", () => {
  it("is a reference that returns the same tier as classifyOperation", () => {
    const cases: Array<{
      intent: OperationIntent;
      ctx: ClassifyContext;
    }> = [
      { intent: { kind: "restart", reason: "manual" }, ctx: {} },
      {
        intent: { kind: "plugin-enable", pluginId: "plugin-sql" },
        ctx: {},
      },
      {
        intent: { kind: "provider-switch", provider: "openai" },
        ctx: { currentProvider: "openai" },
      },
      {
        intent: { kind: "provider-switch", provider: "openai-subscription" },
        ctx: { currentProvider: "openai" },
      },
      {
        intent: { kind: "provider-switch", provider: "anthropic" },
        ctx: { currentProvider: "openai" },
      },
      {
        intent: { kind: "config-reload", changedPaths: ["env.FOO"] },
        ctx: {},
      },
      { intent: { kind: "config-reload", changedPaths: [] }, ctx: {} },
    ];

    for (const { intent, ctx } of cases) {
      expect(defaultClassifier(intent, ctx)).toBe(
        classifyOperation(intent, ctx),
      );
    }
  });
});

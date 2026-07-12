/**
 * Position-aware "models" completion grammar over a fixture catalog — pure
 * functions, no React/DOM: per-subcommand values for /model, provider
 * qualification of ambiguous chat ids, apiSupported filtering, effort
 * resolution, caps, and the value→label map.
 */

import { describe, expect, it } from "vitest";
import type {
  ModelCatalogEntry,
  ModelCatalogProviders,
} from "../api/client-types-core";
import {
  buildModelChoiceLabels,
  CODING_BACKEND_CHOICES,
  resolveModelChoices,
} from "./model-choices";
import type { SlashArgChoiceContext } from "./slash-menu";

const CATALOG: ModelCatalogProviders = {
  codex: [
    {
      id: "gpt-5.6-terra",
      display: "GPT-5.6-Terra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      roles: ["coding"],
      costHint: "highest cost/latency tier",
    },
    {
      id: "gpt-5.5",
      display: "GPT-5.5",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      roles: ["coding"],
    },
    {
      id: "gpt-5.3-codex-spark",
      display: "GPT-5.3-Codex-Spark",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      roles: ["coding"],
      apiSupported: false,
    },
  ],
  "claude-chat": [
    {
      id: "claude-opus-4-8",
      display: "Claude Opus 4.8",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      roles: ["small", "large"],
    },
  ],
  "claude-coding": [
    {
      id: "claude-opus-4-8",
      display: "Claude Opus 4.8",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "xhigh",
      roles: ["coding"],
    },
  ],
  cerebras: [
    {
      id: "gemma-4-31b",
      display: "Gemma 4 31B",
      efforts: ["low", "medium", "high"],
      roles: ["small"],
    },
    {
      id: "zai-glm-4.7",
      display: "GLM-4.7",
      efforts: ["low", "medium", "high"],
      roles: ["small", "large"],
    },
  ],
  elizacloud: [
    {
      id: "zai-glm-4.7",
      display: "GLM-4.7",
      efforts: ["low", "medium", "high"],
      roles: ["small", "large"],
    },
    {
      id: "openai/gpt-oss-120b",
      display: "GPT-OSS 120B",
      efforts: ["low", "medium", "high"],
      roles: ["small", "large"],
    },
  ],
};

function ctx(
  argIndex: number,
  precedingTokens: string[] = [],
  commandKey = "model",
): SlashArgChoiceContext {
  return { commandKey, argIndex, precedingTokens };
}

describe("resolveModelChoices", () => {
  it("returns nothing without a catalog", () => {
    expect(resolveModelChoices(null, ctx(1, ["small"]))).toEqual([]);
  });

  it("offers every callable model id without positional context", () => {
    const all = resolveModelChoices(CATALOG, undefined);
    expect(all).toEqual([
      "gpt-5.6-terra",
      "gpt-5.5",
      "claude-opus-4-8",
      "gemma-4-31b",
      "zai-glm-4.7",
      "openai/gpt-oss-120b",
    ]);
    // Same list for a non-/model command tagging the source, and for the
    // bare-name per-room position of /model itself.
    expect(resolveModelChoices(CATALOG, ctx(0, [], "other"))).toEqual(all);
    expect(resolveModelChoices(CATALOG, ctx(0))).toEqual(all);
  });

  it("offers chat models per target, provider-qualifying ambiguous ids", () => {
    expect(resolveModelChoices(CATALOG, ctx(1, ["small"]))).toEqual([
      "claude-opus-4-8",
      "gemma-4-31b",
      "cerebras/zai-glm-4.7",
      "elizacloud/zai-glm-4.7",
      "openai/gpt-oss-120b",
    ]);
    // gemma is small-only; large drops it.
    expect(resolveModelChoices(CATALOG, ctx(1, ["large"]))).toEqual([
      "claude-opus-4-8",
      "cerebras/zai-glm-4.7",
      "elizacloud/zai-glm-4.7",
      "openai/gpt-oss-120b",
    ]);
  });

  it("offers the coding backends after /model coding", () => {
    expect(resolveModelChoices(CATALOG, ctx(1, ["coding"]))).toEqual([
      ...CODING_BACKEND_CHOICES,
    ]);
  });

  it("offers nothing after show/local/cloud (no catalog-backed completions)", () => {
    expect(resolveModelChoices(CATALOG, ctx(1, ["show"]))).toEqual([]);
    expect(resolveModelChoices(CATALOG, ctx(1, ["local"]))).toEqual([]);
    expect(resolveModelChoices(CATALOG, ctx(1, ["cloud"]))).toEqual([]);
  });

  it("offers a provider's models when the chat provider is spelled as its own token", () => {
    expect(resolveModelChoices(CATALOG, ctx(2, ["small", "cerebras"]))).toEqual(
      ["gemma-4-31b", "zai-glm-4.7"],
    );
  });

  it("offers efforts for a chat model token (bare, qualified, or slashed id)", () => {
    expect(
      resolveModelChoices(CATALOG, ctx(2, ["large", "zai-glm-4.7"])),
    ).toEqual(["low", "medium", "high"]);
    expect(
      resolveModelChoices(CATALOG, ctx(2, ["large", "elizacloud/zai-glm-4.7"])),
    ).toEqual(["low", "medium", "high"]);
    // "openai" is not a catalog provider, so the slashed id resolves as an id.
    expect(
      resolveModelChoices(CATALOG, ctx(2, ["large", "openai/gpt-oss-120b"])),
    ).toEqual(["low", "medium", "high"]);
    expect(
      resolveModelChoices(CATALOG, ctx(2, ["large", "unknown-model"])),
    ).toEqual([]);
  });

  it("offers a backend's models for /model coding, hiding apiSupported:false", () => {
    expect(resolveModelChoices(CATALOG, ctx(2, ["coding", "codex"]))).toEqual([
      "gpt-5.6-terra",
      "gpt-5.5",
    ]);
    expect(resolveModelChoices(CATALOG, ctx(2, ["coding", "claude"]))).toEqual([
      "claude-opus-4-8",
    ]);
    // Free-form backends have no catalog to complete from.
    expect(
      resolveModelChoices(CATALOG, ctx(2, ["coding", "opencode"])),
    ).toEqual([]);
    expect(resolveModelChoices(CATALOG, ctx(2, ["coding", "elizaos"]))).toEqual(
      [],
    );
  });

  it("offers efforts for the chosen coding model", () => {
    expect(
      resolveModelChoices(CATALOG, ctx(3, ["coding", "codex", "gpt-5.5"])),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      resolveModelChoices(CATALOG, ctx(3, ["coding", "codex", "nope"])),
    ).toEqual([]);
  });

  it("offers efforts for the provider-spelled chat shape at index 3", () => {
    expect(
      resolveModelChoices(
        CATALOG,
        ctx(3, ["small", "cerebras", "gemma-4-31b"]),
      ),
    ).toEqual(["low", "medium", "high"]);
    // Without a provider token at index 1, index 2 was already the effort.
    expect(
      resolveModelChoices(CATALOG, ctx(3, ["small", "zai-glm-4.7", "low"])),
    ).toEqual([]);
  });

  it("caps oversized lists", () => {
    const entries: ModelCatalogEntry[] = Array.from({ length: 40 }, (_, i) => ({
      id: `model-${i}`,
      display: `Model ${i}`,
      efforts: ["low"],
      roles: ["coding"],
    }));
    const big: ModelCatalogProviders = { codex: entries };
    expect(resolveModelChoices(big, ctx(2, ["coding", "codex"]))).toHaveLength(
      25,
    );
  });
});

describe("buildModelChoiceLabels", () => {
  it("labels catalog values with display names and providers", () => {
    const labels = buildModelChoiceLabels(CATALOG);
    expect(labels.get("zai-glm-4.7")).toBe("GLM-4.7");
    expect(labels.get("cerebras/zai-glm-4.7")).toBe("GLM-4.7 · cerebras");
    expect(labels.get("gpt-5.6-terra")).toBe(
      "GPT-5.6-Terra — highest cost/latency tier",
    );
    expect(labels.get("openai/gpt-oss-120b")).toBe("GPT-OSS 120B");
  });

  it("labels the static target and backend tokens, with or without a catalog", () => {
    for (const labels of [
      buildModelChoiceLabels(CATALOG),
      buildModelChoiceLabels(null),
    ]) {
      expect(labels.get("small")).toBe("small chat model (global)");
      expect(labels.get("coding")).toBe("coding sub-agent model (global)");
      expect(labels.get("show")).toBe("current model configuration");
      expect(labels.get("codex")).toBe("Codex CLI");
      expect(labels.get("elizaos")).toBe("elizaOS coder");
    }
  });
});

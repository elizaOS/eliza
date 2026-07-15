/**
 * Unit tests for the provider→model catalog: static-table ground truth (spark
 * API flag, per-model effort gates, role assignment), live Codex cache parse +
 * merge semantics, and the designed static fallback on a corrupt/absent cache.
 * Deterministic — filesystem reads are injected, no live provider is touched.
 */
import { describe, expect, it } from "vitest";
import { buildModelCatalog, CODING_MODEL_DEFAULTS } from "./model-catalog";

const NO_CACHE = {
  readFile: () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  env: {} as NodeJS.ProcessEnv,
};

function entry(
  providerEntries: ReturnType<typeof buildModelCatalog>,
  provider: string,
  id: string,
) {
  const found = providerEntries.providers[provider]?.find((m) => m.id === id);
  if (!found) throw new Error(`missing ${provider}/${id}`);
  return found;
}

describe("static codex catalog (fallback table)", () => {
  const catalog = buildModelCatalog(NO_CACHE);

  it("marks gpt-5.3-codex-spark as not API-supported", () => {
    const spark = entry(catalog, "codex", "gpt-5.3-codex-spark");
    expect(spark.apiSupported).toBe(false);
    expect(spark.defaultEffort).toBe("high");
  });

  it("gives terra ultra (with cost hint) but not luna", () => {
    const terra = entry(catalog, "codex", "gpt-5.6-terra");
    const luna = entry(catalog, "codex", "gpt-5.6-luna");
    expect(terra.efforts).toContain("ultra");
    expect(terra.costHint).toBe("highest cost/latency tier");
    expect(luna.efforts).not.toContain("ultra");
    expect(luna.costHint).toBeUndefined();
    expect(luna.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("defaults every non-spark codex model to medium effort", () => {
    for (const m of catalog.providers.codex) {
      if (m.id === "gpt-5.3-codex-spark") continue;
      expect(m.defaultEffort).toBe("medium");
    }
  });

  it("exposes the user-approved coding default models", () => {
    expect(CODING_MODEL_DEFAULTS.codex).toBe("gpt-5.6-sol");
    expect(CODING_MODEL_DEFAULTS.claude).toBe("claude-opus-4-8");
    expect(catalog.providers.codex.some((m) => m.id === "gpt-5.6-sol")).toBe(
      true,
    );
    expect(
      catalog.providers["claude-coding"].some(
        (m) => m.id === "claude-opus-4-8",
      ),
    ).toBe(true);
  });
});

describe("codex models_cache.json parse + merge", () => {
  const cache = JSON.stringify({
    models: [
      {
        slug: "gpt-5.7-nova",
        display_name: "GPT-5.7-Nova",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "ultra" },
        ],
        visibility: "list",
        supported_in_api: true,
      },
      {
        // Server view of an existing static model wins over the static row.
        slug: "gpt-5.5",
        display_name: "GPT-5.5 (server)",
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        visibility: "list",
        supported_in_api: true,
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "medium" }],
        visibility: "hide",
        supported_in_api: true,
      },
    ],
  });

  const catalog = buildModelCatalog({
    readFile: (p) => {
      expect(p.endsWith("models_cache.json")).toBe(true);
      return cache;
    },
    env: { CODEX_HOME: "/fake/codex-home" } as NodeJS.ProcessEnv,
  });

  it("adds server-only models with parsed efforts, default, and ultra cost hint", () => {
    const nova = entry(catalog, "codex", "gpt-5.7-nova");
    expect(nova.display).toBe("GPT-5.7-Nova");
    expect(nova.efforts).toEqual(["low", "medium", "ultra"]);
    expect(nova.defaultEffort).toBe("medium");
    expect(nova.costHint).toBe("highest cost/latency tier");
    expect(nova.roles).toEqual(["coding"]);
  });

  it("lets the server catalog win for models it lists", () => {
    const gpt55 = entry(catalog, "codex", "gpt-5.5");
    expect(gpt55.display).toBe("GPT-5.5 (server)");
    expect(gpt55.efforts).toEqual(["low", "high"]);
    expect(gpt55.defaultEffort).toBe("high");
  });

  it("excludes entries the server marks hidden", () => {
    expect(
      catalog.providers.codex.some((m) => m.id === "codex-auto-review"),
    ).toBe(false);
  });

  it("retains static models the server cache omits (spark keeps its flag)", () => {
    const spark = entry(catalog, "codex", "gpt-5.3-codex-spark");
    expect(spark.apiSupported).toBe(false);
    expect(catalog.providers.codex.some((m) => m.id === "gpt-5.6-terra")).toBe(
      true,
    );
  });

  it("resolves the cache path from CODEX_HOME", () => {
    let seen = "";
    buildModelCatalog({
      readFile: (p) => {
        seen = p;
        return cache;
      },
      env: { CODEX_HOME: "/opt/codex" } as NodeJS.ProcessEnv,
    });
    expect(seen).toBe("/opt/codex/models_cache.json");
  });
});

describe("codex cache failure fallback", () => {
  it.each([
    ["unparseable JSON", "{nope"],
    ["missing models array", JSON.stringify({ fetched_at: "now" })],
    ["no usable entries", JSON.stringify({ models: [{ slug: "" }] })],
  ])("falls back to the static table on %s", (_label, raw) => {
    const catalog = buildModelCatalog({
      readFile: () => raw,
      env: {} as NodeJS.ProcessEnv,
    });
    const ids = catalog.providers.codex.map((m) => m.id);
    expect(ids).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("falls back when the cache file cannot be read", () => {
    const catalog = buildModelCatalog(NO_CACHE);
    expect(catalog.providers.codex).toHaveLength(7);
  });
});

describe("claude chat/coding effort gates", () => {
  const catalog = buildModelCatalog(NO_CACHE);

  it("grants xhigh+ only to opus >= 4.7 and fable-5", () => {
    for (const provider of ["claude-chat", "claude-coding"]) {
      const full = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"];
      for (const id of full) {
        expect(entry(catalog, provider, id).efforts).toEqual([
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
      }
      for (const id of [
        "claude-opus-4-6",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
      ]) {
        expect(entry(catalog, provider, id).efforts).toEqual([
          "low",
          "medium",
          "high",
        ]);
      }
    }
    // Live-probed 2026-07-12: haiku rejects the chat-API effort parameter
    // entirely; only the coding CLI's separate effort env applies to it.
    expect(
      entry(catalog, "claude-chat", "claude-haiku-4-5-20251001").efforts,
    ).toEqual([]);
    expect(
      entry(catalog, "claude-coding", "claude-haiku-4-5-20251001").efforts,
    ).toEqual(["low", "medium", "high"]);
  });

  it("assigns chat models small+large and coding models coding", () => {
    for (const m of catalog.providers["claude-chat"]) {
      expect(m.roles).toEqual(["small", "large"]);
    }
    for (const m of catalog.providers["claude-coding"]) {
      expect(m.roles).toEqual(["coding"]);
    }
  });
});

describe("cerebras + elizacloud", () => {
  const catalog = buildModelCatalog(NO_CACHE);

  // reasoning_effort was live-probed 2026-07-12: gemma and zai-glm-4.7 both
  // modulate their emitted reasoning low->high, so they carry the knob too.
  it("exposes the low/medium/high effort knob on gemma and zai-glm-4.7", () => {
    expect(entry(catalog, "cerebras", "gemma-4-31b").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(entry(catalog, "cerebras", "zai-glm-4.7").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(entry(catalog, "elizacloud", "zai-glm-4.7").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps gpt-oss reasoning_effort at low/medium/high", () => {
    expect(entry(catalog, "cerebras", "gpt-oss-120b").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(entry(catalog, "elizacloud", "openai/gpt-oss-120b").efforts).toEqual(
      ["low", "medium", "high"],
    );
  });

  it("assigns gemma small-only on cerebras and the curated cloud trio small+large", () => {
    expect(entry(catalog, "cerebras", "gemma-4-31b").roles).toEqual(["small"]);
    expect(entry(catalog, "cerebras", "zai-glm-4.7").roles).toEqual([
      "small",
      "large",
    ]);
    for (const m of catalog.providers.elizacloud) {
      expect(m.roles).toEqual(["small", "large"]);
    }
    expect(catalog.providers.elizacloud.map((m) => m.id)).toEqual([
      "gpt-oss-120b",
      "openai/gpt-oss-120b",
      "zai-glm-4.7",
      "gemma-4-31b",
    ]);
  });

  it("returns fresh copies so callers cannot mutate the static tables", () => {
    const first = buildModelCatalog(NO_CACHE);
    first.providers.cerebras[0]?.efforts.push("bogus");
    first.providers.cerebras[0]?.roles.push("large");
    const second = buildModelCatalog(NO_CACHE);
    expect(entry(second, "cerebras", "gemma-4-31b").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(entry(second, "cerebras", "gemma-4-31b").roles).toEqual(["small"]);
  });
});

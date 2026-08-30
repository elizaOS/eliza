/**
 * Unit tests for the provider-to-model catalog's live Codex cache parsing,
 * merge semantics, and designed static fallback on a corrupt or absent cache.
 * Deterministic — filesystem reads are injected, no live provider is touched.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildModelCatalog } from "./model-catalog";

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
    const codexHome = path.resolve(path.sep, "opt", "codex");
    let seen = "";
    buildModelCatalog({
      readFile: (p) => {
        seen = p;
        return cache;
      },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    expect(seen).toBe(path.join(codexHome, "models_cache.json"));
  });
});

describe("codex cache failure fallback", () => {
  const fallback = buildModelCatalog(NO_CACHE).providers.codex;

  it.each([
    ["unparseable JSON", "{nope"],
    ["missing models array", JSON.stringify({ fetched_at: "now" })],
    ["no usable entries", JSON.stringify({ models: [{ slug: "" }] })],
  ])("falls back to the static table on %s", (_label, raw) => {
    const catalog = buildModelCatalog({
      readFile: () => raw,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(catalog.providers.codex).toEqual(fallback);
  });

  it("falls back when the cache file cannot be read", () => {
    const catalog = buildModelCatalog(NO_CACHE);
    expect(catalog.providers.codex).toEqual(fallback);
  });
});

describe("static catalog isolation", () => {
  it("returns fresh copies so callers cannot mutate the static tables", () => {
    const first = buildModelCatalog(NO_CACHE);
    const firstModel = first.providers.cerebras.at(0);
    if (!firstModel) throw new Error("static catalog is unexpectedly empty");
    const originalEfforts = [...firstModel.efforts];
    const originalRoles = [...firstModel.roles];
    firstModel.efforts.push("bogus");
    firstModel.roles.push("large");
    const second = buildModelCatalog(NO_CACHE);
    const secondModel = second.providers.cerebras.at(0);
    if (!secondModel) throw new Error("static catalog is unexpectedly empty");
    expect(secondModel.efforts).toEqual(originalEfforts);
    expect(secondModel.roles).toEqual(originalRoles);
  });
});

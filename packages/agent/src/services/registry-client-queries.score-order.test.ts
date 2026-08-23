/**
 * Exercises the real `scoreEntries` ranking over hand-built registry entries.
 * Registry payloads are third-party JSON, so `stars` can arrive unusable; the
 * ranking must still be a total order — score first, then stars with an
 * unusable star count treated as none, then package name. Pure function, no I/O.
 */
import { describe, expect, it } from "vitest";
import { scoreEntries } from "./registry-client-queries.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

function entry(name: string, stars: number): RegistryPluginInfo {
  return {
    name,
    gitRepo: `elizaos/${name}`,
    gitUrl: `https://github.com/elizaos/${name}`,
    description: "A vault plugin for storing secrets.",
    homepage: null,
    topics: [],
    stars,
    language: "TypeScript",
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    },
    git: { v0Branch: null, v1Branch: null, v2Branch: null },
    supports: { v0: false, v1: false, v2: true },
  };
}

describe("scoreEntries ranking", () => {
  it("ranks a corrupted star count below real ones and tie-breaks by name", () => {
    // All three match the query identically, so the star tier and then the
    // name decide. Declared worst-first: a comparator that returns NaN for the
    // corrupted row, or 0 for the tie, leaves this order untouched.
    const entries = [
      entry("@elizaos/plugin-broken-vault", Number.NaN),
      entry("@elizaos/plugin-zeta-vault", 40),
      entry("@elizaos/plugin-alpha-vault", 40),
    ];

    const ranked = scoreEntries(entries, "vault", 10);

    expect(ranked.map((row) => row.p.name)).toEqual([
      "@elizaos/plugin-alpha-vault",
      "@elizaos/plugin-zeta-vault",
      "@elizaos/plugin-broken-vault",
    ]);
    // Guards the premise: the ordering above is not driven by the score.
    expect(new Set(ranked.map((row) => row.s)).size).toBe(1);
  });
});

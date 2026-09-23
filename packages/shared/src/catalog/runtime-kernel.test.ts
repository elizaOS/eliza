/**
 * Behavioral coverage for the runtime registry kernel using representative
 * generated wire data, invalid input, deterministic search, and TTL edges.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_REGISTRY_SEARCH_POLICY,
  decodeRuntimeRegistry,
  isRegistryCacheFresh,
  searchRegistryEntries,
} from "./runtime-kernel.ts";

function wireEntry(name = "@elizaos/plugin-example") {
  return {
    git: {
      repo: "elizaos/plugin-example",
      v0: { branch: null },
      v1: { branch: null },
      v2: { branch: "main" },
    },
    npm: { repo: name, v0: null, v1: null, v2: "2.0.0" },
    supports: { v0: false, v1: false, v2: true },
    description: "Example search provider",
    homepage: null,
    topics: ["search"],
    stargazers_count: 550,
    language: "TypeScript",
  };
}

describe("decodeRuntimeRegistry", () => {
  it("normalizes registry and legacy apps sections through one path", () => {
    const decoded = decodeRuntimeRegistry(
      {
        registry: { "@elizaos/plugin-example": wireEntry() },
        apps: {
          "@elizaos/app-example": {
            ...wireEntry("@elizaos/app-example"),
            app: {
              displayName: "Example App",
              viewer: { url: "https://example.test", sandbox: "unsafe" },
            },
          },
        },
      },
      {
        sanitizeSandbox: () => "allow-scripts",
      },
    );

    expect(decoded.get("@elizaos/plugin-example")).toMatchObject({
      gitUrl: "https://github.com/elizaos/plugin-example.git",
      npm: { package: "@elizaos/plugin-example", v2Version: "2.0.0" },
    });
    expect(decoded.get("@elizaos/app-example")).toMatchObject({
      kind: "app",
      app: { viewer: { sandbox: "allow-scripts" } },
    });
  });

  it("rejects malformed generated entries instead of fabricating a plugin", () => {
    expect(() =>
      decodeRuntimeRegistry({ registry: { broken: { npm: {} } } }),
    ).toThrow();
  });
});

describe("searchRegistryEntries", () => {
  it("uses score, finite popularity, and package name as a total order", () => {
    const entries = [
      { name: "z-search", description: "search", topics: [], stars: 20 },
      {
        name: "broken-search",
        description: "search",
        topics: [],
        stars: Number.NaN,
      },
      { name: "a-search", description: "search", topics: [], stars: 20 },
    ];
    expect(
      searchRegistryEntries(entries, "search", 10).map(
        ({ entry }) => entry.name,
      ),
    ).toEqual(["a-search", "z-search", "broken-search"]);
  });

  it("preserves host popularity policies without duplicating search logic", () => {
    const entries = [
      { name: "search-small", description: "search", topics: [], stars: 100 },
      { name: "search-large", description: "search", topics: [], stars: 1001 },
    ];
    const agentScores = searchRegistryEntries(entries, "search", 10);
    const coreScores = searchRegistryEntries(
      entries,
      "search",
      10,
      undefined,
      undefined,
      CORE_REGISTRY_SEARCH_POLICY,
    );

    expect(agentScores.map(({ score }) => score)).toEqual([115, 105]);
    expect(coreScores.map(({ score }) => score)).toEqual([120, 105]);
    expect(agentScores.map(({ entry }) => entry.name)).toEqual(
      coreScores.map(({ entry }) => entry.name),
    );
  });
});

describe("isRegistryCacheFresh", () => {
  it("rejects expired, future-dated, and non-finite cache timestamps", () => {
    expect(isRegistryCacheFresh(1_000, 100, 1_099)).toBe(true);
    expect(isRegistryCacheFresh(1_000, 100, 1_100)).toBe(false);
    expect(isRegistryCacheFresh(1_001, 100, 1_000)).toBe(false);
    expect(isRegistryCacheFresh(Number.NaN, 100, 1_000)).toBe(false);
  });
});

/**
 * Guards the first-party registry generator's exported collectors: curated-app
 * definition ordering (order, ties, non-finite fallback), npmName gating,
 * sorted stable keys, and fail-loud conflict detection across the channel /
 * short-id / provider maps. Harness is real — the live module runs on
 * in-memory fixtures; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  collectChannelPluginMap,
  collectCuratedAppDefinitions,
  collectProviderPluginMap,
  collectShortIdPluginMap,
} from "./generate";
import type { PluginEntry } from "./schema";

function pluginEntry(
  id: string,
  overrides?: Partial<PluginEntry>,
): PluginEntry {
  return {
    id,
    name: id,
    source: "bundled",
    tags: [],
    config: {},
    render: {
      visible: true,
      pinTo: [],
      style: "card",
      group: "models",
      actions: [],
    },
    resources: {},
    dependsOn: [],
    channels: [],
    shortIds: [],
    kind: "plugin",
    subtype: "feature",
    ...overrides,
  };
}

function curatedEntry(
  id: string,
  npmName: string | undefined,
  slug: string,
  order: number,
  aliases: string[],
): PluginEntry {
  return pluginEntry(id, { npmName, curatedApp: { slug, order, aliases } });
}

describe("collectCuratedAppDefinitions", () => {
  it("returns no definitions for an empty entry list", () => {
    expect(collectCuratedAppDefinitions([])).toEqual([]);
  });

  it("keeps only entries marked as curated apps", () => {
    const curated = curatedEntry(
      "marked",
      "@elizaos/plugin-marked",
      "marked",
      1,
      [],
    );
    expect(
      collectCuratedAppDefinitions([curated, pluginEntry("plain")]),
    ).toEqual([
      { slug: "marked", canonicalName: "@elizaos/plugin-marked", aliases: [] },
    ]);
  });

  it("orders curated apps by their declared order", () => {
    const entries = [
      curatedEntry("late", "@elizaos/plugin-late", "late", 30, []),
      curatedEntry("first", "@elizaos/plugin-first", "first", 10, []),
      curatedEntry("middle", "@elizaos/plugin-middle", "middle", 20, []),
    ];
    expect(collectCuratedAppDefinitions(entries).map((d) => d.slug)).toEqual([
      "first",
      "middle",
      "late",
    ]);
  });

  it("treats a non-finite order as position zero", () => {
    const infinite = curatedEntry(
      "infinite",
      "@elizaos/plugin-infinite",
      "infinite",
      Number.POSITIVE_INFINITY,
      [],
    );
    const finite = curatedEntry(
      "finite",
      "@elizaos/plugin-finite",
      "finite",
      5,
      [],
    );
    expect(
      collectCuratedAppDefinitions([finite, infinite]).map((d) => d.slug),
    ).toEqual(["infinite", "finite"]);
  });

  it("breaks order ties by slug", () => {
    const entries = [
      curatedEntry("delta", "@elizaos/plugin-delta", "delta", 2, []),
      curatedEntry("alpha", "@elizaos/plugin-alpha", "alpha", 2, []),
    ];
    expect(collectCuratedAppDefinitions(entries).map((d) => d.slug)).toEqual([
      "alpha",
      "delta",
    ]);
  });

  it("maps canonicalName from npmName with an empty-string fallback and passes aliases through", () => {
    const named = curatedEntry("named", "@elizaos/plugin-named", "named", 1, [
      "nm",
    ]);
    const unnamed = curatedEntry("unnamed", undefined, "unnamed", 2, []);
    expect(collectCuratedAppDefinitions([named, unnamed])).toEqual([
      {
        slug: "named",
        canonicalName: "@elizaos/plugin-named",
        aliases: ["nm"],
      },
      { slug: "unnamed", canonicalName: "", aliases: [] },
    ]);
  });
});

describe("collectChannelPluginMap", () => {
  it("ignores metadata-only entries that declare channels but ship no package", () => {
    const orphan = pluginEntry("orphan", { channels: ["orphan"] });
    expect(collectChannelPluginMap([orphan])).toEqual({});
  });

  it("maps each claimed channel to its package and sorts the keys", () => {
    const map = collectChannelPluginMap([
      pluginEntry("one", {
        npmName: "@elizaos/plugin-one",
        channels: ["zeta", "alpha"],
      }),
      pluginEntry("two", { npmName: "@elizaos/plugin-two", channels: ["mu"] }),
    ]);
    expect(map).toEqual({
      alpha: "@elizaos/plugin-one",
      mu: "@elizaos/plugin-two",
      zeta: "@elizaos/plugin-one",
    });
    expect(Object.keys(map)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("allows one package to re-declare the same channel", () => {
    expect(
      collectChannelPluginMap([
        pluginEntry("same", {
          npmName: "@elizaos/plugin-same",
          channels: ["dupe", "dupe"],
        }),
      ]),
    ).toEqual({ dupe: "@elizaos/plugin-same" });
  });

  it("rejects conflicting channel claims across packages (fail-loud on drift)", () => {
    expect(() =>
      collectChannelPluginMap([
        pluginEntry("one", {
          npmName: "@elizaos/plugin-one",
          channels: ["dupe"],
        }),
        pluginEntry("two", {
          npmName: "@elizaos/plugin-two",
          channels: ["dupe"],
        }),
      ]),
    ).toThrow(
      'channel "dupe" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });
});

describe("collectShortIdPluginMap", () => {
  it("derives short ids only from explicit markers and sorts the resulting keys", () => {
    const map = collectShortIdPluginMap([
      pluginEntry("aliased", {
        npmName: "@elizaos/plugin-aliased",
        shortIds: ["zeta", "alpha"],
      }),
      pluginEntry("bare", {
        npmName: "@elizaos/plugin-bare",
        shortIds: ["mu"],
      }),
    ]);
    expect(map).toEqual({
      alpha: "@elizaos/plugin-aliased",
      mu: "@elizaos/plugin-bare",
      zeta: "@elizaos/plugin-aliased",
    });
    expect(Object.keys(map)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("ignores entries that claim short ids without shipping a package", () => {
    const orphan = pluginEntry("orphan", { shortIds: ["orphan"] });
    expect(collectShortIdPluginMap([orphan])).toEqual({});
  });

  it("allows one package to re-declare the same short id", () => {
    expect(
      collectShortIdPluginMap([
        pluginEntry("same", {
          npmName: "@elizaos/plugin-same",
          shortIds: ["same", "same"],
        }),
      ]),
    ).toEqual({ same: "@elizaos/plugin-same" });
  });

  it("rejects conflicting short-id claims across packages (fail-loud on drift)", () => {
    expect(() =>
      collectShortIdPluginMap([
        pluginEntry("one", {
          npmName: "@elizaos/plugin-one",
          shortIds: ["dupe"],
        }),
        pluginEntry("two", {
          npmName: "@elizaos/plugin-two",
          shortIds: ["dupe"],
        }),
      ]),
    ).toThrow(
      'short id "dupe" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });
});

describe("collectProviderPluginMap", () => {
  it("derives provider env keys only from autoEnableProvider === true markers and sorts them", () => {
    const map = collectProviderPluginMap([
      pluginEntry("one", {
        npmName: "@elizaos/plugin-one",
        config: {
          B_KEY: { type: "secret", required: false, autoEnableProvider: true },
          A_KEY: { type: "secret", required: false, autoEnableProvider: false },
        },
      }),
      pluginEntry("two", {
        npmName: "@elizaos/plugin-two",
        config: {
          C_KEY: { type: "string", required: false, autoEnableProvider: true },
        },
      }),
    ]);
    expect(map).toEqual({
      B_KEY: "@elizaos/plugin-one",
      C_KEY: "@elizaos/plugin-two",
    });
    expect(Object.keys(map)).toEqual(["B_KEY", "C_KEY"]);
  });

  it("ignores metadata-only entries whose config marks autoEnableProvider", () => {
    const orphan = pluginEntry("orphan", {
      config: {
        ORPHAN_API_KEY: {
          type: "secret",
          required: false,
          autoEnableProvider: true,
        },
      },
    });
    expect(collectProviderPluginMap([orphan])).toEqual({});
  });

  it("rejects conflicting provider env-key claims across packages (fail-loud on drift)", () => {
    expect(() =>
      collectProviderPluginMap([
        pluginEntry("one", {
          npmName: "@elizaos/plugin-one",
          config: {
            DUPE_API_KEY: {
              type: "secret",
              required: false,
              autoEnableProvider: true,
            },
          },
        }),
        pluginEntry("two", {
          npmName: "@elizaos/plugin-two",
          config: {
            DUPE_API_KEY: {
              type: "secret",
              required: false,
              autoEnableProvider: true,
            },
          },
        }),
      ]),
    ).toThrow(
      'provider env key "DUPE_API_KEY" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  applyResolutions,
  buildCatalogSnapshot,
  type CatalogLike,
  coerceClarifications,
  parseParamPath,
  pruneResolvedClarifications,
  setByDotPath,
} from "./n8n-clarification";

describe("coerceClarifications", () => {
  it("returns [] for null/undefined/non-array input", () => {
    expect(coerceClarifications(undefined)).toEqual([]);
    expect(coerceClarifications(null)).toEqual([]);
    expect(coerceClarifications("")).toEqual([]);
    expect(coerceClarifications({})).toEqual([]);
  });

  it("normalizes legacy strings into free_text requests", () => {
    const out = coerceClarifications([
      "Which channel?",
      "  Trim me  ",
      "",
      "   ",
    ]);
    expect(out).toEqual([
      { kind: "free_text", question: "Which channel?", paramPath: "" },
      { kind: "free_text", question: "Trim me", paramPath: "" },
    ]);
  });

  it("passes valid structured items through verbatim", () => {
    const item = {
      kind: "target_channel",
      platform: "discord",
      scope: { guildId: "1234" },
      question: "Which channel in Cozy Devs?",
      paramPath: 'nodes["Discord Send"].parameters.channelId',
    };
    expect(coerceClarifications([item])).toEqual([item]);
  });

  it("clamps unknown kind to free_text and defaults missing paramPath", () => {
    const out = coerceClarifications([{ kind: "wat", question: "Q?" }]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("free_text");
    expect(out[0].question).toBe("Q?");
    expect(out[0].paramPath).toBe("");
  });

  it("drops items missing a question", () => {
    expect(
      coerceClarifications([
        { kind: "value", paramPath: "nodes[0].parameters.x" },
        { kind: "value", question: "", paramPath: "nodes[0].parameters.x" },
      ]),
    ).toEqual([]);
  });
});

describe("parseParamPath", () => {
  it("handles plain dot identifiers", () => {
    expect(parseParamPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("handles bracketed double-quoted keys with spaces", () => {
    expect(
      parseParamPath('nodes["Discord Send"].parameters.channelId'),
    ).toEqual(["nodes", "Discord Send", "parameters", "channelId"]);
  });

  it("handles bracketed single-quoted keys", () => {
    expect(parseParamPath("a['x y'].b")).toEqual(["a", "x y", "b"]);
  });

  it("handles array indices", () => {
    expect(parseParamPath("nodes[0].parameters.guildId")).toEqual([
      "nodes",
      "0",
      "parameters",
      "guildId",
    ]);
  });

  it("rejects unterminated brackets", () => {
    expect(() => parseParamPath("nodes[0")).toThrow(/unterminated bracket/);
  });

  it("rejects empty brackets", () => {
    expect(() => parseParamPath("nodes[]")).toThrow(/empty bracket/);
  });

  it("rejects empty paths", () => {
    expect(() => parseParamPath("")).toThrow(/no segments/);
  });
});

describe("setByDotPath", () => {
  it("sets a deeply-nested object value, creating intermediates", () => {
    const draft: Record<string, unknown> = {};
    setByDotPath(draft, 'nodes["Discord Send"].parameters.channelId', "9876");
    expect(draft).toEqual({
      nodes: {
        "Discord Send": { parameters: { channelId: "9876" } },
      },
    });
  });

  it("sets a value inside an existing array element", () => {
    const draft: Record<string, unknown> = {
      nodes: [{ parameters: {} }, { parameters: {} }],
    };
    setByDotPath(draft, "nodes[1].parameters.guildId", "1234");
    expect((draft.nodes as Array<{ parameters: { guildId?: string } }>)[1]
      .parameters.guildId).toBe("1234");
  });

  it("creates array intermediates when the next segment is numeric", () => {
    const draft: Record<string, unknown> = {};
    setByDotPath(draft, "nodes[0].id", "n1");
    expect(draft.nodes).toEqual([{ id: "n1" }]);
  });

  it("rejects descent through a non-object intermediate", () => {
    const draft: Record<string, unknown> = { a: "scalar" };
    expect(() => setByDotPath(draft, "a.b", "x")).toThrow(
      /cannot descend into non-object/,
    );
  });

  it("rejects array path with non-numeric terminal segment", () => {
    const draft: Record<string, unknown> = { nodes: [] };
    expect(() => setByDotPath(draft, "nodes.x", "v")).toThrow();
  });
});

describe("applyResolutions", () => {
  it("applies multiple resolutions in order", () => {
    const draft: Record<string, unknown> = { nodes: {} };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["Discord Send"].parameters.guildId',
        value: "1234",
      },
      {
        paramPath: 'nodes["Discord Send"].parameters.channelId',
        value: "9876",
      },
    ]);
    expect(result.ok).toBe(true);
    expect(draft).toEqual({
      nodes: {
        "Discord Send": {
          parameters: { guildId: "1234", channelId: "9876" },
        },
      },
    });
  });

  it("rejects a missing paramPath", () => {
    const draft: Record<string, unknown> = {};
    expect(
      applyResolutions(draft, [
        { paramPath: "", value: "x" } as never,
      ]),
    ).toEqual({ ok: false, error: "resolution missing paramPath" });
  });

  it("rejects a malformed paramPath and reports it", () => {
    const draft: Record<string, unknown> = {};
    const result = applyResolutions(draft, [
      { paramPath: "nodes[", value: "x" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.paramPath).toBe("nodes[");
      expect(result.error).toContain("unterminated bracket");
    }
  });

  it("rejects non-string values", () => {
    const draft: Record<string, unknown> = {};
    const result = applyResolutions(draft, [
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
      { paramPath: "x", value: 1 as any },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("pruneResolvedClarifications", () => {
  it("removes structured items whose paramPath was resolved", () => {
    const draft: Record<string, unknown> = {
      _meta: {
        requiresClarification: [
          {
            kind: "target_server",
            question: "Server?",
            paramPath: "nodes[0].parameters.guildId",
          },
          {
            kind: "target_channel",
            question: "Channel?",
            paramPath: "nodes[0].parameters.channelId",
          },
        ],
      },
    };
    pruneResolvedClarifications(
      draft,
      new Set(["nodes[0].parameters.guildId"]),
    );
    const list = (
      draft._meta as { requiresClarification: Array<{ paramPath: string }> }
    ).requiresClarification;
    expect(list).toHaveLength(1);
    expect(list[0].paramPath).toBe("nodes[0].parameters.channelId");
  });

  it("preserves legacy free-text strings (no paramPath to match)", () => {
    const draft: Record<string, unknown> = {
      _meta: { requiresClarification: ["Pick a thing"] },
    };
    pruneResolvedClarifications(draft, new Set(["any"]));
    expect(
      (draft._meta as { requiresClarification: string[] })
        .requiresClarification,
    ).toEqual(["Pick a thing"]);
  });

  it("deletes the field entirely when nothing remains", () => {
    const draft: Record<string, unknown> = {
      _meta: {
        requiresClarification: [
          {
            kind: "value",
            question: "Q",
            paramPath: "nodes[0].parameters.x",
          },
        ],
      },
    };
    pruneResolvedClarifications(
      draft,
      new Set(["nodes[0].parameters.x"]),
    );
    expect(
      (draft._meta as { requiresClarification?: unknown })
        .requiresClarification,
    ).toBeUndefined();
  });

  it("is a no-op when there is no _meta or no list", () => {
    const drafts: Record<string, unknown>[] = [
      {},
      { _meta: {} },
      { _meta: { requiresClarification: "not-an-array" } },
    ];
    for (const d of drafts) {
      expect(() => pruneResolvedClarifications(d, new Set())).not.toThrow();
    }
  });
});

describe("buildCatalogSnapshot", () => {
  function makeCatalog(
    fixture: Record<string, Array<{ groupId: string; targets: unknown[] }>>,
  ): { catalog: CatalogLike; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      catalog: {
        async listGroups(opts) {
          calls.push(opts?.platform ?? "*");
          const platform = opts?.platform ?? "*";
          return (fixture[platform] ?? []).map((g) => ({
            platform,
            groupId: g.groupId,
            groupName: `name-${g.groupId}`,
            targets: g.targets as never,
          }));
        },
      },
    };
  }

  it("queries the catalog for each unique platform", async () => {
    const { catalog, calls } = makeCatalog({
      discord: [{ groupId: "g1", targets: [] }],
      slack: [{ groupId: "w1", targets: [] }],
    });
    await buildCatalogSnapshot(catalog, [
      {
        kind: "target_server",
        platform: "discord",
        question: "Q",
        paramPath: "x",
      },
      {
        kind: "target_channel",
        platform: "discord",
        question: "Q",
        paramPath: "y",
      },
      {
        kind: "recipient",
        platform: "slack",
        question: "Q",
        paramPath: "z",
      },
    ]);
    expect(calls.sort()).toEqual(["discord", "slack"]);
  });

  it("deduplicates groups across multiple clarifications", async () => {
    const { catalog } = makeCatalog({
      discord: [{ groupId: "g1", targets: [] }],
    });
    const snapshot = await buildCatalogSnapshot(catalog, [
      {
        kind: "target_server",
        platform: "discord",
        question: "Q",
        paramPath: "x",
      },
      {
        kind: "target_channel",
        platform: "discord",
        question: "Q",
        paramPath: "y",
      },
    ]);
    expect(snapshot).toHaveLength(1);
  });

  it("returns [] when no clarification names a platform", async () => {
    const { catalog, calls } = makeCatalog({});
    const snapshot = await buildCatalogSnapshot(catalog, [
      { kind: "free_text", question: "Q", paramPath: "" },
    ]);
    expect(snapshot).toEqual([]);
    expect(calls).toEqual([]);
  });
});

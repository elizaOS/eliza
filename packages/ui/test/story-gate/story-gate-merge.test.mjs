import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeStoryGateArtifacts,
  mergeStoryGateReports,
  storyIdsFromCatalog,
} from "./merge-story-gate.mjs";

function report(shard, results, failures = []) {
  return {
    shard,
    schema: "eliza_story_gate_v1",
    totals: { stories: results.length, failures: failures.length },
    failures,
    results,
  };
}

function story(id) {
  return {
    id,
    title: id,
    name: "Default",
    verdict: "good",
    issues: [],
    consoleErrors: [],
    a11y: [],
    play: { expected: false, prepared: false, phase: null },
    blank: { expected: false, detected: false },
  };
}

describe("story-gate report aggregation", () => {
  it("extracts only Storybook story entries in deterministic order", () => {
    expect(
      storyIdsFromCatalog({
        entries: {
          z: { type: "story", id: "z--story" },
          docs: { type: "docs", id: "docs--page" },
          a: { type: "story", id: "a--story" },
        },
      }),
    ).toEqual(["a--story", "z--story"]);
  });

  it("merges a complete shard set and preserves every result", () => {
    const merged = mergeStoryGateReports({
      catalog: {
        entries: {
          a: { type: "story", id: "a--story" },
          z: { type: "story", id: "z--story" },
        },
      },
      reports: [
        report("1/2", [story("a--story")]),
        report("2/2", [story("z--story")]),
      ],
      expectedShards: ["1/2", "2/2"],
    });

    expect(merged.results.map((result) => result.id)).toEqual([
      "a--story",
      "z--story",
    ]);
    expect(merged.totals).toMatchObject({ stories: 2, failures: 0 });
  });

  it.each([
    ["a shard is missing", [], /missing shard report: 1\/2/],
    [
      "a story is duplicated",
      [report("1/2", [story("a--story")]), report("2/2", [story("a--story")])],
      /duplicate story id: a--story/,
    ],
    [
      "a story is missing from the union",
      [report("1/2", []), report("2/2", [story("z--story")])],
      /missing story ids: a--story/,
    ],
  ])("fails closed when %s", (_label, reports, expected) => {
    expect(() =>
      mergeStoryGateReports({
        catalog: {
          entries: {
            a: { type: "story", id: "a--story" },
            z: { type: "story", id: "z--story" },
          },
        },
        reports,
        expectedShards: ["1/2", "2/2"],
      }),
    ).toThrow(expected);
  });

  it("retains shard failures for the aggregate gate to reject", () => {
    const merged = mergeStoryGateReports({
      catalog: {
        entries: {
          a: { type: "story", id: "a--story" },
          z: { type: "story", id: "z--story" },
        },
      },
      reports: [
        report(
          "1/2",
          [story("a--story")],
          [{ id: "a--story", kind: "broken", detail: "render threw" }],
        ),
        report("2/2", [story("z--story")]),
      ],
      expectedShards: ["1/2", "2/2"],
    });

    expect(merged.totals.failures).toBe(1);
    expect(merged.failures[0]).toMatchObject({
      id: "a--story",
      shard: "1/2",
    });
  });

  it("writes an aggregate report when a shard artifact is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-gate-merge-"));
    const catalogPath = join(root, "catalog.json");
    const inputDir = join(root, "shards");
    const outDir = join(root, "output");

    try {
      await mkdir(join(inputDir, "story-gate-shard-1-of-2"), {
        recursive: true,
      });
      await writeFile(
        catalogPath,
        JSON.stringify({
          entries: {
            a: { type: "story", id: "a--story" },
            z: { type: "story", id: "z--story" },
          },
        }),
      );
      await writeFile(
        join(inputDir, "story-gate-shard-1-of-2", "report.json"),
        JSON.stringify(report("1/2", [story("a--story")])),
      );

      await expect(
        mergeStoryGateArtifacts({
          catalogPath,
          inputDir,
          outDir,
          shardCount: 2,
        }),
      ).rejects.toThrow("missing shard report: 2/2");

      const aggregate = JSON.parse(
        await readFile(join(outDir, "report.json"), "utf8"),
      );
      expect(aggregate).toMatchObject({
        schema: "eliza_story_gate_aggregate_v1",
        totals: { stories: 0, failures: 1 },
        failures: [{ kind: "aggregate-validation" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks manual review as failed before rejecting shard failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-gate-merge-"));
    const catalogPath = join(root, "catalog.json");
    const inputDir = join(root, "shards");
    const outDir = join(root, "output");

    try {
      await writeFile(
        catalogPath,
        JSON.stringify({ entries: { a: { type: "story", id: "a--story" } } }),
      );
      const shardDir = join(inputDir, "story-gate-shard-1-of-1");
      await mkdir(join(shardDir, "screenshots"), { recursive: true });
      await writeFile(
        join(shardDir, "report.json"),
        JSON.stringify(
          report(
            "1/1",
            [story("a--story")],
            [{ id: "a--story", kind: "broken", detail: "render threw" }],
          ),
        ),
      );

      await expect(
        mergeStoryGateArtifacts({
          catalogPath,
          inputDir,
          outDir,
          shardCount: 1,
        }),
      ).rejects.toThrow("shard failures: 1/1: 1");

      expect(
        await readFile(join(outDir, "manual-review.md"), "utf8"),
      ).toContain("FAIL: 1 regression(s)");
      expect(
        JSON.parse(await readFile(join(outDir, "report.json"), "utf8")),
      ).toMatchObject({
        totals: { stories: 1, failures: 1 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unexpected story ids instead of silently dropping them", () => {
    expect(() =>
      mergeStoryGateReports({
        catalog: { entries: { a: { type: "story", id: "a--story" } } },
        reports: [report("1/1", [story("unexpected--story")])],
        expectedShards: ["1/1"],
      }),
    ).toThrow(/unexpected story ids: unexpected--story/);
  });

  it("rejects duplicate shard expectations and malformed failures", () => {
    expect(() =>
      mergeStoryGateReports({
        catalog: { entries: { a: { type: "story", id: "a--story" } } },
        reports: [report("1/1", [story("a--story")])],
        expectedShards: ["1/1", "1/1"],
      }),
    ).toThrow(/expectedShards must not contain duplicates/);

    expect(() =>
      mergeStoryGateReports({
        catalog: { entries: { a: { type: "story", id: "a--story" } } },
        reports: [report("1/1", [story("a--story")], [null])],
        expectedShards: ["1/1"],
      }),
    ).toThrow(/invalid shard failure entry/);
  });

  it("rejects a result with no supported verdict", () => {
    expect(() =>
      mergeStoryGateReports({
        catalog: { entries: { a: { type: "story", id: "a--story" } } },
        reports: [
          report("1/1", [{ ...story("a--story"), verdict: undefined }]),
        ],
        expectedShards: ["1/1"],
      }),
    ).toThrow(/invalid story verdict for a--story: missing/);
  });

  it("rejects a complete catalog when every story is only needs-runtime", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `story-${index}`,
        { type: "story", id: `story-${index}` },
      ]),
    );
    const results = Object.values(entries).map(({ id }) => ({
      ...story(id),
      verdict: "needs-runtime",
    }));

    expect(() =>
      mergeStoryGateReports({
        catalog: { entries },
        reports: [report("1/1", results)],
        expectedShards: ["1/1"],
      }),
    ).toThrow(/aggregate self-check failed/);
  });
});

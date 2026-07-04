/**
 * Covers the deterministic EMA scorer: clean features outscore WIP dumps, test
 * touches earn a bonus, the running average stays bounded, and a revert of a
 * recent commit back-penalizes its target. Pure, no git or model.
 */

import { describe, expect, it } from "vitest";
import { classify } from "../src/pipeline/classify.ts";
import { score } from "../src/pipeline/score.ts";
import type { RawCommit } from "../src/types.ts";

function commit(
  sha: string,
  subject: string,
  parents: string[],
  files: RawCommit["files"]
): RawCommit {
  return {
    sha: sha.padEnd(40, "0"),
    parents,
    author: "alice",
    authorEmail: "alice@example.com",
    date: "2026-04-01T10:00:00Z",
    subject,
    body: "",
    files,
    diffSnippet: "",
  };
}

describe("score", () => {
  it("assigns higher delta to clean features than to wip dumps", () => {
    const raw = [
      commit(
        "aaa1111",
        "feat: add a",
        [],
        [{ path: "src/a.ts", added: 30, deleted: 0, status: "A" }]
      ),
      commit(
        "bbb2222",
        "wip: dump",
        [],
        [
          { path: "src/big1.ts", added: 800, deleted: 0, status: "A" },
          { path: "src/big2.ts", added: 600, deleted: 0, status: "A" },
        ]
      ),
    ];
    const points = score(classify(raw));
    const feat = points[0];
    const wip = points[1];
    expect(feat).toBeDefined();
    expect(wip).toBeDefined();
    expect(feat?.delta).toBeGreaterThan(wip?.delta ?? 0);
  });

  it("rewards commits that touch tests", () => {
    const withTest = score(
      classify([
        commit(
          "aaa1111",
          "refactor: clean helper",
          [],
          [
            { path: "src/helper.ts", added: 20, deleted: 5, status: "M" },
            { path: "src/__tests__/helper.test.ts", added: 30, deleted: 0, status: "A" },
          ]
        ),
      ])
    );
    const withoutTest = score(
      classify([
        commit(
          "bbb2222",
          "refactor: clean helper",
          [],
          [{ path: "src/helper.ts", added: 20, deleted: 5, status: "M" }]
        ),
      ])
    );
    expect(withTest[0]?.delta).toBeGreaterThan(withoutTest[0]?.delta ?? 0);
  });

  it("running EMA stays bounded for clean history", () => {
    const raw = Array.from({ length: 10 }, (_, i) =>
      commit(
        `abc${i}`,
        `feat: item ${i}`,
        [],
        [{ path: `src/f${i}.ts`, added: 20, deleted: 5, status: "A" }]
      )
    );
    const points = score(classify(raw));
    expect(points.every((p) => Math.abs(p.score) < 2)).toBe(true);
  });

  it("applies later-reverted penalty when a revert references a recent sha", () => {
    const target = commit(
      "aaa1111",
      "feat: probably-bad",
      [],
      [{ path: "src/bad.ts", added: 50, deleted: 0, status: "A" }]
    );
    const revert = commit(
      "bbb2222",
      "revert: undo it",
      [],
      [{ path: "src/bad.ts", added: 0, deleted: 50, status: "D" }]
    );
    revert.body = `This reverts commit ${target.sha}.`;
    const points = score(classify([target, revert]));
    const targetPoint = points[0];
    expect(targetPoint?.riskFlags).toContain("later-reverted");
  });
});

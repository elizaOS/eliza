import { describe, expect, it } from "vitest";
import { classify, classifyOne } from "../src/pipeline/classify.ts";
import type { RawCommit } from "../src/types.ts";

function baseCommit(subject: string, overrides: Partial<RawCommit> = {}): RawCommit {
  return {
    sha: "abc1234abc1234abc1234abc1234abc1234abcd",
    parents: ["00000000"],
    author: "alice",
    authorEmail: "alice@example.com",
    date: "2026-04-01T10:00:00Z",
    subject,
    body: "",
    files: [{ path: "src/x.ts", added: 5, deleted: 1, status: "M" }],
    diffSnippet: "",
    ...overrides,
  };
}

describe("classifyOne", () => {
  it("recognizes conventional commit prefixes", () => {
    expect(classifyOne(baseCommit("feat: add login")).type).toBe("feature");
    expect(classifyOne(baseCommit("fix: handle null")).type).toBe("fix");
    expect(classifyOne(baseCommit("refactor: extract helper")).type).toBe("refactor");
    expect(classifyOne(baseCommit("chore: bump deps")).type).toBe("chore");
    expect(classifyOne(baseCommit("perf: cache hot path")).type).toBe("refactor");
    expect(classifyOne(baseCommit("docs: update README")).type).toBe("chore");
  });

  it("flags WIP commits with risk", () => {
    const c = classifyOne(baseCommit("wip: still working"));
    expect(c.type).toBe("wip");
    expect(c.riskFlags).toContain("wip-message");
  });

  it("identifies reverts", () => {
    const c = classifyOne(baseCommit('Revert "feat: bad idea"'));
    expect(c.type).toBe("revert");
    expect(c.riskFlags).toContain("revert-subject");
  });

  it("identifies merges by parent count", () => {
    const c = classifyOne(baseCommit("Merge branch foo", { parents: ["a", "b"] }));
    expect(c.type).toBe("merge");
  });

  it("flags large churn", () => {
    const c = classifyOne(
      baseCommit("feat: big feature", {
        files: [{ path: "src/big.ts", added: 700, deleted: 50, status: "M" }],
      })
    );
    expect(c.riskFlags).toContain("large-churn");
  });

  it("flags wide blast radius", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/f${i}.ts`,
      added: 1,
      deleted: 0,
      status: "M" as const,
    }));
    const c = classifyOne(baseCommit("chore: sweep", { files }));
    expect(c.riskFlags).toContain("wide-blast");
  });

  it("flags breaking changes via ! marker", () => {
    const c = classifyOne(baseCommit("feat!: drop legacy API"));
    expect(c.type).toBe("feature");
    expect(c.riskFlags).toContain("breaking");
  });

  it("falls back to other for opaque subjects", () => {
    expect(classifyOne(baseCommit("did stuff")).type).toBe("other");
  });
});

describe("classify (batch)", () => {
  it("preserves order and classifies all", () => {
    const input = [baseCommit("feat: a"), baseCommit("fix: b"), baseCommit("wip: c")];
    const out = classify(input);
    expect(out.map((c) => c.type)).toEqual(["feature", "fix", "wip"]);
    expect(out.every((c) => c.classifiedBy === "rule")).toBe(true);
  });
});

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headSha, normalizeSince, scan } from "../src/pipeline/scan.ts";
import { buildToyRepo, type ToyRepoSpec } from "./toy-repo.ts";

describe("normalizeSince", () => {
  it("translates relative windows", () => {
    expect(normalizeSince("14d")).toBe("14 days ago");
    expect(normalizeSince("4w")).toBe("4 weeks ago");
    expect(normalizeSince("3m")).toBe("3 months ago");
    expect(normalizeSince("1y")).toBe("1 years ago");
  });
  it("passes through ISO-ish strings unchanged", () => {
    expect(normalizeSince("2026-04-01")).toBe("2026-04-01");
  });
});

describe("scan (against toy repo)", () => {
  let toy: ToyRepoSpec;

  beforeAll(() => {
    toy = buildToyRepo();
  });
  afterAll(() => {
    rmSync(toy.repoRoot, { recursive: true, force: true });
  });

  it("returns all commits touching the surface in chronological-reverse order", () => {
    const commits = scan(
      { path: toy.surface, repoRoot: toy.repoRoot },
      { since: "1 year ago" },
    );
    const expected =
      toy.commitsByPhase.A.length +
      toy.commitsByPhase.B.length +
      toy.commitsByPhase.C.length +
      toy.commitsByPhase.D.length;
    expect(commits.length).toBe(expected);
    expect(commits[0]?.sha).toBe(toy.commitsByPhase.D[toy.commitsByPhase.D.length - 1]);
  });

  it("captures file touches with line counts", () => {
    const commits = scan(
      { path: toy.surface, repoRoot: toy.repoRoot },
      { since: "1 year ago" },
    );
    const wip = commits.find((c) => c.subject.startsWith("wip"));
    expect(wip).toBeDefined();
    expect(wip?.files.length).toBeGreaterThan(0);
    const totalAdded = wip?.files.reduce((acc, f) => acc + f.added, 0) ?? 0;
    expect(totalAdded).toBeGreaterThan(100);
  });

  it("captures parents", () => {
    const commits = scan(
      { path: toy.surface, repoRoot: toy.repoRoot },
      { since: "1 year ago" },
    );
    for (const commit of commits) {
      expect(commit.parents.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("headSha returns 40-char sha", () => {
    expect(headSha(toy.repoRoot)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns empty array when surface has no commits in window", () => {
    const out = scan(
      { path: "nonexistent-dir-xyz", repoRoot: toy.repoRoot },
      { since: "1 year ago" },
    );
    expect(out).toEqual([]);
  });
});

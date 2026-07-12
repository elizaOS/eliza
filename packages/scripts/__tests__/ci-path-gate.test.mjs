/**
 * Verifies the shared CI classifier derives pull-request files from the branch
 * merge-base and fails when the compared histories are unrelated.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitChangedFiles } from "../ci-path-gate.mjs";

const repos = [];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function write(cwd, path, contents) {
  const fullPath = join(cwd, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "ci-path-gate-unit-"));
  repos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  git(repo, "checkout", "-q", "-b", "develop");
  write(repo, "README.md", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("gitChangedFiles", () => {
  it("excludes files added only after the pull-request branch point", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "packages/docs/feature.mdx", "# feature\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "feature");
    const head = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "develop");
    write(repo, "packages/app/src/App.tsx", "export default 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "develop advances");
    const base = git(repo, "rev-parse", "HEAD");

    expect(gitChangedFiles(base, head, repo)).toEqual([
      "packages/docs/feature.mdx",
    ]);
  });

  it("fails when the revisions have no merge-base", () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-rfq", "--cached", ".");
    write(repo, "orphan.txt", "unrelated\n");
    git(repo, "add", "orphan.txt");
    git(repo, "commit", "-q", "-m", "orphan");
    const head = git(repo, "rev-parse", "HEAD");

    expect(() => gitChangedFiles(base, head, repo)).toThrow(/no merge-base/);
  });
});

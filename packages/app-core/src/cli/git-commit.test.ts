/**
 * Direct unit coverage for `resolveCommitHash`. The helper memoizes the first
 * hit for the process and probes GIT_COMMIT / GIT_SHA, then a git HEAD walk
 * from `cwd` (directory `.git`, `gitdir:` worktree files, and ref indirection).
 * Each case reloads the module so the memo cannot leak; fixtures are real temp
 * trees, not mocked `fs` or env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-core-git-commit-"));
  tempDirs.push(dir);
  return dir;
}

function nestDirs(root: string, depth: number): string {
  let current = root;
  for (let i = 0; i < depth; i += 1) {
    current = path.join(current, `level-${i}`);
    fs.mkdirSync(current, { recursive: true });
  }
  return current;
}

function writeGitDir(
  repoRoot: string,
  headContents: string,
  refs: Record<string, string> = {},
): string {
  const gitDir = path.join(repoRoot, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), headContents);
  for (const [ref, value] of Object.entries(refs)) {
    const refPath = path.join(gitDir, ref);
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, value);
  }
  return gitDir;
}

async function loadResolveCommitHash() {
  const { resolveCommitHash } = await import("./git-commit");
  return resolveCommitHash;
}

describe("resolveCommitHash", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers GIT_COMMIT, trims whitespace, and returns the first 7 characters", async () => {
    const resolveCommitHash = await loadResolveCommitHash();
    expect(
      resolveCommitHash({
        cwd: makeTempDir(),
        env: {
          GIT_COMMIT: "  abcdef1234567890  ",
          GIT_SHA: "deadbeeignored",
        },
      }),
    ).toBe("abcdef1");
  });

  it("falls through to GIT_SHA when GIT_COMMIT is empty or whitespace", async () => {
    const resolveCommitHash = await loadResolveCommitHash();
    expect(
      resolveCommitHash({
        cwd: makeTempDir(),
        env: { GIT_COMMIT: "   ", GIT_SHA: "sha2567remainder" },
      }),
    ).toBe("sha2567");
  });

  it("keeps hashes shorter than 7 characters", async () => {
    const resolveCommitHash = await loadResolveCommitHash();
    expect(
      resolveCommitHash({
        cwd: makeTempDir(),
        env: { GIT_COMMIT: "abc" },
      }),
    ).toBe("abc");
  });

  it("returns null when env is empty and no .git exists within the walk", async () => {
    const resolveCommitHash = await loadResolveCommitHash();
    expect(
      resolveCommitHash({
        cwd: makeTempDir(),
        env: {},
      }),
    ).toBeNull();
  });

  it("reads a detached hash from a directory .git/HEAD", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "cafebabeface0000111122223333444455556666\n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBe("cafebab");
  });

  it("follows a symbolic ref from HEAD to the ref file", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "ref: refs/heads/main\n", {
      "refs/heads/main": "  0123456789abcdef  \n",
    });
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBe("0123456");
  });

  it("returns null when HEAD points at a missing ref (ENOENT)", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "ref: refs/heads/does-not-exist\n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBeNull();
  });

  it("returns null for an empty HEAD file", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "   \n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBeNull();
  });

  it("follows a relative gitdir: worktree pointer", async () => {
    const root = makeTempDir();
    const work = path.join(root, "work");
    const gitDir = path.join(root, "actual-git");
    fs.mkdirSync(work);
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/topic\n");
    fs.writeFileSync(
      path.join(gitDir, "refs", "heads", "topic"),
      "feedfacecafebabe\n",
    );
    fs.writeFileSync(path.join(work, ".git"), "gitdir: ../actual-git\n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd: work, env: {} })).toBe("feedfac");
  });

  it("follows an absolute gitdir: pointer with extra whitespace", async () => {
    const root = makeTempDir();
    const work = path.join(root, "linked");
    const gitDir = path.join(root, "store");
    fs.mkdirSync(work);
    fs.mkdirSync(gitDir);
    fs.writeFileSync(
      path.join(gitDir, "HEAD"),
      "aaabbbcccdddeeefffaaabbbcccddd\n",
    );
    fs.writeFileSync(path.join(work, ".git"), `GITDIR:   ${gitDir}  \n`);
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd: work, env: {} })).toBe("aaabbbc");
  });

  it("walks up parent directories to find .git", async () => {
    const repo = makeTempDir();
    writeGitDir(repo, "bbbbbbbccccccccccccccccccccccccccccccc\n");
    const cwd = nestDirs(repo, 3);
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBe("bbbbbbb");
  });

  it("stops the parent walk after 12 directories", async () => {
    const repo = makeTempDir();
    writeGitDir(repo, "dddddddeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n");
    const tooDeep = nestDirs(repo, 12);
    const withinLimit = nestDirs(repo, 11);
    const resolveDeep = await loadResolveCommitHash();
    expect(resolveDeep({ cwd: tooDeep, env: {} })).toBeNull();
    vi.resetModules();
    const resolveNear = await loadResolveCommitHash();
    expect(resolveNear({ cwd: withinLimit, env: {} })).toBe("ddddddd");
  });

  it("skips a .git file without gitdir: and continues the parent walk", async () => {
    const repo = makeTempDir();
    writeGitDir(repo, "eeeeeeefffffffffffffffffffffffffffffff\n");
    const nested = nestDirs(repo, 1);
    fs.writeFileSync(path.join(nested, ".git"), "not-a-gitdir-pointer\n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd: nested, env: {} })).toBe("eeeeeee");
  });

  it("treats a case-folded REF: HEAD as a detached value, not a symbolic ref", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "REF: refs/heads/main\n", {
      "refs/heads/main": "ffffffffffff11111111111111111111111111\n",
    });
    const resolveCommitHash = await loadResolveCommitHash();
    // startsWith("ref:") is case-sensitive; formatCommit then slices 7 chars.
    expect(resolveCommitHash({ cwd, env: {} })).toBe("REF: re");
  });

  it("memoizes the first hit and ignores later env or cwd changes", async () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeGitDir(second, "99999998888888888888888888888888888888\n");
    const resolveCommitHash = await loadResolveCommitHash();
    expect(
      resolveCommitHash({
        cwd: first,
        env: { GIT_COMMIT: "1111111aaaa" },
      }),
    ).toBe("1111111");
    expect(
      resolveCommitHash({
        cwd: second,
        env: { GIT_COMMIT: "2222222bbbb", GIT_SHA: "3333333cccc" },
      }),
    ).toBe("1111111");
  });

  it("memoizes a null miss so a later GIT_COMMIT cannot override it", async () => {
    const cwd = makeTempDir();
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: {} })).toBeNull();
    expect(
      resolveCommitHash({ cwd, env: { GIT_COMMIT: "shouldnot" } }),
    ).toBeNull();
  });

  it("lets GIT_COMMIT win over a real git tree at cwd", async () => {
    const cwd = makeTempDir();
    writeGitDir(cwd, "ref: refs/heads/main\n", {
      "refs/heads/main": "ababababababababababababababababababab\n",
    });
    const resolveCommitHash = await loadResolveCommitHash();
    expect(resolveCommitHash({ cwd, env: { GIT_COMMIT: "envwinsxyz" } })).toBe(
      "envwins",
    );
  });
});

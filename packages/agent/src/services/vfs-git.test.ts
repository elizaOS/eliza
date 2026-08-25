/**
 * Drives createVfsGitService against a real on-disk VirtualFilesystemService
 * and isomorphic-git. Covers action dispatch, HTTP(S)-only clone URLs,
 * filepath confinement, status/commit/log/branch/checkout, missing-path
 * add/remove, log depth, and symlink rejection after checkout. No git HTTP
 * remotes are contacted.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PostWorkbenchVfsGitRequest } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVfsGitService,
  VfsGitError,
  type VfsGitService,
  type VfsGitStatusEntry,
} from "./vfs-git.ts";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

const AUTHOR_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GITHUB_USER",
] as const;

let tmpDir: string;
let savedAuthorEnv: Partial<Record<(typeof AUTHOR_ENV)[number], string>>;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-vfs-git-"));
  savedAuthorEnv = {};
  for (const key of AUTHOR_ENV) {
    savedAuthorEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of AUTHOR_ENV) {
    const previous = savedAuthorEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function gitFor(projectId: string): {
  git: VfsGitService;
  vfs: ReturnType<typeof createVirtualFilesystemService>;
} {
  const vfs = createVirtualFilesystemService({ projectId, stateDir: tmpDir });
  return { vfs, git: createVfsGitService(vfs) };
}

function asStatus(value: unknown): {
  action: string;
  branch: string | null;
  clean: boolean;
  files: VfsGitStatusEntry[];
} {
  return value as {
    action: string;
    branch: string | null;
    clean: boolean;
    files: VfsGitStatusEntry[];
  };
}

describe("VfsGitError", () => {
  it("is an Error with the assigned code", () => {
    const error = new VfsGitError("url is required", "MISSING_ARGUMENT");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("VfsGitError");
    expect(error.code).toBe("MISSING_ARGUMENT");
    expect(error.message).toBe("url is required");
  });
});

describe("createVfsGitService", () => {
  it("returns a service whose run dispatches init on a real VFS root", async () => {
    const { git } = gitFor("init-default");
    const result = await git.run({ action: "init" });
    expect(result).toEqual({ action: "init", branch: "main" });
  });

  it("prefers defaultBranch over branch, then branch, then main", async () => {
    const a = await gitFor("init-default-branch").git.run({
      action: "init",
      defaultBranch: "release",
      branch: "ignored",
    });
    expect(a).toEqual({ action: "init", branch: "release" });

    const b = await gitFor("init-branch-only").git.run({
      action: "init",
      branch: "topic",
    });
    expect(b).toEqual({ action: "init", branch: "topic" });
  });
});

describe("clone URL validation", () => {
  it("requires a non-empty url before any network call", async () => {
    const { git } = gitFor("clone-missing");
    await expect(git.run({ action: "clone" })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "url is required",
    });
    await expect(
      git.run({ action: "clone", url: "   " } as PostWorkbenchVfsGitRequest),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "url is required",
    });
  });

  it("rejects non-HTTP(S) remotes and lets URL parsing throw on garbage", async () => {
    const { git } = gitFor("clone-protocol");
    await expect(
      git.run({ action: "clone", url: "ssh://git@example.com/org/repo.git" }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "INVALID_GIT_URL",
      message: "VFS Git only supports HTTP(S) remotes",
    });
    await expect(
      git.run({ action: "clone", url: "git://example.com/org/repo.git" }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "INVALID_GIT_URL",
    });
    await expect(
      git.run({ action: "clone", url: "file:///tmp/repo.git" }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "INVALID_GIT_URL",
    });
    await expect(
      git.run({ action: "clone", url: "not-a-url" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("filepath confinement for add and remove", () => {
  it("requires paths or filepath and preserves request order", async () => {
    const { git, vfs } = gitFor("paths");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "a");
    await vfs.writeFile("b.txt", "b");

    await expect(git.run({ action: "add" })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "paths or filepath is required",
    });
    await expect(git.run({ action: "add", paths: [] })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "paths or filepath is required",
    });
    // Empty paths wins over filepath because `paths ?? filepath` keeps [].
    await expect(
      git.run({ action: "add", paths: [], filepath: "a.txt" }),
    ).rejects.toMatchObject({
      code: "MISSING_ARGUMENT",
    });

    const added = await git.run({
      action: "add",
      paths: ["b.txt", "a.txt"],
    });
    expect(added).toEqual({ action: "add", paths: ["b.txt", "a.txt"] });
  });

  it("normalizes slashes and collapsed relatives, and rejects traversal", async () => {
    const { git, vfs } = gitFor("normalize");
    await git.run({ action: "init" });
    await vfs.writeFile("src/file.ts", "export {};\n");
    await vfs.writeFile("bar.txt", "bar");

    const slashed = await git.run({
      action: "add",
      filepath: "/src/file.ts",
    });
    expect(slashed).toEqual({ action: "add", paths: ["src/file.ts"] });

    const backslash = await git.run({
      action: "add",
      filepath: "src\\file.ts",
    });
    expect(backslash).toEqual({ action: "add", paths: ["src/file.ts"] });

    // posix.normalize("foo/../bar.txt") collapses to "bar.txt" and is allowed.
    const collapsed = await git.run({
      action: "add",
      filepath: "foo/../bar.txt",
    });
    expect(collapsed).toEqual({ action: "add", paths: ["bar.txt"] });

    for (const filepath of [".", "..", "../secret", "foo/../../outside"]) {
      await expect(git.run({ action: "add", filepath })).rejects.toMatchObject({
        name: "VfsGitError",
        code: "INVALID_GIT_PATH",
        message: "Invalid Git filepath",
      });
    }

    await expect(git.run({ action: "add", paths: [""] })).rejects.toMatchObject(
      {
        code: "INVALID_GIT_PATH",
      },
    );
  });

  it("adds a missing file as isomorphic-git NotFoundError and removes a missing path as a no-throw", async () => {
    const { git } = gitFor("missing-paths");
    await git.run({ action: "init" });

    await expect(
      git.run({ action: "add", filepath: "missing.txt" }),
    ).rejects.toMatchObject({
      name: "NotFoundError",
      message: "Could not find missing.txt.",
    });

    // isomorphic-git.remove on a path absent from the index does not throw.
    await expect(
      git.run({ action: "remove", filepath: "missing.txt" }),
    ).resolves.toEqual({ action: "remove", paths: ["missing.txt"] });
  });
});

describe("status, commit, and log", () => {
  it("reports an empty init as clean, then dirty/untracked, then clean after commit", async () => {
    const { git, vfs } = gitFor("status");
    await git.run({ action: "init" });

    const empty = asStatus(await git.run({ action: "status" }));
    expect(empty).toEqual({
      action: "status",
      branch: "main",
      clean: true,
      files: [],
    });

    await vfs.writeFile("a.txt", "hi");
    const untracked = asStatus(await git.run({ action: "status" }));
    expect(untracked.clean).toBe(false);
    expect(untracked.files).toEqual([
      {
        filepath: "/a.txt",
        head: "absent",
        workdir: "modified",
        stage: "absent",
      },
    ]);

    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "first" });
    const clean = asStatus(await git.run({ action: "status" }));
    expect(clean.clean).toBe(true);
    expect(clean.files).toEqual([
      {
        filepath: "/a.txt",
        head: "unchanged",
        workdir: "unchanged",
        stage: "unchanged",
      },
    ]);

    await vfs.writeFile("a.txt", "changed");
    await vfs.writeFile("b.txt", "new");
    const dirty = asStatus(await git.run({ action: "status" }));
    expect(dirty.clean).toBe(false);
    expect(dirty.files).toEqual([
      {
        filepath: "/a.txt",
        head: "unchanged",
        workdir: "modified",
        stage: "unchanged",
      },
      {
        filepath: "/b.txt",
        head: "absent",
        workdir: "modified",
        stage: "absent",
      },
    ]);
  });

  it("requires a commit message and uses eliza authorship when no env or request author is set", async () => {
    const { git, vfs } = gitFor("commit-default");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "hi");
    await git.run({ action: "add", filepath: "a.txt" });

    await expect(git.run({ action: "commit" })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "message is required",
    });

    const committed = (await git.run({
      action: "commit",
      message: "hello",
    })) as { action: string; oid: string };
    expect(committed.action).toBe("commit");
    expect(committed.oid).toMatch(/^[0-9a-f]{40}$/);

    const log = (await git.run({ action: "log" })) as {
      action: string;
      commits: Array<{
        oid: string;
        message: string;
        author: { name: string; email: string };
      }>;
    };
    expect(log.action).toBe("log");
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]?.oid).toBe(committed.oid);
    expect(log.commits[0]?.message).toBe("hello\n");
    expect(log.commits[0]?.author).toMatchObject({
      name: "eliza",
      email: "eliza@example.local",
    });
  });

  it("prefers request author over GIT_AUTHOR_* over GITHUB_USER", async () => {
    process.env.GIT_AUTHOR_NAME = "env-name";
    process.env.GIT_AUTHOR_EMAIL = "env@example.test";
    process.env.GITHUB_USER = "github-user";

    const { git, vfs } = gitFor("commit-request-author");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "1");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({
      action: "commit",
      message: "from-request",
      authorName: "req-name",
      authorEmail: "req@example.test",
    });
    const withRequest = (await git.run({ action: "log", depth: 1 })) as {
      commits: Array<{ author: { name: string; email: string } }>;
    };
    expect(withRequest.commits[0]?.author).toMatchObject({
      name: "req-name",
      email: "req@example.test",
    });

    await vfs.writeFile("a.txt", "2");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "from-env" });
    const withEnv = (await git.run({ action: "log", depth: 1 })) as {
      commits: Array<{ author: { name: string; email: string } }>;
    };
    expect(withEnv.commits[0]?.author).toMatchObject({
      name: "env-name",
      email: "env@example.test",
    });

    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    await vfs.writeFile("a.txt", "3");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "from-github-user" });
    const withGithubUser = (await git.run({ action: "log", depth: 1 })) as {
      commits: Array<{ author: { name: string; email: string } }>;
    };
    expect(withGithubUser.commits[0]?.author).toMatchObject({
      name: "github-user",
      email: "eliza@example.local",
    });
  });

  it("defaults log depth to 20 and honors an explicit smaller depth", async () => {
    const { git, vfs } = gitFor("log-depth");
    await git.run({ action: "init" });
    for (let i = 0; i < 21; i++) {
      await vfs.writeFile("n.txt", `v${i}`);
      await git.run({ action: "add", filepath: "n.txt" });
      await git.run({ action: "commit", message: `c${i}` });
    }

    const defaulted = (await git.run({ action: "log" })) as {
      commits: Array<{ message: string }>;
    };
    expect(defaulted.commits).toHaveLength(20);
    expect(defaulted.commits[0]?.message).toBe("c20\n");
    expect(defaulted.commits[19]?.message).toBe("c1\n");

    const shallow = (await git.run({ action: "log", depth: 2 })) as {
      commits: Array<{ message: string }>;
    };
    expect(shallow.commits.map((c) => c.message)).toEqual(["c20\n", "c19\n"]);
  });

  it("throws when logging an unborn HEAD after init", async () => {
    const { git } = gitFor("log-empty");
    await git.run({ action: "init" });
    await expect(git.run({ action: "log" })).rejects.toMatchObject({
      name: "NotFoundError",
      message: "Could not find refs/heads/main.",
    });
  });

  it("unstages a tracked file on remove without deleting the worktree copy", async () => {
    const { git, vfs } = gitFor("remove-tracked");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "hi");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "first" });

    const removed = await git.run({ action: "remove", filepath: "a.txt" });
    expect(removed).toEqual({ action: "remove", paths: ["a.txt"] });
    await expect(vfs.readFile("a.txt")).resolves.toBe("hi");

    const status = asStatus(await git.run({ action: "status" }));
    expect(status.clean).toBe(false);
    expect(status.files).toEqual([
      {
        filepath: "/a.txt",
        head: "unchanged",
        workdir: "unchanged",
        stage: "absent",
      },
    ]);
  });
});

describe("branch, checkout, fetch, pull, and push", () => {
  it("creates a branch, refuses a duplicate without force, and checkouts by ref then branch", async () => {
    const { git, vfs } = gitFor("branch-checkout");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "hi");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "first" });

    await expect(git.run({ action: "branch" })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "branch is required",
    });
    await expect(git.run({ action: "checkout" })).rejects.toMatchObject({
      name: "VfsGitError",
      code: "MISSING_ARGUMENT",
      message: "ref is required",
    });

    const created = await git.run({ action: "branch", branch: "feature" });
    expect(created).toEqual({ action: "branch", branch: "feature" });

    await expect(
      git.run({ action: "branch", branch: "feature" }),
    ).rejects.toMatchObject({
      name: "AlreadyExistsError",
      message: "Failed to create branch at feature because it already exists.",
    });

    const forced = await git.run({
      action: "branch",
      ref: "feature",
      force: true,
    });
    expect(forced).toEqual({ action: "branch", branch: "feature" });

    const toMain = await git.run({ action: "checkout", ref: "main" });
    expect(toMain).toEqual({ action: "checkout", branch: "main" });

    // checkout prefers ref over branch.
    const toFeature = await git.run({
      action: "checkout",
      ref: "feature",
      branch: "main",
    });
    expect(toFeature).toEqual({ action: "checkout", branch: "feature" });
  });

  it("removes a symlink introduced in the worktree and throws SYMLINK_DENIED on checkout", async () => {
    const { git, vfs } = gitFor("symlink");
    await git.run({ action: "init" });
    await vfs.writeFile("a.txt", "hi");
    await git.run({ action: "add", filepath: "a.txt" });
    await git.run({ action: "commit", message: "first" });

    const linkPath = path.join(vfs.filesRoot, "nested", "link");
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    await fsp.symlink(path.join(vfs.filesRoot, "a.txt"), linkPath);

    await expect(
      git.run({ action: "checkout", ref: "main" }),
    ).rejects.toMatchObject({
      name: "VfsGitError",
      code: "SYMLINK_DENIED",
      message:
        "Git operation produced symlinks, which are not allowed in VFS projects",
    });
    await expect(fsp.lstat(linkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("dispatches fetch, pull, and push to isomorphic-git which rejects a missing remote URL", async () => {
    const { git } = gitFor("remotes");
    await git.run({ action: "init" });

    await expect(git.run({ action: "fetch" })).rejects.toMatchObject({
      name: "MissingParameterError",
      message:
        'The function requires a "remote OR url" parameter but none was provided.',
    });
    await expect(git.run({ action: "pull" })).rejects.toMatchObject({
      name: "MissingParameterError",
      message:
        'The function requires a "remote OR url" parameter but none was provided.',
    });
    await expect(git.run({ action: "push" })).rejects.toMatchObject({
      name: "MissingParameterError",
      message:
        'The function requires a "remote OR url" parameter but none was provided.',
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// resolveCommitHash caches globally; vi.resetModules() gives each test a fresh cache.
async function freshResolveCommitHash(
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  vi.resetModules();
  const mod = await import("./git-commit.js");
  return mod.resolveCommitHash(options);
}

describe("resolveCommitHash", () => {
  describe("env var resolution", () => {
    it("reads GIT_COMMIT from env", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "abc1234567890" } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("abc1234");
    });

    it("reads GIT_SHA when GIT_COMMIT is absent", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_SHA: "deadbeefcafe123" } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("deadbee");
    });

    it("truncates to 7 chars", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "abcdef1234567890" } as NodeJS.ProcessEnv,
      });
      expect(result).toHaveLength(7);
    });

    it("returns short hashes as-is when under 7 chars", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "abc" } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("abc");
    });

    it("trims whitespace from env values", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "  abc1234  " } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("abc1234");
    });

    it("ignores empty/whitespace-only GIT_COMMIT", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "   ", GIT_SHA: "fallbac" } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("fallbac");
    });
  });

  describe("git HEAD resolution", () => {
    it("reads a detached HEAD (direct commit hash)", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const gitDir = path.join(tmp, ".git");
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, "HEAD"), "abc1234567890def\n");

        const result = await freshResolveCommitHash({ cwd: tmp, env: {} as NodeJS.ProcessEnv });
        expect(result).toBe("abc1234");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("follows ref: symrefs to read the commit hash", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const gitDir = path.join(tmp, ".git");
        const refsDir = path.join(gitDir, "refs", "heads");
        await fs.mkdir(refsDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
        await fs.writeFile(path.join(refsDir, "main"), "deadbeef1234567\n");

        const result = await freshResolveCommitHash({ cwd: tmp, env: {} as NodeJS.ProcessEnv });
        expect(result).toBe("deadbee");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("follows gitdir file (worktrees)", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const realGitDir = path.join(tmp, "real-git");
        await fs.mkdir(realGitDir, { recursive: true });
        await fs.writeFile(path.join(realGitDir, "HEAD"), "cafe123456789ab\n");
        await fs.writeFile(path.join(tmp, ".git"), `gitdir: ${realGitDir}\n`);

        const result = await freshResolveCommitHash({ cwd: tmp, env: {} as NodeJS.ProcessEnv });
        expect(result).toBe("cafe123");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("walks up directories to find .git", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const gitDir = path.join(tmp, ".git");
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, "HEAD"), "bbb1234567890ab\n");
        const nested = path.join(tmp, "a", "b", "c");
        await fs.mkdir(nested, { recursive: true });

        const result = await freshResolveCommitHash({ cwd: nested, env: {} as NodeJS.ProcessEnv });
        expect(result).toBe("bbb1234");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("fallback", () => {
    it("returns null when no git info is available", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const result = await freshResolveCommitHash({ cwd: tmp, env: {} as NodeJS.ProcessEnv });
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("returns null for empty HEAD file", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const gitDir = path.join(tmp, ".git");
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, "HEAD"), "  \n");

        const result = await freshResolveCommitHash({ cwd: tmp, env: {} as NodeJS.ProcessEnv });
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  // readCommitFromBuildInfo/readCommitFromPackageJson can't be tested in isolation
  // (mocking node:module breaks vitest). Fallback ORDER is verified here instead.
  describe("fallback priority", () => {
    it("env var takes priority over git HEAD", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milaidy-git-"));
      try {
        const gitDir = path.join(tmp, ".git");
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(gitDir, "HEAD"), "githead1234567\n");

        const result = await freshResolveCommitHash({
          cwd: tmp,
          env: { GIT_COMMIT: "envfirst234567" } as NodeJS.ProcessEnv,
        });
        expect(result).toBe("envfirs");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("GIT_COMMIT takes priority over GIT_SHA", async () => {
      const result = await freshResolveCommitHash({
        env: { GIT_COMMIT: "commit1234567", GIT_SHA: "sha1234567890" } as NodeJS.ProcessEnv,
      });
      expect(result).toBe("commit1");
    });
  });

  describe("caching", () => {
    it("returns the same cached value on repeated calls", async () => {
      vi.resetModules();
      const mod = await import("./git-commit.js");
      const first = mod.resolveCommitHash({ env: { GIT_COMMIT: "cached1" } as NodeJS.ProcessEnv });
      const second = mod.resolveCommitHash({ env: { GIT_COMMIT: "different" } as NodeJS.ProcessEnv });
      expect(first).toBe("cached1");
      expect(second).toBe("cached1");
    });
  });
});

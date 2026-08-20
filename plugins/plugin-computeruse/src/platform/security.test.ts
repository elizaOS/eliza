/**
 * Unit tests for symlink handling in resolveSafeFileTarget. Benign
 * directory-symlink ancestors resolve to their canonical target and are
 * re-validated there, for existing files, not-yet-existing leaves, and
 * nested missing tails. Ancestors whose canonical target lands in a blocked
 * zone are refused with operation-specific reasons (read and delete on an
 * existing leaf, write and delete through the missing-leaf walk). Symlink
 * leaves and dangling ancestors are refused, and the canonical /private
 * spellings of the auth-config and root-home blocklists are pinned directly.
 */
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafeFileTarget, validateFilePath } from "./security.js";

describe("resolveSafeFileTarget — symlink ancestors resolve, blocked zones stay blocked", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-sec-"));
    temps.push(dir);
    return dir;
  }

  function linkDir(root: string, name: string, target: string): void {
    symlinkSync(target, path.join(realpathSync(root), name), "dir");
  }

  // symlinkSync needs elevated privileges on win32; the direct validateFilePath
  // pins below rely on POSIX path resolution.
  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix(
    "resolves an existing file behind a directory-symlink ancestor to its canonical path",
    async () => {
      const root = makeTempDir();
      const realTarget = realpathSync(makeTempDir());
      writeFileSync(path.join(realTarget, "data.txt"), "content\n");
      linkDir(root, "link", realTarget);

      const result = await resolveSafeFileTarget(
        path.join(root, "link", "data.txt"),
        "read",
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBe(path.join(realTarget, "data.txt"));
    },
  );

  itPosix(
    "resolves a not-yet-existing file behind a directory-symlink ancestor canonically",
    async () => {
      const root = makeTempDir();
      const realTarget = realpathSync(makeTempDir());
      linkDir(root, "link", realTarget);

      const result = await resolveSafeFileTarget(
        path.join(root, "link", "new.txt"),
        "write",
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBe(path.join(realTarget, "new.txt"));
    },
  );

  itPosix(
    "resolves a nested not-yet-created tail behind a symlink ancestor canonically",
    async () => {
      const root = makeTempDir();
      const realTarget = realpathSync(makeTempDir());
      linkDir(root, "a", realTarget);

      const result = await resolveSafeFileTarget(
        path.join(root, "a", "b", "c", "planted.txt"),
        "write",
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBe(
        path.join(realTarget, "b", "c", "planted.txt"),
      );
    },
  );

  itPosix(
    "refuses a symlink ancestor whose canonical target is a blocked zone — existing leaf, read",
    async () => {
      const root = makeTempDir();
      linkDir(root, "devlink", "/dev");

      const result = await resolveSafeFileTarget(
        path.join(root, "devlink", "null"),
        "read",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/cannot read in device node/i);
    },
  );

  itPosix(
    "refuses a symlink ancestor whose canonical target is a blocked zone — existing leaf, delete",
    async () => {
      const root = makeTempDir();
      linkDir(root, "devlink", "/dev");

      const result = await resolveSafeFileTarget(
        path.join(root, "devlink", "null"),
        "delete",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/cannot delete in device node/i);
    },
  );

  itPosix(
    "refuses a symlink ancestor whose canonical target is a blocked zone — missing leaf, write",
    async () => {
      const root = makeTempDir();
      linkDir(root, "devlink", "/dev");

      const result = await resolveSafeFileTarget(
        path.join(root, "devlink", "planted.txt"),
        "write",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/cannot write in device node/i);
    },
  );

  itPosix(
    "refuses a symlink ancestor whose canonical target is a blocked zone — missing leaf, delete",
    async () => {
      const root = makeTempDir();
      linkDir(root, "devlink", "/dev");

      const result = await resolveSafeFileTarget(
        path.join(root, "devlink", "gone.txt"),
        "delete",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/cannot delete in device node/i);
    },
  );

  itPosix(
    "refuses auth config reached through an /etc symlink at its canonical spelling",
    async () => {
      const root = makeTempDir();
      linkDir(root, "etclink", "/etc");

      const result = await resolveSafeFileTarget(
        path.join(root, "etclink", "sudoers"),
        "read",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/system auth config/i);
    },
  );

  itPosix(
    "blocks the canonical /private/etc spelling of auth config directly",
    () => {
      const result = validateFilePath("/private/etc/master.passwd", "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/system auth config/i);
    },
  );

  itPosix("blocks root-home credentials under both /var/root spellings", () => {
    for (const spelling of [
      "/var/root/.ssh/id_rsa",
      "/private/var/root/.ssh/id_rsa",
    ]) {
      const result = validateFilePath(spelling, "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/SSH key/i);
    }
  });

  itPosix("still refuses a symlink leaf", async () => {
    const root = makeTempDir();
    const realTarget = realpathSync(makeTempDir());
    writeFileSync(path.join(realTarget, "real.txt"), "content\n");
    symlinkSync(
      path.join(realTarget, "real.txt"),
      path.join(realpathSync(root), "leaf-link"),
      "file",
    );

    const result = await resolveSafeFileTarget(
      path.join(root, "leaf-link"),
      "read",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/symbolic link/i);
  });

  itPosix("fails closed on a dangling directory-symlink ancestor", async () => {
    const root = makeTempDir();
    const realRoot = realpathSync(root);
    symlinkSync(
      path.join(realRoot, "gone"),
      path.join(realRoot, "dangling"),
      "dir",
    );

    const result = await resolveSafeFileTarget(
      path.join(root, "dangling", "planted.txt"),
      "write",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/ENOENT|no such file/i);
    expect(result.resolvedPath).toBeUndefined();
  });

  itPosix(
    "fails closed when a path component is a regular file (non-ENOENT leaf error)",
    async () => {
      const root = makeTempDir();
      const realRoot = realpathSync(root);
      writeFileSync(path.join(realRoot, "file.txt"), "content\n");

      const result = await resolveSafeFileTarget(
        path.join(realRoot, "file.txt", "child.txt"),
        "write",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/ENOTDIR|not a directory/i);
    },
  );

  it("resolves reads and writes under the OS tmpdir canonically", async () => {
    // On macOS tmpdir() sits under the /var -> /private/var symlink; on Linux
    // it is a plain directory and the canonical assertions are tautological.
    const root = makeTempDir();

    const existing = path.join(root, "existing.txt");
    writeFileSync(existing, "content\n");
    const read = await resolveSafeFileTarget(existing, "read");
    expect(read.allowed).toBe(true);
    expect(read.resolvedPath).toBe(realpathSync(existing));

    const write = await resolveSafeFileTarget(
      path.join(root, "fresh.txt"),
      "write",
    );
    expect(write.allowed).toBe(true);
    expect(write.resolvedPath).toBe(path.join(realpathSync(root), "fresh.txt"));
  });
});

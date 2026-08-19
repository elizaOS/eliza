/**
 * Unit tests for symlink-ancestor confinement in resolveSafeFileTarget.
 * Mirrors plugins/plugin-coding-tools/src/lib/path-utils.test.ts ancestor-walk case.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafeFileTarget } from "./security.js";

describe("resolveSafeFileTarget — ancestor-walk confinement", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink(
    "blocks a write through a directory symlink to outside",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eliza-sec-root-"));
      const victim = mkdtempSync(path.join(tmpdir(), "eliza-sec-victim-"));
      temps.push(root, victim);
      const realRoot = realpathSync(root);
      const realVictim = realpathSync(victim);
      symlinkSync(realVictim, path.join(realRoot, "escape"), "dir");

      const result = await resolveSafeFileTarget(
        path.join(realRoot, "escape", "planted.txt"),
        "write",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/symbolic link/i);
    },
  );

  itSymlink(
    "blocks a write through a nested symlink ancestor (not just immediate parent)",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eliza-sec-root2-"));
      const victim = mkdtempSync(path.join(tmpdir(), "eliza-sec-victim2-"));
      temps.push(root, victim);
      const realRoot = realpathSync(root);
      const realVictim = realpathSync(victim);
      // root/a -> victim, path is root/a/b/c/planted.txt where a/b/c does not exist yet
      symlinkSync(realVictim, path.join(realRoot, "a"), "dir");

      const result = await resolveSafeFileTarget(
        path.join(realRoot, "a", "b", "c", "planted.txt"),
        "write",
      );
      expect(result.allowed).toBe(false);
      // Either symlink-parent or confinement failure — both are secure.
      expect(result.allowed).toBe(false);
    },
  );

  itSymlink(
    "blocks a symlink ancestor when an existing descendant hides it",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eliza-sec-root-existing-"));
      const victim = mkdtempSync(
        path.join(tmpdir(), "eliza-sec-victim-existing-"),
      );
      temps.push(root, victim);
      const realRoot = realpathSync(root);
      const realVictim = realpathSync(victim);
      const existing = path.join(realVictim, "existing");
      mkdirSync(existing);
      writeFileSync(path.join(existing, "planted.txt"), "outside\n");
      symlinkSync(realVictim, path.join(realRoot, "escape"), "dir");

      const result = await resolveSafeFileTarget(
        path.join(realRoot, "escape", "existing", "planted.txt"),
        "write",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/symbolic link/i);
    },
  );

  itSymlink("allows a normal write inside the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eliza-sec-root3-"));
    temps.push(root);
    const realRoot = realpathSync(root);
    const result = await resolveSafeFileTarget(
      path.join(realRoot, "inside.txt"),
      "write",
    );
    // inside.txt does not exist but parent is realRoot (not a symlink) — should be allowed
    // unless blocked by credential patterns; this path is not credential-related.
    expect(result.allowed).toBe(true);
  });
});

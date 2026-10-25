/**
 * resolveSafeFileTarget path-security checks against real temp directories and
 * symlinks. Deterministic; exercises the real fs.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafeFileTarget } from "../platform/security.js";

describe("resolveSafeFileTarget", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-cu-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects symlink targets for writes", async () => {
    const root = await tempDir();
    const secret = path.join(root, "secret.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(secret, "secret", "utf8");
    await fs.symlink(secret, link);

    const result = await resolveSafeFileTarget(link, "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/symbolic link/i);
  });

  it("resolves regular files through realpath", async () => {
    const root = await tempDir();
    const file = path.join(root, "notes.txt");
    await fs.writeFile(file, "hello", "utf8");

    const result = await resolveSafeFileTarget(file, "read");
    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(await fs.realpath(file));
  });
});

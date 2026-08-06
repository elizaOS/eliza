import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lspNpmWhich } from "./npm-cache";

const tempDirs: string[] = [];
let homeDir = "";

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "grok-lsp-home-"));
  tempDirs.push(homeDir);
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("lspNpmWhich", () => {
  it("resolves a single binary from a pre-populated cache", async () => {
    const dir = await createFakePackageCache("fake-server", { "fake-server": "lib/cli.js" });
    const result = await lspNpmWhich("fake-server");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", "fake-server"));
  });

  it("resolves the correct binary from a multi-binary package", async () => {
    const dir = await createFakePackageCache("multi-bin", {
      "multi-bin": "lib/main.js",
      "multi-bin-helper": "lib/helper.js",
    });
    const result = await lspNpmWhich("multi-bin");

    expect(result).toBe(path.join(dir, "node_modules", ".bin", "multi-bin"));
  });

  it("returns null when the package cannot be installed", async () => {
    const result = await lspNpmWhich("@nonexistent-scope/totally-fake-package-that-does-not-exist-12345");
    expect(result).toBeNull();
  });
});

async function createFakePackageCache(pkg: string, binEntries: Record<string, string>): Promise<string> {
  const cacheRoot = path.join(os.homedir(), ".grok", "cache", "lsp", pkg);
  tempDirs.push(cacheRoot);

  const binDir = path.join(cacheRoot, "node_modules", ".bin");
  const pkgDir = path.join(cacheRoot, "node_modules", pkg);
  await mkdir(binDir, { recursive: true });
  await mkdir(pkgDir, { recursive: true });

  for (const [name, target] of Object.entries(binEntries)) {
    const targetPath = path.join(pkgDir, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "#!/usr/bin/env node\n", { mode: 0o755 });

    const linkPath = path.join(binDir, name);
    const { symlink } = await import("fs/promises");
    await symlink(path.relative(binDir, targetPath), linkPath).catch(() => {
      // Fallback: write a stub file if symlinks fail (Windows)
      return writeFile(linkPath, `#!/bin/sh\nnode "${targetPath}" "$@"\n`, { mode: 0o755 });
    });
  }

  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkg,
      bin: Object.keys(binEntries).length === 1 ? Object.values(binEntries)[0] : binEntries,
    }),
  );

  return cacheRoot;
}

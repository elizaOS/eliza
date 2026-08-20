/**
 * Real-filesystem tests for self-contained plugin staging trees. The harness
 * exercises production copy and package-link helpers with deterministic temp
 * directories and no filesystem mocks.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyPluginTreeWithoutEscapingSymlinks,
  copySymlinkedPackageForStaging,
} from "./plugin-resolver.ts";

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

describe("copyPluginTreeWithoutEscapingSymlinks", () => {
  it("copies regular files and in-tree symlinks", async () => {
    const src = await makeDir("plugin-copy-src-");
    const dst = await makeDir("plugin-copy-dst-");
    await fsp.writeFile(path.join(src, "ok.txt"), "inside");
    await fsp.symlink(path.join(src, "ok.txt"), path.join(src, "alias.txt"));

    const target = path.join(dst, "tree");
    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    expect(await fsp.readFile(path.join(target, "ok.txt"), "utf8")).toBe(
      "inside",
    );
    const alias = path.join(target, "alias.txt");
    expect((await fsp.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(await fsp.readlink(alias))).toBe(false);
    await fsp.rm(src, { recursive: true, force: true });
    expect(await fsp.readFile(alias, "utf8")).toBe("inside");
  });

  it("does not materialize a host file behind an out-of-tree symlink", async () => {
    const secretDir = await makeDir("plugin-copy-secret-");
    const secret = path.join(secretDir, "secret.txt");
    await fsp.writeFile(secret, "HOST-SECRET");

    const src = await makeDir("plugin-copy-src-");
    const dst = await makeDir("plugin-copy-dst-");
    await fsp.writeFile(path.join(src, "ok.txt"), "inside");
    await fsp.symlink(secret, path.join(src, "leaked.txt"));

    const target = path.join(dst, "tree");
    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    expect(await fsp.readFile(path.join(target, "ok.txt"), "utf8")).toBe(
      "inside",
    );
    await expect(
      fsp.lstat(path.join(target, "leaked.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not treat a configured workspace sibling as part of the package", async () => {
    const workspace = await makeDir("plugin-copy-workspace-");
    const src = path.join(workspace, "package");
    const secretDir = path.join(workspace, "secrets");
    const target = path.join(workspace, "staged");
    await fsp.mkdir(src);
    await fsp.mkdir(secretDir);
    await fsp.writeFile(path.join(secretDir, "token"), "HOST-SECRET");
    await fsp.symlink(path.join(secretDir, "token"), path.join(src, "leak"));
    vi.stubEnv("ELIZA_WORKSPACE_ROOT", workspace);

    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    await expect(fsp.lstat(path.join(target, "leak"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a relative symlink that traverses an in-tree link to the host", async () => {
    const secretDir = await makeDir("plugin-copy-secret-");
    await fsp.writeFile(path.join(secretDir, "secret.txt"), "HOST-SECRET");
    const src = await makeDir("plugin-copy-src-");
    await fsp.symlink(secretDir, path.join(src, "redirect"));
    await fsp.symlink("redirect/secret.txt", path.join(src, "nested-leak"));
    const target = path.join(await makeDir("plugin-copy-dst-"), "tree");

    await copyPluginTreeWithoutEscapingSymlinks(src, target);

    await expect(
      fsp.lstat(path.join(target, "redirect")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fsp.lstat(path.join(target, "nested-leak")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "the staged root", replacement: "../.." },
    { name: "a staged ancestor", replacement: ".." },
  ])(
    "removes a symlink swapped after copy to point at $name",
    async ({ replacement }) => {
      const src = await makeDir("plugin-copy-src-");
      const nested = path.join(src, "nested", "deeper");
      await fsp.mkdir(nested, { recursive: true });
      await fsp.writeFile(path.join(nested, "target.txt"), "inside");
      await fsp.symlink("target.txt", path.join(nested, "alias"));
      const target = path.join(await makeDir("plugin-copy-dst-"), "tree");

      await copyPluginTreeWithoutEscapingSymlinks(src, target, {
        afterCopyBeforeAudit: async () => {
          const stagedAlias = path.join(target, "nested", "deeper", "alias");
          await fsp.unlink(stagedAlias);
          await fsp.symlink(replacement, stagedAlias);
        },
      });

      await expect(
        fsp.lstat(path.join(target, "nested", "deeper", "alias")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("copySymlinkedPackageForStaging", () => {
  it("rejects a package symlink whose manifest name does not match", async () => {
    const secretDir = await makeDir("plugin-link-secret-");
    await fsp.writeFile(
      path.join(secretDir, "package.json"),
      JSON.stringify({ name: "host-secret" }),
    );
    const src = await makeDir("plugin-link-src-");
    const link = path.join(src, "escape");
    const dst = path.join(await makeDir("plugin-link-dst-"), "package");
    await fsp.symlink(secretDir, link);
    expect(
      await copySymlinkedPackageForStaging(link, dst, "expected-package"),
    ).toBe(false);
    await expect(fsp.lstat(dst)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies a name-bound package instead of planting its live symlink", async () => {
    const packageRoot = await makeDir("plugin-link-package-");
    await fsp.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "expected-package" }),
    );
    await fsp.writeFile(path.join(packageRoot, "index.js"), "export default 1");
    const src = await makeDir("plugin-link-src-");
    const link = path.join(src, "expected-package");
    const dst = path.join(await makeDir("plugin-link-dst-"), "package");
    await fsp.symlink(packageRoot, link);

    expect(
      await copySymlinkedPackageForStaging(link, dst, "expected-package"),
    ).toBe(true);
    expect((await fsp.lstat(dst)).isSymbolicLink()).toBe(false);
    await fsp.rm(packageRoot, { recursive: true, force: true });
    expect(await fsp.readFile(path.join(dst, "index.js"), "utf8")).toBe(
      "export default 1",
    );
  });

  it("rejects malformed manifests before creating the staged package", async () => {
    const packageRoot = await makeDir("plugin-link-package-");
    await fsp.writeFile(path.join(packageRoot, "package.json"), "{not-json");
    const src = await makeDir("plugin-link-src-");
    const link = path.join(src, "expected-package");
    const dst = path.join(await makeDir("plugin-link-dst-"), "package");
    await fsp.symlink(packageRoot, link);

    expect(
      await copySymlinkedPackageForStaging(link, dst, "expected-package"),
    ).toBe(false);
    await expect(fsp.lstat(dst)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates staged identity after an atomic source replacement", async () => {
    const container = await makeDir("plugin-link-race-");
    const packageRoot = path.join(container, "package");
    await fsp.mkdir(packageRoot);
    await fsp.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "expected-package" }),
    );
    await fsp.writeFile(path.join(packageRoot, "index.js"), "trusted");
    const link = path.join(container, "expected-package");
    const dst = path.join(await makeDir("plugin-link-dst-"), "package");
    await fsp.symlink(packageRoot, link);

    expect(
      await copySymlinkedPackageForStaging(link, dst, "expected-package", {
        beforeCopy: async () => {
          await fsp.rename(packageRoot, path.join(container, "original"));
          await fsp.mkdir(packageRoot);
          await fsp.writeFile(
            path.join(packageRoot, "package.json"),
            JSON.stringify({ name: "replacement-package" }),
          );
          await fsp.writeFile(path.join(packageRoot, "index.js"), "raced");
        },
      }),
    ).toBe(false);
    await expect(fsp.lstat(dst)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

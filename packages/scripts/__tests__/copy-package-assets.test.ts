/**
 * Verifies package asset assembly excludes generated caches while retaining
 * the source assets needed by installed packages.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { copyPackageAssets, shouldCopyAsset } from "../copy-package-assets.mjs";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const scriptPath = join(
  repoRoot,
  "packages",
  "scripts",
  "copy-package-assets.mjs",
);
const temporaryDirectories: string[] = [];

function writeFixture(root: string, relativePath: string, contents: string) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("copy-package-assets", () => {
  test("omits Python bytecode generated beside package sources", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "eliza-package-assets-"));
    temporaryDirectories.push(packageRoot);
    writeFixture(packageRoot, "packaging/python/module.py", "VALUE = 1\n");
    writeFixture(
      packageRoot,
      "packaging/python/__pycache__/module.cpython-312.pyc",
      "/source/checkout/module.py",
    );
    writeFixture(
      packageRoot,
      "packaging/python/legacy.pyc",
      "/source/checkout/legacy.py",
    );
    writeFixture(
      packageRoot,
      "packaging/python/optimized.pyo",
      "/source/checkout/optimized.py",
    );
    writeFixture(
      packageRoot,
      "packaging/python/elizaos_app.egg-info/PKG-INFO",
      "generated package metadata\n",
    );
    writeFixture(
      packageRoot,
      "packaging/python/.pytest_cache/nodeids",
      "generated test cache\n",
    );
    writeFixture(
      packageRoot,
      "packaging/python/.coverage.worker",
      "generated coverage data\n",
    );
    for (const output of [
      "packaging/debian/node-runtime/bin/node",
      "packaging/debian/runtime/package.json",
      "packaging/flatpak/runtime/package.json",
      "packaging/snap/runtime/package.json",
    ]) {
      writeFixture(packageRoot, output, "/source/checkout/generated-runtime");
    }

    const completed = spawnSync(
      process.execPath,
      [scriptPath, packageRoot, "packaging"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(completed.status, completed.stderr).toBe(0);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/module.py")),
    ).toBe(true);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/__pycache__")),
    ).toBe(false);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/legacy.pyc")),
    ).toBe(false);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/optimized.pyo")),
    ).toBe(false);
    expect(
      existsSync(
        join(packageRoot, "dist/packaging/python/elizaos_app.egg-info"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/.pytest_cache")),
    ).toBe(false);
    expect(
      existsSync(join(packageRoot, "dist/packaging/python/.coverage.worker")),
    ).toBe(false);
    for (const output of [
      "packaging/debian/node-runtime",
      "packaging/debian/runtime",
      "packaging/flatpak/runtime",
      "packaging/snap/runtime",
    ]) {
      expect(existsSync(join(packageRoot, "dist", output))).toBe(false);
    }
  });
});

describe("copyPackageAssets (in-process library surface)", () => {
  test("copies assets into dist, stripping src/ and dropping generated state", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "eliza-package-assets-"));
    temporaryDirectories.push(packageRoot);
    writeFixture(packageRoot, "src/assets/logo.svg", "<svg/>");
    writeFixture(packageRoot, "packaging/config/service.conf", "unit\n");
    writeFixture(packageRoot, "packaging/.venv/lib/site.py", "venv state\n");
    writeFixture(packageRoot, "packaging/.gradle/cache.bin", "gradle state\n");
    writeFixture(
      packageRoot,
      "packaging/.runtime.prepare-1234/staging/node",
      "in-flight staging\n",
    );
    writeFixture(
      packageRoot,
      "packaging/snap/runtime/package.json",
      "generated runtime\n",
    );

    await copyPackageAssets(packageRoot, ["src/assets", "packaging"]);

    // A leading src/ is stripped so dist mirrors the published layout.
    expect(existsSync(join(packageRoot, "dist/assets/logo.svg"))).toBe(true);
    expect(
      existsSync(join(packageRoot, "dist/packaging/config/service.conf")),
    ).toBe(true);
    expect(existsSync(join(packageRoot, "dist/packaging/.venv"))).toBe(false);
    expect(existsSync(join(packageRoot, "dist/packaging/.gradle"))).toBe(false);
    expect(
      existsSync(join(packageRoot, "dist/packaging/.runtime.prepare-1234")),
    ).toBe(false);
    expect(existsSync(join(packageRoot, "dist/packaging/snap/runtime"))).toBe(
      false,
    );
  });

  test("replaces a stale dist target instead of merging into it", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "eliza-package-assets-"));
    temporaryDirectories.push(packageRoot);
    writeFixture(packageRoot, "assets/current.txt", "current\n");
    writeFixture(packageRoot, "dist/assets/stale.txt", "stale\n");

    await copyPackageAssets(packageRoot, ["assets"]);

    expect(existsSync(join(packageRoot, "dist/assets/current.txt"))).toBe(true);
    expect(existsSync(join(packageRoot, "dist/assets/stale.txt"))).toBe(false);
  });

  test("fails loudly on a missing source asset", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "eliza-package-assets-"));
    temporaryDirectories.push(packageRoot);

    await expect(
      copyPackageAssets(packageRoot, ["does-not-exist"]),
    ).rejects.toThrow(/missing asset path/);
  });
});

describe("shouldCopyAsset", () => {
  test("always keeps paths outside the package directory", () => {
    expect(shouldCopyAsset("/pkg", "/elsewhere/file.txt")).toBe(true);
    expect(shouldCopyAsset("/pkg", "/pkg")).toBe(true);
  });

  test("drops generated segments anywhere in the relative path", () => {
    expect(shouldCopyAsset("/pkg", "/pkg/tools/node_modules/dep")).toBe(false);
    expect(shouldCopyAsset("/pkg", "/pkg/py/app.egg-info/PKG-INFO")).toBe(
      false,
    );
    expect(shouldCopyAsset("/pkg", "/pkg/py/.coverage.worker")).toBe(false);
    expect(shouldCopyAsset("/pkg", "/pkg/py/module.pyc")).toBe(false);
    expect(shouldCopyAsset("/pkg", "/pkg/py/module.py")).toBe(true);
  });
});

/**
 * Verifies package asset assembly excludes generated caches while retaining
 * the source assets needed by installed packages.
 */
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
import { copyPackageAssets } from "../copy-package-assets.mjs";

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
  test("omits Python bytecode generated beside package sources", async () => {
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
    for (const cacheDirectory of [
      ".mypy_cache",
      ".ruff_cache",
      ".venv",
      "ENV",
      "env",
      "venv",
    ]) {
      writeFixture(
        packageRoot,
        `packaging/python/${cacheDirectory}/generated-state`,
        "generated local state\n",
      );
    }

    await copyPackageAssets({
      repositoryRoot: join(import.meta.dirname, "..", "..", ".."),
      packageDirectory: packageRoot,
      assetPaths: ["packaging"],
    });

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
    for (const cacheDirectory of [
      ".mypy_cache",
      ".ruff_cache",
      ".venv",
      "ENV",
      "env",
      "venv",
    ]) {
      expect(
        existsSync(join(packageRoot, "dist/packaging/python", cacheDirectory)),
      ).toBe(false);
    }
  });
});

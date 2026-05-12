/**
 * Test for the `assertRequiredBundledPackagesLanded` defense-in-depth check.
 *
 * The function fails the desktop build when any package marked
 * `alwaysBundled` (CORE_PLUGINS / OPTIONAL_CORE_PLUGINS / BASELINE_*) is
 * missing its `package.json` in `dist/node_modules/` after the copy + prune
 * phases. Companion safety net to the transitive-walk filter introduced
 * with the fresh-clone build fixes — if a future refactor accidentally
 * excludes a required package, the build fails loudly here instead of
 * shipping a broken bundle.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertRequiredBundledPackagesLanded } from "./copy-runtime-node-modules";

let tmpDir: string;
let nodeModulesDir: string;

function writePackageJson(name: string): void {
  const dir = name.startsWith("@")
    ? path.join(nodeModulesDir, ...name.split("/"))
    : path.join(nodeModulesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }, null, 2));
}

describe("assertRequiredBundledPackagesLanded", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "assert-bundled-"));
    nodeModulesDir = path.join(tmpDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes when every required package has a package.json", () => {
    writePackageJson("@elizaos/core");
    writePackageJson("@elizaos/plugin-sql");
    writePackageJson("react");

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core", "@elizaos/plugin-sql", "react"]),
      ),
    ).not.toThrow();
  });

  it("passes on an empty alwaysBundled set", () => {
    expect(() =>
      assertRequiredBundledPackagesLanded(nodeModulesDir, new Set()),
    ).not.toThrow();
  });

  it("throws when a scoped required package is missing", () => {
    writePackageJson("@elizaos/core"); // present
    // @elizaos/plugin-sql intentionally not written

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core", "@elizaos/plugin-sql"]),
      ),
    ).toThrowError(/@elizaos\/plugin-sql/);
  });

  it("throws when an unscoped required package is missing", () => {
    writePackageJson("react"); // present

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["react", "react-dom"]),
      ),
    ).toThrowError(/react-dom/);
  });

  it("lists ALL missing packages, not just the first one", () => {
    writePackageJson("@elizaos/core");
    // plugin-sql, plugin-local-embedding, app-companion all missing

    try {
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set([
          "@elizaos/core",
          "@elizaos/plugin-sql",
          "@elizaos/plugin-local-embedding",
          "@elizaos/app-companion",
        ]),
      );
      throw new Error("expected assertRequiredBundledPackagesLanded to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("@elizaos/plugin-sql");
      expect(message).toContain("@elizaos/plugin-local-embedding");
      expect(message).toContain("@elizaos/app-companion");
      // Count of missing should be in the header
      expect(message).toContain("3 required runtime package");
    }
  });

  it("only checks package.json — empty dir for a package still counts as missing", () => {
    // Create the package dir but NO package.json (could happen if prune
    // wiped the manifest).
    mkdirSync(path.join(nodeModulesDir, "@elizaos", "plugin-sql"), { recursive: true });

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/plugin-sql"]),
      ),
    ).toThrowError(/@elizaos\/plugin-sql/);
  });

  it("error message points to the expected on-disk path so ops can investigate", () => {
    try {
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/plugin-sql"]),
      );
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(
        path.join(nodeModulesDir, "@elizaos", "plugin-sql", "package.json"),
      );
    }
  });
});

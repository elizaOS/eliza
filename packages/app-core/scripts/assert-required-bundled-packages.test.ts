/**
 * Test for the `assertRequiredBundledPackagesLanded` defense-in-depth check.
 *
 * The function fails the desktop build when any package marked
 * `alwaysBundled` (CORE_PLUGINS / OPTIONAL_CORE_PLUGINS / BASELINE_*) is
 * missing its `package.json`, or a baseline package is missing its declared
 * runtime entrypoint, in `dist/node_modules/` after the copy + prune phases.
 * Companion safety net to the transitive-walk filter introduced with the
 * fresh-clone build fixes — if a future refactor accidentally excludes a
 * required package, the build fails loudly here instead of shipping a broken
 * bundle.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertRequiredBundledPackagesLanded,
  getRuntimeDependencies,
  selectCopyTargetNodeModules,
  shouldCopyPackageEntry,
  shouldSkipPackagedDependency,
} from "./copy-runtime-node-modules";

let tmpDir: string;
let nodeModulesDir: string;

function writePackageJson(
  name: string,
  manifest: Record<string, unknown> = {},
): string {
  const dir = name.startsWith("@")
    ? path.join(nodeModulesDir, ...name.split("/"))
    : path.join(nodeModulesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, ...manifest }, null, 2),
  );
  return dir;
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
    // plugin-sql, plugin-local-inference, app-companion all missing

    try {
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set([
          "@elizaos/core",
          "@elizaos/plugin-sql",
          "@elizaos/plugin-local-inference",
          "@elizaos/plugin-companion",
        ]),
      );
      throw new Error("expected assertRequiredBundledPackagesLanded to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("@elizaos/plugin-sql");
      expect(message).toContain("@elizaos/plugin-local-inference");
      expect(message).toContain("@elizaos/plugin-companion");
      // Count of missing should be in the header
      expect(message).toContain("3 required runtime package");
    }
  });

  it("only checks package.json — empty dir for a package still counts as missing", () => {
    // Create the package dir but NO package.json (could happen if prune
    // wiped the manifest).
    mkdirSync(path.join(nodeModulesDir, "@elizaos", "plugin-sql"), {
      recursive: true,
    });

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/plugin-sql"]),
      ),
    ).toThrowError(/@elizaos\/plugin-sql/);
  });

  it("throws when a baseline package main entrypoint was not copied", () => {
    writePackageJson("@elizaos/core", { main: "./dist/index.js" });

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core"]),
      ),
    ).toThrowError(/missing runtime entry .*dist[\\/]index\.js/);
  });

  it("throws when a baseline package module entrypoint was pruned", () => {
    writePackageJson("@elizaos/core", { module: "./dist/index.mjs" });

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core"]),
      ),
    ).toThrowError(/missing runtime entry .*dist[\\/]index\.mjs/);
  });

  it("checks baseline package runtime export targets but ignores type-only exports", () => {
    const packageRoot = writePackageJson("@elizaos/core", {
      exports: {
        ".": {
          import: "./dist/index.js",
          require: "./dist/index.cjs",
          types: "./dist/index.d.ts",
        },
      },
    });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(path.join(packageRoot, "dist", "index.d.ts"), "");

    try {
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core"]),
      );
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(path.join(packageRoot, "dist", "index.js"));
      expect(message).toContain(path.join(packageRoot, "dist", "index.cjs"));
      expect(message).not.toContain("index.d.ts");
    }
  });

  it("passes when a baseline package manifest entrypoint exists", () => {
    const packageRoot = writePackageJson("@elizaos/core", {
      main: "./dist/index.js",
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
    });
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(path.join(packageRoot, "dist", "index.js"), "");

    expect(() =>
      assertRequiredBundledPackagesLanded(
        nodeModulesDir,
        new Set(["@elizaos/core"]),
      ),
    ).not.toThrow();
  });

  it("does not entrypoint-check non-baseline always-bundled packages", () => {
    writePackageJson("react", { main: "./index.js" });

    expect(() =>
      assertRequiredBundledPackagesLanded(nodeModulesDir, new Set(["react"])),
    ).not.toThrow();
  });

  it("keeps bundled skill markdown payloads", () => {
    const packageRoot = path.join(tmpDir, "skills-package");
    const skillDir = path.join(packageRoot, "skills", "example-skill");
    const referenceDir = path.join(skillDir, "references");
    mkdirSync(referenceDir, { recursive: true });

    const skillFile = path.join(skillDir, "SKILL.md");
    const referenceFile = path.join(referenceDir, "usage.md");
    const packageReadme = path.join(packageRoot, "README.md");
    writeFileSync(skillFile, "# Example\n");
    writeFileSync(referenceFile, "# Usage\n");
    writeFileSync(packageReadme, "# Package readme\n");

    expect(
      shouldCopyPackageEntry(skillFile, "@elizaos/skills", packageRoot),
    ).toBe(true);
    expect(
      shouldCopyPackageEntry(referenceFile, "@elizaos/skills", packageRoot),
    ).toBe(true);
    expect(
      shouldCopyPackageEntry(packageReadme, "@elizaos/skills", packageRoot),
    ).toBe(false);
  });

  it("keeps documented runtime assets for packages that load them dynamically", () => {
    const googleapisRoot = path.join(tmpDir, "googleapis");
    const googleDocsApiFile = path.join(
      googleapisRoot,
      "build",
      "src",
      "apis",
      "docs",
      "v1.js",
    );
    const googleReadme = path.join(googleapisRoot, "README.md");
    mkdirSync(path.dirname(googleDocsApiFile), { recursive: true });
    writeFileSync(googleDocsApiFile, "");
    writeFileSync(googleReadme, "# Google APIs\n");

    expect(
      shouldCopyPackageEntry(googleDocsApiFile, "googleapis", googleapisRoot),
    ).toBe(true);
    expect(
      shouldCopyPackageEntry(googleReadme, "googleapis", googleapisRoot),
    ).toBe(false);

    const threeRoot = path.join(tmpDir, "three");
    const threeExampleFile = path.join(
      threeRoot,
      "examples",
      "jsm",
      "loaders",
      "GLTFLoader.js",
    );
    mkdirSync(path.dirname(threeExampleFile), { recursive: true });
    writeFileSync(threeExampleFile, "");

    expect(shouldCopyPackageEntry(threeExampleFile, "three", threeRoot)).toBe(
      true,
    );

    const uiRoot = path.join(tmpDir, "ui");
    const uiDocsFile = path.join(
      uiRoot,
      "dist",
      "cloud-ui",
      "components",
      "docs",
      "usage.md",
    );
    const uiReadme = path.join(uiRoot, "README.md");
    mkdirSync(path.dirname(uiDocsFile), { recursive: true });
    writeFileSync(uiDocsFile, "# Usage\n");
    writeFileSync(uiReadme, "# UI\n");

    expect(shouldCopyPackageEntry(uiDocsFile, "@elizaos/ui", uiRoot)).toBe(
      true,
    );
    expect(shouldCopyPackageEntry(uiReadme, "@elizaos/ui", uiRoot)).toBe(false);
  });

  it("uses the top-level Octokit peer for git-workspace-service", () => {
    expect(
      shouldSkipPackagedDependency("git-workspace-service", "@octokit/rest"),
    ).toBe(true);
    expect(
      shouldSkipPackagedDependency(
        "git-workspace-service",
        "@octokit/auth-app",
      ),
    ).toBe(false);
    expect(
      shouldSkipPackagedDependency(
        "@elizaos/plugin-agent-orchestrator",
        "@octokit/rest",
      ),
    ).toBe(false);
  });

  it("keeps lucide-react as a runtime dependency", () => {
    const packageRoot = path.join(tmpDir, "icon-consumer");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "lucide-react": "^1.0.0",
            typescript: "^5.0.0",
          },
        },
        null,
        2,
      ),
    );

    expect(getRuntimeDependencies(path.join(packageRoot, "package.json"))).toEqual([
      "lucide-react",
    ]);
  });

  it("hoists Solana packages when a compatible top-level copy exists", () => {
    const rootDestDir = path.join(tmpDir, "dist");
    const targetNodeModules = path.join(rootDestDir, "node_modules");
    const requesterDestDir = path.join(
      targetNodeModules,
      "@elizaos",
      "plugin-wallet",
    );

    expect(
      selectCopyTargetNodeModules({
        name: "@solana/web3.js",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map([["@solana/web3.js", "1.98.0"]]),
        resolvedVersion: "2.0.0",
      }),
    ).toBe(targetNodeModules);

    expect(
      selectCopyTargetNodeModules({
        name: "@example/nested-only",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map([["@example/nested-only", "1.0.0"]]),
        resolvedVersion: "2.0.0",
      }),
    ).toBe(path.join(requesterDestDir, "node_modules"));
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

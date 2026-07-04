/** Exercises patch bun exports behavior with deterministic app-core test fixtures. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEsmDynamicRequireCompat,
  patchGitWorkspaceServiceEsmRequireCompat,
  pruneNestedElizaPluginCoreCopies,
  repairElizaCoreRuntimeDist,
} from "./patch-bun-exports.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function writeFixtureFile(filePath, contents = "export {};\n") {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

describe("patch-bun-exports", () => {
  it("applyEsmDynamicRequireCompat replaces generated require shims", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patch-bun-exports-test-"));
    try {
      const target = join(tmp, "index.js");
      writeFileSync(
        target,
        [
          'import pino from "pino";',
          'var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : x)(function(x) {',
          '  if (typeof require !== "undefined") return require.apply(this, arguments);',
          `  throw Error('Dynamic require of "' + x + '" is not supported');`,
          "});",
          'const { Octokit } = __require("@octokit/rest");',
        ].join("\n"),
        "utf8",
      );

      expect(applyEsmDynamicRequireCompat(target)).toBe(true);

      const updated = readFileSync(target, "utf8");
      expect(updated).toContain('import { createRequire } from "module";');
      expect(updated).toContain(
        "const __require = createRequire(import.meta.url);",
      );
      expect(updated).not.toContain("Dynamic require of");
    } finally {
      removePathRecursive(tmp);
    }
  });

  it("patchGitWorkspaceServiceEsmRequireCompat patches installed ESM bundles", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patch-bun-exports-test-"));
    try {
      const pkgDir = join(tmp, "node_modules", "git-workspace-service", "dist");
      const target = join(pkgDir, "index.js");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        target,
        [
          'import pino from "pino";',
          'var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : x)(function(x) {',
          '  if (typeof require !== "undefined") return require.apply(this, arguments);',
          `  throw Error('Dynamic require of "' + x + '" is not supported');`,
          "});",
          'const { Octokit } = __require("@octokit/rest");',
        ].join("\n"),
        "utf8",
      );

      const logs = [];
      expect(
        patchGitWorkspaceServiceEsmRequireCompat(tmp, (msg) => logs.push(msg)),
      ).toBe(true);
      expect(readFileSync(target, "utf8")).toContain(
        "const __require = createRequire(import.meta.url);",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("git-workspace-service");
    } finally {
      removePathRecursive(tmp);
    }
  });

  it("repairElizaCoreRuntimeDist replaces an incomplete runtime dist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patch-bun-exports-test-"));
    try {
      const sourcePkgDir = join(tmp, "source-core");
      const targetPkgDir = join(tmp, "target-core");
      for (const relativePath of [
        "dist/index.js",
        "dist/browser/index.browser.js",
        "dist/node/index.node.js",
      ]) {
        writeFixtureFile(
          join(sourcePkgDir, relativePath),
          `// healthy ${relativePath}\n`,
        );
      }
      writeFixtureFile(join(targetPkgDir, "dist/testing/index.js"));
      writeFixtureFile(join(targetPkgDir, "dist/stale.js"), "// stale\n");

      expect(repairElizaCoreRuntimeDist(targetPkgDir, sourcePkgDir)).toBe(true);
      expect(readFileSync(join(targetPkgDir, "dist/index.js"), "utf8")).toBe(
        "// healthy dist/index.js\n",
      );
      expect(
        existsSync(join(targetPkgDir, "dist/browser/index.browser.js")),
      ).toBe(true);
      expect(existsSync(join(targetPkgDir, "dist/node/index.node.js"))).toBe(
        true,
      );
      expect(existsSync(join(targetPkgDir, "dist/stale.js"))).toBe(false);
    } finally {
      removePathRecursive(tmp);
    }
  });

  it("pruneNestedElizaPluginCoreCopies removes plugin-local core copies", () => {
    const tmp = mkdtempSync(join(tmpdir(), "patch-bun-exports-test-"));
    try {
      const rootCorePkg = join(
        tmp,
        "node_modules",
        "@elizaos",
        "core",
        "package.json",
      );
      const pluginPkg = join(
        tmp,
        "node_modules",
        "@elizaos",
        "plugin-demo",
        "package.json",
      );
      const nestedCoreDir = join(
        tmp,
        "node_modules",
        "@elizaos",
        "plugin-demo",
        "node_modules",
        "@elizaos",
        "core",
      );

      writeFixtureFile(rootCorePkg, '{"name":"@elizaos/core"}\n');
      writeFixtureFile(pluginPkg, '{"name":"@elizaos/plugin-demo"}\n');
      writeFixtureFile(
        join(nestedCoreDir, "package.json"),
        '{"name":"@elizaos/core"}\n',
      );

      const logs = [];
      expect(
        pruneNestedElizaPluginCoreCopies(tmp, (msg) => logs.push(msg)),
      ).toBe(true);
      expect(existsSync(nestedCoreDir)).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("@elizaos/plugin-demo");
    } finally {
      removePathRecursive(tmp);
    }
  });
});

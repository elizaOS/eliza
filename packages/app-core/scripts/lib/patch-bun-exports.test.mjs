import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEsmDynamicRequireCompat,
  patchGitWorkspaceServiceEsmRequireCompat,
} from "./patch-bun-exports.mjs";

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
      rmSync(tmp, { recursive: true, force: true });
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
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

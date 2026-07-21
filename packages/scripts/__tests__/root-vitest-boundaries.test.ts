/** Verifies root test discovery excludes tool checkouts without masking first-party paths. */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const vitestConfig = path.join(repoRoot, "vitest.config.ts");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function writeTest(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    "import { test } from 'vitest';\ntest('visible', () => {});\n",
  );
}

describe("root Vitest boundaries", () => {
  test("worktree exclusions are root-anchored", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "root-vitest-boundaries-"),
    );
    fixtures.push(root);
    const rootWorktreeDirs = [
      ".worktrees",
      ".audit-worktrees",
      ".codex-agent-worktrees",
      ".codex-pr-worktrees",
      ".codex-worktrees",
    ];
    const ignoredFiles: string[] = [];
    const visibleFiles: string[] = [];

    for (const [index, worktreeDir] of rootWorktreeDirs.entries()) {
      const ignoredFile = path.join(
        root,
        worktreeDir,
        "checkout",
        `ignored-${index}.test.ts`,
      );
      const visibleFile = path.join(
        root,
        "packages",
        worktreeDir,
        `visible-${index}.test.ts`,
      );
      writeTest(ignoredFile);
      writeTest(visibleFile);
      ignoredFiles.push(ignoredFile);
      visibleFiles.push(visibleFile);
    }

    const result = spawnSync(
      process.execPath,
      [
        vitestBin,
        "list",
        "--root",
        root,
        "--config",
        vitestConfig,
        "--filesOnly",
        "--staticParse",
        "--no-color",
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    for (const ignoredFile of ignoredFiles) {
      expect(result.stdout).not.toContain(
        path.relative(root, ignoredFile).split(path.sep).join("/"),
      );
    }
    for (const visibleFile of visibleFiles) {
      expect(result.stdout).toContain(
        path.relative(root, visibleFile).split(path.sep).join("/"),
      );
    }
  });
});

/** Verifies root test discovery excludes tool checkouts without masking first-party paths. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const vitestConfig = path.join(repoRoot, "vitest.config.ts");
const fixtures: string[] = [];
const rootWorktreeDirs = [
  ".worktrees",
  ".audit-worktrees",
  ".codex-agent-worktrees",
  ".codex-pr-worktrees",
  ".codex-worktrees",
];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function isGitIgnored(gitRoot: string, relativePath: string): boolean {
  const result = spawnSync(
    "git",
    [
      "-c",
      `core.excludesFile=${path.join(gitRoot, ".empty-global-ignore")}`,
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      relativePath,
    ],
    { cwd: gitRoot, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed for ${relativePath}: ${result.stderr}`,
    );
  }
  return result.status === 0;
}

function writeFailingSentinel(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    'throw new Error("excluded root worktree sentinel executed");\n',
  );
}

function writePassingTest(filePath: string, markerPath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [
      'import fs from "node:fs";',
      'test("visible", () => {',
      `  fs.writeFileSync(${JSON.stringify(markerPath)}, "executed\\n");`,
      "});",
      "",
    ].join("\n"),
  );
}

describe("root Vitest boundaries", () => {
  test("gitignore excludes generated local Eliza state at every workspace depth", () => {
    const gitRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "local-eliza-state-boundaries-"),
    );
    fixtures.push(gitRoot);
    fs.copyFileSync(
      path.join(repoRoot, ".gitignore"),
      path.join(gitRoot, ".gitignore"),
    );
    fs.writeFileSync(path.join(gitRoot, ".empty-global-ignore"), "");
    const initResult = spawnSync("git", ["init", "--quiet"], {
      cwd: gitRoot,
      encoding: "utf8",
    });
    if (initResult.error) throw initResult.error;
    expect(initResult.status, initResult.stderr).toBe(0);

    expect(
      isGitIgnored(gitRoot, ".eliza-local/review/vite.config.views.ts"),
    ).toBe(true);
    expect(
      isGitIgnored(
        gitRoot,
        "packages/plugin-example/.eliza-local/runtime.sqlite",
      ),
    ).toBe(true);
  });

  test("gitignore worktree exclusions are root-anchored", () => {
    const gitRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "root-gitignore-boundaries-"),
    );
    fixtures.push(gitRoot);
    fs.copyFileSync(
      path.join(repoRoot, ".gitignore"),
      path.join(gitRoot, ".gitignore"),
    );
    fs.writeFileSync(path.join(gitRoot, ".empty-global-ignore"), "");
    const initResult = spawnSync("git", ["init", "--quiet"], {
      cwd: gitRoot,
      encoding: "utf8",
    });
    if (initResult.error) throw initResult.error;
    expect(initResult.status, initResult.stderr).toBe(0);

    for (const worktreeDir of rootWorktreeDirs) {
      expect(
        isGitIgnored(gitRoot, `${worktreeDir}/checkout/excluded-probe.test.ts`),
      ).toBe(true);
      expect(
        isGitIgnored(gitRoot, `packages/${worktreeDir}/visible-probe.test.ts`),
      ).toBe(false);
    }
  });

  test("Vitest executes nested first-party tests and excludes root worktrees", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "root-vitest-boundaries-"),
    );
    fixtures.push(root);
    const executionMarkers: string[] = [];

    for (const [index, worktreeDir] of rootWorktreeDirs.entries()) {
      const excludedSentinel = path.join(
        root,
        worktreeDir,
        "checkout",
        `excluded-sentinel-${index}.test.ts`,
      );
      const visibleFile = path.join(
        root,
        "packages",
        worktreeDir,
        `visible-${index}.test.ts`,
      );
      const executionMarker = path.join(root, `executed-${index}.txt`);
      writeFailingSentinel(excludedSentinel);
      writePassingTest(visibleFile, executionMarker);
      executionMarkers.push(executionMarker);
    }

    const result = spawnSync(
      process.execPath,
      [
        vitestBin,
        "run",
        "--root",
        root,
        "--config",
        vitestConfig,
        "--globals",
        "--no-color",
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    for (const executionMarker of executionMarkers) {
      expect(fs.readFileSync(executionMarker, "utf8")).toBe("executed\n");
    }
  });
});

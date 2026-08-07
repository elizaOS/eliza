/**
 * Compares the workspace runner's required unit-test plan bidirectionally with
 * live package manifests so a valid one-task fragment cannot mask lane loss.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runner = join(repoRoot, "packages/scripts/run-all-tests.mjs");

function packageJson(directory: string) {
  return JSON.parse(
    readFileSync(join(repoRoot, directory, "package.json"), "utf8"),
  ) as {
    name?: string;
    scripts?: Record<string, string>;
    elizaos?: { scripts?: { testLanes?: string[] } };
  };
}

function independentWorkspaceDirs() {
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  if (!Array.isArray(rootPackage.workspaces)) {
    throw new Error("root package.json must declare workspace patterns");
  }

  // This deliberately does not import the runner's workspace expansion seam.
  // The root manifest currently uses only literal directories and one-segment
  // trailing globs; a new glob grammar must extend this independent oracle.
  const directories = new Set<string>();
  for (const pattern of rootPackage.workspaces) {
    if (
      pattern.startsWith("!") ||
      (pattern.includes("*") && !pattern.endsWith("/*"))
    ) {
      throw new Error(`unsupported independent workspace pattern: ${pattern}`);
    }
    if (!pattern.endsWith("/*")) {
      if (existsSync(join(repoRoot, pattern, "package.json"))) {
        directories.add(pattern);
      }
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(repoRoot, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = `${parent}/${entry.name}`;
      if (existsSync(join(repoRoot, directory, "package.json"))) {
        directories.add(directory);
      }
    }
  }
  directories.delete("packages/cloud/e2e");
  return [...directories].sort();
}

function sourceUnitTestDirs() {
  return independentWorkspaceDirs()
    .filter((directory) => {
      const command = packageJson(directory).scripts?.test;
      return typeof command === "string" && command.trim().length > 0;
    })
    .sort();
}

function plan(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [runner, "--plan=json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    summary: {
      taskCount: number;
      packageCount: number;
      byScript: Record<string, number>;
      byPackage: Record<string, number>;
    };
    tasks: Array<{ relativeDir: string; scriptName: string }>;
  };
}

describe("run-all-tests live source plan", () => {
  test("matches every canonical unit-test manifest exactly", () => {
    const result = plan(["--only=test", "--no-cloud", "--require-work"]);
    const actual = result.tasks
      .map(({ relativeDir, scriptName }) => `${relativeDir}#${scriptName}`)
      .sort();
    const expected = sourceUnitTestDirs().map(
      (directory) => `${directory}#test`,
    );
    expect(actual).toEqual(expected);
    expect(result.summary.taskCount).toBe(expected.length);
    expect(result.summary.packageCount).toBe(expected.length);
    expect(result.summary.byScript).toEqual({ test: expected.length });
    expect(result.summary.byPackage).toEqual(
      Object.fromEntries(
        sourceUnitTestDirs().map((directory) => {
          const name = packageJson(directory).name;
          if (!name)
            throw new Error(`${directory} must declare a package name`);
          return [name, 1];
        }),
      ),
    );
    expect(new Set(actual).size).toBe(actual.length);
  });

  for (const lane of ["server", "client"]) {
    test(`${lane} lane matches its source-owned package metadata exactly`, () => {
      const expected = independentWorkspaceDirs().filter((directory) =>
        packageJson(directory).elizaos?.scripts?.testLanes?.includes(lane),
      );
      expect(expected.length).toBeGreaterThan(0);
      for (const directory of expected) {
        expect(
          packageJson(directory).scripts?.test?.trim().length,
          `${directory} must expose a canonical test script`,
        ).toBeGreaterThan(0);
      }
      const result = plan(
        ["--only=test", "--no-cloud", `--lane=${lane}`, "--require-work"],
        { TEST_SCRIPT_FILTER: "^test$" },
      );
      expect(result.tasks.map(({ relativeDir }) => relativeDir).sort()).toEqual(
        expected,
      );
      expect(result.summary).toMatchObject({
        taskCount: expected.length,
        packageCount: expected.length,
        byScript: { test: expected.length },
      });
      expect(result.summary.byPackage).toEqual(
        Object.fromEntries(
          expected.map((directory) => {
            const name = packageJson(directory).name;
            if (!name)
              throw new Error(`${directory} must declare a package name`);
            return [name, 1];
          }),
        ),
      );
    });
  }
});

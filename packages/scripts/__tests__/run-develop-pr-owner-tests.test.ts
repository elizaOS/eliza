/**
 * Proves develop-PR owner selection uses longest live workspace ownership and
 * executes only source-backed canonical test plans.
 */

import { describe, expect, test } from "bun:test";
import {
  buildOwnerFilter,
  buildRunnerArgs,
  runOwnerTests,
  selectOwningWorkspaceDirs,
} from "../run-develop-pr-owner-tests.mjs";

const WORKSPACES = [
  "packages/app",
  "packages/app/packages/nested",
  "packages/core",
  "plugins/plugin-openai",
];

describe("develop pull-request owning-package tests", () => {
  test("maps files to the longest workspace owner and ignores root files", () => {
    expect(
      selectOwningWorkspaceDirs(
        [
          "package.json",
          "packages/app/src/App.tsx",
          "packages/app/packages/nested/src/index.ts",
          "packages/core/package.json",
        ],
        WORKSPACES,
      ),
    ).toEqual([
      "packages/app",
      "packages/app/packages/nested",
      "packages/core",
    ]);
  });

  test("anchors an exact escaped workspace-label filter", () => {
    expect(buildOwnerFilter(["packages/a.b", "plugins/plugin-openai"])).toBe(
      "\\((?:packages/a\\.b|plugins/plugin-openai)\\)#",
    );
  });

  test("execution adds the semantic work requirement while planning does not", () => {
    const filter = "\\((?:packages/core)\\)#";
    expect(buildRunnerArgs(filter, false)).toContain("--plan=json");
    expect(buildRunnerArgs(filter, false)).not.toContain("--require-work");
    expect(buildRunnerArgs(filter, true)).toContain("--require-work");
    expect(buildRunnerArgs(filter, true)).not.toContain("--plan=json");
  });

  test("does not plan package work when changed files have no owner", () => {
    let planned = false;
    const result = runOwnerTests({
      changedFiles: ["README.md", "packages/scripts/example.mjs"],
      workspaceDirs: WORKSPACES,
      planTests: () => {
        planned = true;
        return { summary: { taskCount: 0 }, tasks: [] };
      },
      executeTests: () => {
        throw new Error("must not execute");
      },
    });
    expect(result.status).toBe("no-workspace-owner");
    expect(planned).toBe(false);
  });

  test("accepts an owner with no canonical package test", () => {
    let executed = false;
    const result = runOwnerTests({
      changedFiles: ["packages/core/src/index.ts"],
      workspaceDirs: WORKSPACES,
      planTests: () => ({ summary: { taskCount: 0 }, tasks: [] }),
      executeTests: () => {
        executed = true;
      },
    });
    expect(result.status).toBe("no-package-tests");
    expect(executed).toBe(false);
  });

  test("executes an exact non-empty canonical owner plan", () => {
    let executedFilter = "";
    const result = runOwnerTests({
      changedFiles: ["packages/core/src/index.ts"],
      workspaceDirs: WORKSPACES,
      planTests: () => ({
        summary: { taskCount: 1 },
        tasks: [{ relativeDir: "packages/core", scriptName: "test" }],
      }),
      executeTests: (filter) => {
        executedFilter = filter;
      },
    });
    expect(result).toEqual({
      status: "executed",
      ownerDirs: ["packages/core"],
      taskCount: 1,
    });
    expect(executedFilter).toBe("\\((?:packages/core)\\)#");
  });

  test("rejects mismatched summaries and tasks outside selected owners", () => {
    const base = {
      changedFiles: ["packages/core/src/index.ts"],
      workspaceDirs: WORKSPACES,
      executeTests: () => undefined,
    };
    expect(() =>
      runOwnerTests({
        ...base,
        planTests: () => ({ summary: { taskCount: 2 }, tasks: [] }),
      }),
    ).toThrow(/summary must exactly match/);
    expect(() =>
      runOwnerTests({
        ...base,
        planTests: () => ({
          summary: { taskCount: 1 },
          tasks: [{ relativeDir: "plugins/plugin-openai", scriptName: "test" }],
        }),
      }),
    ).toThrow(/outside the selected owners/);
  });

  test("rejects non-canonical scripts in the owner plan", () => {
    expect(() =>
      runOwnerTests({
        changedFiles: ["packages/core/src/index.ts"],
        workspaceDirs: WORKSPACES,
        planTests: () => ({
          summary: { taskCount: 1 },
          tasks: [{ relativeDir: "packages/core", scriptName: "test:e2e" }],
        }),
        executeTests: () => undefined,
      }),
    ).toThrow(/only canonical test scripts/);
  });
});

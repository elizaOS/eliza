/**
 * Proves the coding-tools scenario restores shared runtime and process state
 * when setup fails after isolation has begun.
 */

import { access } from "node:fs/promises";

import { createDeterministicModelFixtureRegistry } from "@elizaos/core/testing";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";

import codingToolsScenario from "../../test/scenarios/deterministic-coding-tools-actions.scenario.ts";

const WORKSPACE_ROOTS = "CODING_TOOLS_WORKSPACE_ROOTS";
const BLOCKED_PATHS = "CODING_TOOLS_BLOCKED_PATHS";
const originalWorkspaceRoots = process.env[WORKSPACE_ROOTS];
const originalBlockedPaths = process.env[BLOCKED_PATHS];

function restoreOriginalEnvironment(): void {
  if (originalWorkspaceRoots === undefined) delete process.env[WORKSPACE_ROOTS];
  else process.env[WORKSPACE_ROOTS] = originalWorkspaceRoots;
  if (originalBlockedPaths === undefined) delete process.env[BLOCKED_PATHS];
  else process.env[BLOCKED_PATHS] = originalBlockedPaths;
}

afterEach(() => {
  restoreOriginalEnvironment();
});

describe("deterministic coding-tools scenario cleanup", () => {
  it("restores set and unset environment values after setup failure", async () => {
    process.env[WORKSPACE_ROOTS] = "/outer/workspace";
    delete process.env[BLOCKED_PATHS];
    const originalEvaluators = [{ name: "shared-evaluator" }];
    const runtime = {
      scenarioModelFixtures: createDeterministicModelFixtureRegistry(),
      evaluators: originalEvaluators,
      plugins: [],
      registerPlugin: async () => {
        throw new Error("forced registration failure");
      },
    };
    const seed = codingToolsScenario.seed?.[0];
    const cleanup = codingToolsScenario.cleanup?.[0];
    if (seed?.type !== "custom" || cleanup?.type !== "custom") {
      throw new Error("coding-tools scenario custom seed/cleanup unavailable");
    }

    const context = { runtime } as unknown as ScenarioContext;
    let temporaryRoot: string | undefined;
    try {
      await expect(seed.apply(context)).rejects.toThrow(
        "forced registration failure",
      );
      temporaryRoot = process.env[WORKSPACE_ROOTS];
      if (!temporaryRoot || temporaryRoot === "/outer/workspace") {
        throw new Error("seed did not install its isolated workspace");
      }
      // Confirm setup reached the real filesystem and isolation changes before
      // the injected plugin registration failure, not an earlier seed guard.
      await access(temporaryRoot);
      expect(process.env[BLOCKED_PATHS]).toBeDefined();
      expect(runtime.evaluators).toEqual([]);
    } finally {
      await cleanup.apply(context);
    }

    expect(runtime.evaluators).toBe(originalEvaluators);
    expect(process.env[WORKSPACE_ROOTS]).toBe("/outer/workspace");
    expect(process.env[BLOCKED_PATHS]).toBeUndefined();
    if (!temporaryRoot) throw new Error("isolated workspace was not observed");
    await expect(access(temporaryRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

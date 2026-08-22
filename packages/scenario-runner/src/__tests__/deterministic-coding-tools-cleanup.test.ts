/**
 * Proves the coding-tools scenario restores shared runtime and process state
 * when setup fails after isolation has begun.
 */

import { access } from "node:fs/promises";

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

    await expect(
      seed.apply({ runtime } as unknown as ScenarioContext),
    ).rejects.toThrow("forced registration failure");
    const temporaryRoot = process.env[WORKSPACE_ROOTS];
    expect(temporaryRoot).not.toBe("/outer/workspace");
    expect(process.env[BLOCKED_PATHS]).toBeDefined();
    expect(runtime.evaluators).toEqual([]);

    await cleanup.apply({ runtime } as unknown as ScenarioContext);

    expect(runtime.evaluators).toBe(originalEvaluators);
    expect(process.env[WORKSPACE_ROOTS]).toBe("/outer/workspace");
    expect(process.env[BLOCKED_PATHS]).toBeUndefined();
    await expect(access(temporaryRoot as string)).rejects.toThrow();
  });
});

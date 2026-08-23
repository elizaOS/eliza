/**
 * Pins what an action turn's `responseText` is allowed to claim. Core marks a
 * reply that merely restates an internal `ActionResult` as
 * `transcriptVisibility: "internal"` and drops it before egress, so a report
 * that prints that receipt as the response text misrepresents what the user
 * saw. Real `runScenario` against a lightweight fake runtime.
 */

import type { Action, AgentRuntime } from "@elizaos/core";
import type {
  ScenarioDefinition,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor.ts";

const RECEIPT = JSON.stringify({ effect: "view_navigation", status: "ok" });

function actionReturning(name: string, result: unknown): Action {
  return {
    name,
    description: name,
    examples: [],
    validate: async () => true,
    handler: async () => result,
  } as unknown as Action;
}

function createRuntime(actions: Action[]): AgentRuntime {
  return {
    actions,
    plugins: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

async function runActionTurn(
  actions: Action[],
  actionName: string,
): Promise<ScenarioTurnExecution> {
  const captured: ScenarioTurnExecution[] = [];
  const scenario = {
    id: `transcript-visibility-${actionName.toLowerCase()}`,
    title: "transcript visibility",
    domain: "scenario-runner",
    turns: [
      {
        kind: "action",
        name: "run the action",
        actionName,
        assertTurn: (execution: ScenarioTurnExecution) => {
          captured.push(execution);
          return undefined;
        },
      },
    ],
  } as unknown as ScenarioDefinition;

  await runScenario(scenario, createRuntime(actions), {
    providerName: "deterministic-model-provider",
    minJudgeScore: 0,
    turnTimeoutMs: 5_000,
  });
  const execution = captured[0];
  if (!execution) throw new Error("the action turn did not execute");
  return execution;
}

describe("action turn responseText mirrors runtime transcript visibility", () => {
  it("does not present an internal receipt as the response text", async () => {
    const execution = await runActionTurn(
      [
        actionReturning("INTERNAL_ONLY", {
          success: true,
          text: RECEIPT,
          transcriptVisibility: "internal",
        }),
      ],
      "INTERNAL_ONLY",
    );
    expect(execution.responseText).toBe("");
    // The receipt is preserved, just on the channel that names it honestly.
    expect(execution.responseBody).toMatchObject({
      text: RECEIPT,
      transcriptVisibility: "internal",
    });
  });

  it("uses the action's vetted fallback prose when it declares one", async () => {
    const execution = await runActionTurn(
      [
        actionReturning("INTERNAL_WITH_FALLBACK", {
          success: true,
          text: RECEIPT,
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          modelReplyFallback: "The app launched successfully.",
        }),
      ],
      "INTERNAL_WITH_FALLBACK",
    );
    expect(execution.responseText).toBe("The app launched successfully.");
    expect(execution.responseBody).toMatchObject({ text: RECEIPT });
  });

  it("still surfaces an ordinary user-visible result unchanged", async () => {
    const execution = await runActionTurn(
      [
        actionReturning("USER_VISIBLE", {
          success: true,
          text: "Opened Settings.",
        }),
      ],
      "USER_VISIBLE",
    );
    expect(execution.responseText).toBe("Opened Settings.");
  });

  it("prefers explicitly user-facing prose over the internal receipt", async () => {
    const execution = await runActionTurn(
      [
        actionReturning("INTERNAL_WITH_USER_FACING", {
          success: true,
          text: RECEIPT,
          transcriptVisibility: "internal",
          verifiedUserFacing: true,
          userFacingText: "Opened Remote Ledger.",
        }),
      ],
      "INTERNAL_WITH_USER_FACING",
    );
    expect(execution.responseText).toBe("Opened Remote Ledger.");
  });
});

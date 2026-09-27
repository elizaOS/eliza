/** Coding progress and empty responses must not consume completion-verification retries. */
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

const uncertainReceipt = {
  version: 1,
  kind: "workspace_delta",
  scope: {
    kind: "git_worktree",
    root: "/app",
    rootId: "a".repeat(64),
    executionDomainId: "b".repeat(64),
    coverage: "tracked_and_untracked_nonignored",
  },
  observedAt: "2026-09-27T01:52:37.129Z",
  outcome: "indeterminate",
  reasonCode: "OBSERVATION_TIME_BUDGET_EXCEEDED",
};

describe("coding pending terminal recovery", () => {
  it("continues pending work after progress and empty responses without spending verification retries", async () => {
    const executed: string[] = [];
    let round = 0;
    const result = await runPlannerLoop({
      codingMode: true,
      context: { id: "pending-coding" },
      runtime: {
        useModel: async () => {
          round++;
          if (round > 5) throw new Error("Unexpected retry");
          if (round === 4) return { text: "\n\n", toolCalls: [] };
          const name = round === 2 ? "REPLY" : round === 5 ? "WRITE" : "SHELL";
          return {
            text: "",
            toolCalls: [
              {
                id: `pending-${round}`,
                name,
                arguments: {
                  command: round === 1 ? "git status" : "rg close src",
                  text: "I will keep working.",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async (call) => {
        executed.push(call.name);
        return {
          success: true,
          text: "Operation recorded",
          ...(executed.length === 1
            ? { data: { workspaceDeltaReceipt: uncertainReceipt } }
            : {}),
          ...(call.name === "WRITE" ? { continueChain: false } : {}),
        };
      },
    });
    expect(round).toBe(5);
    expect(executed).toEqual(["SHELL", "SHELL", "WRITE"]);
    expect(result.terminalFailure).toBeUndefined();
    expect(result.trajectory.evaluatorOutputs).toEqual([]);
  });

  it("keeps final completion gated without claiming an indeterminate observation changed files", async () => {
    let round = 0;
    const result = await runPlannerLoop({
      codingMode: true,
      context: { id: "uncertain-coding" },
      runtime: {
        useModel: async () => {
          round++;
          if (round > 3) throw new Error("Unexpected retry");
          return {
            text: "",
            toolCalls: [
              {
                id: `uncertain-${round}`,
                name: round === 1 ? "SHELL" : "REPLY",
                arguments: {
                  command: "git status",
                  text: "Done",
                  eliza_turn_scope: round === 1 ? "more_work_pending" : "final",
                },
              },
            ],
          };
        },
      },
      executeToolCall: async () => ({
        success: true,
        text: "Working tree clean",
        data: { workspaceDeltaReceipt: uncertainReceipt },
      }),
    });
    expect(round).toBe(3);
    expect(result.terminalFailure?.kind).toBe("coding_mutation_unverified");
    expect(result.finalMessage).toContain("verification did not complete");
    expect(result.finalMessage).not.toContain("changed files");
    expect(result.evaluator?.success).toBe(false);
  });
});

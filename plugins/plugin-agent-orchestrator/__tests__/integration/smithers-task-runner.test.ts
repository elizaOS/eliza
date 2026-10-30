/**
 * Real Smithers task worker: the parent writes each step response to the
 * worker's stdin, and the worker reads it line by line.
 */
import { describe, expect, it } from "vitest";
import {
  collectDurableTaskTurns,
  runTaskWithSmithers,
} from "../../src/services/smithers-task-runner.js";

describe("Smithers task runner", () => {
  it("bridges an agent turn that contains Unicode line and paragraph separators", async () => {
    // A coding agent can copy U+2028/U+2029 from the files and pages it reads.
    const finalText = "Line one Line two Line three";
    let turns = 0;
    const runId = `separators-${Date.now()}`;
    const result = await runTaskWithSmithers(
      {
        tenantId: "00000000-0000-4000-8000-000000000001",
        taskId: runId,
        runId,
        initialPrompt: "Return text with separators",
        maxTurns: 1,
      },
      {
        runTurn: async () => {
          turns += 1;
          return { done: true, output: { finalText } };
        },
      },
      { timeoutMs: 20_000 },
    );

    expect(result.status).toBe("completed");
    expect(turns).toBe(1);
    expect(
      collectDurableTaskTurns(result.execution).map(
        (turn) => turn.output?.finalText,
      ),
    ).toEqual([finalText]);
  }, 45_000);
});

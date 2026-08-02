/** Verifies the app-eval task and result wire contract without spawning a model runtime. */

import { describe, expect, it } from "vitest";
import {
  benchmarkTaskPayload,
  parseBenchmarkResultLine,
} from "./run-benchmarks.ts";

describe("app-eval benchmark wire contract", () => {
  it("preserves task context while withholding evaluator criteria", () => {
    const payload = benchmarkTaskPayload({
      id: "coding-1",
      type: "coding",
      prompt: "Implement it",
      context: { workspace: { files: { "src/index.ts": "" } } },
      evaluation: {
        criteria: [
          {
            name: "hidden answer",
            weight: 1,
            description: "Do not expose this to the model",
          },
        ],
      },
    });

    expect(payload).toEqual({
      id: "coding-1",
      type: "coding",
      prompt: "Implement it",
      context: { workspace: { files: { "src/index.ts": "" } } },
    });
    expect(payload).not.toHaveProperty("evaluation");
  });

  it("accepts only the complete benchmark result schema", () => {
    expect(
      parseBenchmarkResultLine(
        JSON.stringify({
          id: "task-1",
          response: "done",
          task_type: "research",
          actions_taken: ["REPLY"],
          duration_ms: 12,
          success: true,
        }),
      ),
    ).toMatchObject({ id: "task-1", task_type: "research", success: true });

    expect(parseBenchmarkResultLine('{"id":"log","level":"info"}')).toBeNull();
    expect(
      parseBenchmarkResultLine(
        '{"id":"task-1","response":"done","actions_taken":[],"duration_ms":12,"success":true}',
      ),
    ).toBeNull();
  });
});

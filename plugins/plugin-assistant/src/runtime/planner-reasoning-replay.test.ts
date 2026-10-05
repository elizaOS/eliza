/** Verifies complete private model history independently from tool settlement and replies. */
import type {
  ChatMessage,
  PlannerRuntime,
  RecordedStage,
  TrajectoryRecorder,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { parsePlannerOutput, runPlannerLoop } from "./planner-loop.ts";

describe("private planner reasoning continuation", () => {
  it("uses only visible provider text for a user-facing reply", () => {
    const output = parsePlannerOutput({
      text: "Visible reply",
      content: [
        {
          type: "reasoning",
          text: "Private continuation",
          providerOptions: { cerebras: { model: "qwen-3.8-27b" } },
        },
      ],
    });
    expect(output.messageToUser).toBe("Visible reply");
  });
  it("retains complete reasoning once in the next request and recorded trajectory without exposing it in the reply", async () => {
    const reasoning = "Private provider continuation α\n".repeat(1000);
    const part = {
      type: "reasoning",
      text: reasoning,
      providerOptions: { cerebras: { model: "qwen-3.8-27b" } },
    };
    const inputs: ChatMessage[][] = [];
    const stages: RecordedStage[] = [];
    let calls = 0;
    let executed = 0;
    const runtime: PlannerRuntime = {
      useModel: async (_type, params) => {
        inputs.push(params.messages ?? []);
        calls++;
        if (calls > 2) throw new Error("Unexpected extra model call");
        return {
          text: "",
          content: calls === 1 ? [part] : undefined,
          toolCalls: [
            {
              id: `read-${calls}`,
              name: "READ",
              arguments: {
                file_path: `/app/${calls}.ts`,
                eliza_turn_scope: "more_work_pending",
              },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        };
      },
    };
    const result = await runPlannerLoop({
      runtime,
      codingMode: true,
      context: { id: "private-reasoning" },
      trajectoryId: "private-reasoning",
      recorder: {
        recordStage: async (_id: string, stage: RecordedStage) => {
          stages.push(stage);
        },
      } as unknown as TrajectoryRecorder,
      tools: [
        {
          name: "READ",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { file_path: { type: "string" } },
          },
        },
      ],
      executeToolCall: async () => {
        executed++;
        return {
          success: true,
          text: "Complete source checked.",
          data: { readOnlyOperation: true },
          ...(executed === 2 ? { continueChain: false } : {}),
        };
      },
    });
    expect(calls).toBe(2);
    const messages = inputs[1] ?? [];
    const parts = messages
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((value) => value.type === "reasoning");
    expect(parts).toEqual([part]);
    const reconstructed = (result.trajectory.modelHistory ?? [])
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .filter((value) => value.type === "reasoning");
    expect(reconstructed).toEqual([part]);
    expect(
      stages.find((stage) => stage.kind === "planner")?.model?.responseContent,
    ).toEqual([part]);
    expect(result.finalMessage ?? "").not.toContain(
      "Private provider continuation",
    );
    expect(executed).toBe(2);
    expect(result.trajectory.steps).toHaveLength(2);
  });
});

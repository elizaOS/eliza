import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { DeterministicModelCall } from "./deterministic-model-plugin.ts";
import { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture.ts";

const input = "Run SCHEDULED_TASKS to list scheduled reminders";
const args = { action: "list", kind: "custom" };

function evaluatorCall(scopes: {
  discovery?: unknown;
  action?: unknown;
}): DeterministicModelCall {
  const withScope = (value: Record<string, unknown>, scope: unknown) =>
    scope === undefined ? value : { ...value, eliza_turn_scope: scope };
  return {
    modelType: ModelType.RESPONSE_HANDLER,
    latestUserText: "",
    toolNames: [],
    params: {
      messages: [
        { role: "system", content: "evaluator_stage:\nEvaluate the turn." },
        { role: "user", content: `message:user:\n${input}` },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "discover",
              toolName: "DISCOVER_ACTIONS",
              input: withScope(
                { names: ["SCHEDULED_TASKS"] },
                scopes.discovery,
              ),
            },
            {
              type: "tool-call",
              toolCallId: "call",
              toolName: "SCHEDULED_TASKS",
              input: withScope(args, scopes.action),
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "discover",
              toolName: "DISCOVER_ACTIONS",
              output: { type: "text", value: '{"success":true}' },
            },
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "SCHEDULED_TASKS",
              output: { type: "text", value: '{"success":true}' },
            },
          ],
        },
      ],
    },
  } as unknown as DeterministicModelCall;
}

describe("post-tool evaluator fixture", () => {
  const fixture = postToolEvaluatorFixture({
    actionName: "SCHEDULED_TASKS",
    discoverBeforeExecution: true,
    args,
    input,
  });
  const match = fixture.match as (call: DeterministicModelCall) => boolean;

  it("matches history that replays the planner's declared turn scope", () => {
    expect(
      match(evaluatorCall({ discovery: "more_work_pending", action: "final" })),
    ).toBe(true);
    expect(match(evaluatorCall({}))).toBe(true);
  });

  it("still rejects an invalid scope or a changed action argument", () => {
    expect(match(evaluatorCall({ action: "later" }))).toBe(false);
    const changed = evaluatorCall({ action: "final" });
    const assistant = changed.params.messages?.[2];
    if (assistant && Array.isArray(assistant.content)) {
      const part = assistant.content[1] as { input: Record<string, unknown> };
      part.input = { ...part.input, kind: "reminder" };
    }
    expect(match(changed)).toBe(false);
  });
});

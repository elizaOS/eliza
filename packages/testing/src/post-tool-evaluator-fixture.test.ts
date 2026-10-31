/** Verifies the post-tool evaluator fixture against replayed planner history, including the declared turn scope. */

import type { GenerateTextParams, JsonValue } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { DeterministicModelCall } from "./deterministic-model-plugin.ts";
import { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture.ts";

const input = "route deterministic GitHub parent action to pull request list";
const args = {
  action: "pr_list",
  repo: "octo/repo",
  as: "agent",
  state: "open",
};

type Messages = NonNullable<GenerateTextParams["messages"]>;

function toolStep(
  id: string,
  toolName: string,
  callInput: Record<string, JsonValue>,
  result: Record<string, JsonValue>,
): Messages {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: id, toolName, input: callInput },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName,
          output: { type: "text", value: JSON.stringify(result) },
        },
      ],
    },
  ] as Messages;
}

// The message shape of the evaluator call that the planner loop sends after a
// discovery and the action, as recorded from the deterministic GitHub scenario.
function evaluatorCall(steps: Messages): DeterministicModelCall {
  const messages = [
    {
      role: "system",
      content:
        "evaluator_stage:\ntask: Evaluate latest action; route planner-loop next step.",
    },
    { role: "user", content: `# Current message\nuser: ${input}` },
    ...steps,
    {
      role: "user",
      content: "# Current decision state\nQueued call IDs: []",
    },
  ] as Messages;
  return {
    modelType: ModelType.RESPONSE_HANDLER,
    params: { prompt: "", messages } as GenerateTextParams,
    latestUserText: input,
    toolNames: [],
  };
}

const discovery = (scope?: string) =>
  toolStep(
    "discover-github",
    "DISCOVER_ACTIONS",
    { names: ["GITHUB"], ...(scope ? { eliza_turn_scope: scope } : {}) },
    { success: true, text: "Named tools enabled." },
  );
const action = (callArgs: Record<string, JsonValue>, scope?: string) =>
  toolStep(
    "call-github",
    "GITHUB",
    { ...callArgs, ...(scope ? { eliza_turn_scope: scope } : {}) },
    { success: true, data: { op: "list", actionName: "GITHUB" } },
  );

function matches(
  fixture: ReturnType<typeof postToolEvaluatorFixture>,
  call: DeterministicModelCall,
): boolean {
  if (typeof fixture.match !== "function")
    throw new Error("expected a matcher function");
  return fixture.match(call);
}

describe("postToolEvaluatorFixture", () => {
  const discovered = postToolEvaluatorFixture({
    actionName: "GITHUB",
    discoverBeforeExecution: true,
    args,
    input,
  });

  it("matches replayed calls that keep the planner's declared turn scope", () => {
    const call = evaluatorCall([
      ...discovery("more_work_pending"),
      ...action(args, "final"),
    ]);
    expect(matches(discovered, call)).toBe(true);
  });

  it("still rejects a replayed call whose executed arguments differ", () => {
    const call = evaluatorCall([
      ...discovery("more_work_pending"),
      ...action({ ...args, state: "closed" }, "final"),
    ]);
    expect(matches(discovered, call)).toBe(false);
  });

  it("matches replayed calls without a declared turn scope", () => {
    expect(
      matches(discovered, evaluatorCall([...discovery(), ...action(args)])),
    ).toBe(true);
    const direct = postToolEvaluatorFixture({
      actionName: "GITHUB",
      args,
      input,
    });
    expect(matches(direct, evaluatorCall(action(args)))).toBe(true);
  });
});

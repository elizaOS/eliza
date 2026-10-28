/** Exercises the sub-agent completion failure marker through the real response-handler evaluator runner. */
import {
  AgentRuntime,
  MESSAGE_SOURCE_SUB_AGENT,
  type Memory,
  type MessageHandlerResult,
  runResponseHandlerEvaluators,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  completionHasFailureMarkerWithoutPositiveEvidence,
  subAgentCompletionResponseEvaluator,
} from "../evaluators/sub-agent-completion.js";

const SUCCESS_TEXT =
  "[sub-agent: fix-parser (claude)]\nFixed the off-by-one in parseRange. Ran `bun test`: the process exited with code 0.";

function completionMessage(runtime: AgentRuntime, text: string): Memory {
  return {
    id: stringToUuid("sub-agent-completion-exit-code"),
    agentId: runtime.agentId,
    entityId: stringToUuid("sub-agent"),
    roomId: stringToUuid("room"),
    createdAt: 1000,
    content: {
      text,
      source: MESSAGE_SOURCE_SUB_AGENT,
      metadata: { subAgent: true, subAgentEvent: "task_complete" },
    },
  };
}

describe("sub-agent completion exit codes", () => {
  it("reads exit code 0 as success and any other exit code as a failure", () => {
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(SUCCESS_TEXT),
    ).toBe(false);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "Ran `bun test`: the process exited with code 1.",
      ),
    ).toBe(true);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "ACP agent exited with code unknown",
      ),
    ).toBe(true);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "The dev server exited with code -1.",
      ),
    ).toBe(true);
    expect(
      completionHasFailureMarkerWithoutPositiveEvidence(
        "Lint exited with code 0, but the tests exited with code 2.",
      ),
    ).toBe(true);
  });

  it("relays a completion that reports exit code 0 to the user", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Exit code relay", bio: [] },
      logLevel: "fatal",
    });
    runtime.registerResponseHandlerEvaluator(
      subAgentCompletionResponseEvaluator,
    );
    const handler: MessageHandlerResult = {
      processMessage: "RESPOND",
      thought: "",
      plan: { contexts: ["general"], requiresTool: false, reply: "" },
    };

    const result = await runResponseHandlerEvaluators({
      runtime,
      message: completionMessage(runtime, SUCCESS_TEXT),
      state: { values: {}, data: {}, text: "" },
      messageHandler: handler,
      availableContexts: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.activeEvaluators).toEqual([
      subAgentCompletionResponseEvaluator.name,
    ]);
    expect(handler.plan.requiresTool).toBe(false);
    expect(handler.plan.candidateActions ?? []).not.toContain(
      "TASKS_SEND_TO_AGENT",
    );
    expect(handler.plan.reply).toContain("Fixed the off-by-one in parseRange.");
  });
});

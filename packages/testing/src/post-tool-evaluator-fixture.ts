/** Matches a declared scenario action's evaluator only after its correlated successful tool receipt. */

import type { JsonValue } from "@elizaos/core";
import {
  activeCommittedEffectReceipts,
  composeToolDiagnosticRedactor,
  ModelType,
  normalizeEffectReceipts,
  projectCompleteToolArgsForModel,
} from "@elizaos/core";
import { matchesScenarioInput } from "./deterministic-action-fixtures.ts";
import type { DeterministicModelFixture } from "./deterministic-model-plugin.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function postToolEvaluatorFixture(spec: {
  actionName: string;
  discoverBeforeExecution?: boolean;
  args: Record<string, JsonValue>;
  input: string;
  messageToUser?: string;
}): DeterministicModelFixture {
  const modelArgs = projectCompleteToolArgsForModel(
    spec.args,
    composeToolDiagnosticRedactor(),
  );
  return {
    name: `evaluate-${spec.actionName}-${spec.input}`,
    match(call) {
      if (
        call.modelType !== ModelType.RESPONSE_HANDLER ||
        call.toolNames.length !== 0
      )
        return false;
      const messages = call.params.messages ?? [];
      if (
        !messages.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("evaluator_stage:\n"),
        )
      )
        return false;
      const inputs = messages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          /(?:^|\n\n)(?:message:user:\n|# Current message\n)/.test(
            message.content,
          ),
      );
      if (
        inputs.length !== 1 ||
        typeof inputs[0].content !== "string" ||
        !matchesScenarioInput(spec.input)(inputs[0].content)
      )
        return false;
      const calls = messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part) => record(part) && part.type === "tool-call");
      // A declared discovery is read-only, but must still have its exact request
      // and correlated successful receipt. All other extra calls are rejected.
      const expectedCount = spec.discoverBeforeExecution ? 2 : 1;
      if (calls.length !== expectedCount) return false;
      const toolCall = calls.at(-1);
      if (!toolCall) return false;
      if (
        toolCall.type !== "tool-call" ||
        toolCall.toolName !== spec.actionName ||
        typeof toolCall.toolCallId !== "string" ||
        canonical(toolCall.input) !== canonical(modelArgs)
      )
        return false;
      const results = messages
        .filter((message) => message.role === "tool")
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part) => record(part) && part.type === "tool-result");
      if (results.length !== expectedCount) return false;
      if (spec.discoverBeforeExecution) {
        const discovery = calls[0];
        const receipt = results[0];
        if (
          discovery.toolName !== "DISCOVER_ACTIONS" ||
          canonical(discovery.input) !==
            canonical({
              names: [spec.actionName],
            }) ||
          receipt.toolName !== "DISCOVER_ACTIONS" ||
          receipt.toolCallId !== discovery.toolCallId ||
          !record(receipt.output) ||
          receipt.output.type !== "text" ||
          typeof receipt.output.value !== "string"
        )
          return false;
        try {
          const value: unknown = JSON.parse(receipt.output.value);
          if (!record(value) || value.success !== true) return false;
        } catch {
          // error-policy:J3 A malformed discovery receipt cannot authorize completion.
          return false;
        }
      }
      const result = results.at(-1);
      if (!result) return false;
      if (
        result.type !== "tool-result" ||
        result.toolCallId !== toolCall.toolCallId ||
        result.toolName !== spec.actionName ||
        !record(result.output) ||
        result.output.type !== "text" ||
        typeof result.output.value !== "string"
      )
        return false;
      try {
        const receipt: unknown = JSON.parse(result.output.value);
        return record(receipt) && receipt.success === true;
      } catch {
        // error-policy:J3 Malformed receipts cannot authorize a successful evaluation.
        return false;
      }
    },
    response(call) {
      const resultPart = (call.params.messages ?? [])
        .filter((message) => message.role === "tool")
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (part) =>
            part.type === "tool-result" && part.toolName === spec.actionName,
        );
      if (
        resultPart?.type !== "tool-result" ||
        !record(resultPart.output) ||
        resultPart.output.type !== "text" ||
        typeof resultPart.output.value !== "string"
      ) {
        throw new Error("Matched tool receipt is missing");
      }
      const result: unknown = JSON.parse(resultPart.output.value);
      if (!record(result))
        throw new Error("Matched tool receipt is not an object");
      const effects = normalizeEffectReceipts(result.effectReceipts);
      const messageToUser =
        result.verifiedUserFacing === true &&
        typeof result.userFacingText === "string"
          ? result.userFacingText
          : spec.messageToUser;
      return {
        thought:
          "The declared action completed with a correlated successful receipt.",
        success: true,
        decision: "FINISH",
        ...(messageToUser
          ? {
              messageToUser,
              effectReceiptIds: activeCommittedEffectReceipts(effects).map(
                (receipt) => receipt.receiptId,
              ),
            }
          : {}),
      };
    },
    times: 1,
  };
}

/**
 * Supplies deterministic routing and completion-model responses for LifeOps
 * scenarios while leaving actions, persistence, and delivery assertions real.
 * Completion fixtures bind the current user request and action result, and
 * report failure when the real action fails instead of inventing success.
 */
import {
  type DeterministicModelCall,
  matchesScenarioInput,
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
} from "@elizaos/core/testing";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionResult(call: DeterministicModelCall, actionName: string) {
  for (const message of call.params.messages ?? []) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        !isRecord(part) ||
        part.type !== "tool-result" ||
        part.toolName !== actionName
      )
        continue;
      if (
        !isRecord(part.output) ||
        part.output.type !== "text" ||
        typeof part.output.value !== "string"
      )
        continue;
      const result: unknown = JSON.parse(part.output.value);
      if (isRecord(result)) return result;
    }
  }
  return null;
}

export function registerLifeOpsActionFixtures(
  runtime: RuntimeWithScenarioModelFixtures,
  specs: readonly StrictActionRouteFixture[],
): void {
  registerStrictActionRouteFixtures(
    runtime,
    specs.map((spec) => ({ ...spec, messageToUser: "I will check that." })),
  );
  runtime.scenarioModelFixtures?.register(
    ...specs.map((spec) => ({
      name: `lifeops-completion-${spec.actionName}-${spec.input}`,
      times: 1,
      match: (call: DeterministicModelCall) =>
        call.modelType === "RESPONSE_HANDLER" &&
        call.toolNames.length === 0 &&
        (call.params.messages ?? []).some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("evaluator_stage:"),
        ) &&
        (call.params.messages ?? []).some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            matchesScenarioInput(spec.input)(message.content),
        ) &&
        actionResult(call, spec.actionName) !== null,
      response: (call: DeterministicModelCall) => {
        const result = actionResult(call, spec.actionName);
        if (!result || typeof result.success !== "boolean") {
          throw new Error(
            `Missing real ${spec.actionName} result for completion fixture`,
          );
        }
        const text = result.userFacingText ?? result.text;
        if (typeof text !== "string")
          throw new Error("Action result has no completion text");
        const receiptIds = Array.isArray(result.effectReceipts)
          ? result.effectReceipts.flatMap((receipt) =>
              isRecord(receipt) &&
              receipt.outcome === "applied" &&
              typeof receipt.receiptId === "string"
                ? [receipt.receiptId]
                : [],
            )
          : [];
        return {
          thought:
            "Report the real action result; scenario assertions verify its durable effects.",
          decision: "FINISH",
          success: result.success,
          messageToUser: text,
          effectReceiptIds: receiptIds,
        };
      },
    })),
  );
}

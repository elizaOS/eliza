/**
 * Live-lane proof that a real model routes an on-chain research request through
 * the real Aomi service and returns Aomi's public backend response.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function assertAomiCompleted(
  execution: ScenarioTurnExecution,
): string | undefined {
  const call = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "AOMI",
  );
  if (!call) {
    return `expected AOMI, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "no actions"}`;
  }
  if (call.result?.success !== true) {
    return `expected successful AOMI result, saw ${JSON.stringify(call.result)}`;
  }
  const status =
    call.result.data && typeof call.result.data === "object"
      ? Reflect.get(call.result.data, "status")
      : undefined;
  if (status !== "completed") {
    return `expected completed Aomi boundary, saw ${JSON.stringify(call.result.data)}`;
  }
  return undefined;
}

export default scenario({
  id: "aomi-live-read",
  lane: "live-only",
  title: "Real LLM delegates public on-chain research to Aomi",
  domain: "aomi",
  tags: ["live", "real-llm", "aomi", "onchain"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-aomi"],
  },
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Aomi Live Read",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delegate a walletless research request",
      room: "main",
      text: "Use Aomi to explain in one concise sentence what on-chain tasks Aomi can perform. Do not create, sign, or request any transaction.",
      expectedActions: ["AOMI"],
      assertTurn: assertAomiCompleted,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "AOMI",
      status: "success",
      minCount: 1,
    },
  ],
});

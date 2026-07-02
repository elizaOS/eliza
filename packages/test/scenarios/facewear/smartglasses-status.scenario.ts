/**
 * Keyless per-plugin e2e for `@elizaos/plugin-facewear` (issue #8801).
 *
 * Exercises the SMARTGLASSES_STATUS action end-to-end with no device hardware,
 * BLE transport, or credentials. The SmartglassesService loads in
 * offline/mockable mode (no transport available in a headless Node test), and
 * the action reads its local status snapshot and reports it — a fully
 * deterministic local read, no external API and no model call inside the
 * handler.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { describeCalls, toRecord } from "../_helpers/effect-assertions.ts";

const SMARTGLASSES_STATUS = "SMARTGLASSES_STATUS";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "facewear.smartglasses-status",
  title: "Facewear: report smartglasses status with no device connected",
  domain: "facewear",
  tags: ["smoke", "facewear", "smartglasses", "hardware"],
  description:
    "Reports Even Realities smartglasses status through the SMARTGLASSES_STATUS action — keyless, no BLE transport or device hardware; the service runs in offline mode.",

  requires: { plugins: ["@elizaos/plugin-facewear"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "facewear-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        runtime.scenarioLlmFixtures?.register(
          {
            name: "facewear-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.toLowerCase().includes("smartglasses"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["smartglasses"],
              intents: ["smartglasses-status"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [SMARTGLASSES_STATUS],
            },
            times: 1,
          },
          {
            name: "facewear-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.toLowerCase().includes("smartglasses"),
              toolName: SMARTGLASSES_STATUS,
            },
            response: {
              text: "",
              thought: "Report the current smartglasses status.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-smartglasses-status",
                  name: SMARTGLASSES_STATUS,
                  type: "function",
                  arguments: {},
                },
              ],
            },
            times: 1,
          },
          {
            name: "facewear-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought:
                "Smartglasses status reported; no device is connected, nothing more to do.",
              messageToUser:
                "No smartglasses are connected — the service is in offline mode.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Facewear",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "status",
      text: "What is the status of my smartglasses?",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === SMARTGLASSES_STATUS,
        );
        if (!call) {
          return `Expected ${SMARTGLASSES_STATUS} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${SMARTGLASSES_STATUS} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: SMARTGLASSES_STATUS,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the action really read the live
      // SmartglassesService status snapshot — in a headless test that
      // snapshot must report no connected device, and the counters the
      // service tracks must be present in the result values.
      type: "custom",
      name: "smartglasses-status-snapshot-effect",
      predicate: (ctx) => {
        const call = ctx.actionsCalled.find(
          (action) =>
            action.actionName === SMARTGLASSES_STATUS &&
            action.result?.success === true,
        );
        const values = toRecord(call?.result?.values);
        if (!values) {
          return `no successful ${SMARTGLASSES_STATUS} result values; calls: ${describeCalls(ctx)}`;
        }
        if (values.connected !== false) {
          return `headless run has no BLE device, so status.connected must be false; saw ${JSON.stringify(values.connected ?? null)}`;
        }
        if (typeof values.audioChunksReceived !== "number") {
          return `expected the service's audioChunksReceived counter in result values, saw ${JSON.stringify(values.audioChunksReceived ?? null)}`;
        }
        if (!toRecord(values.setup)) {
          return `expected the derived setup summary in result values, saw ${JSON.stringify(values.setup ?? null)}`;
        }
      },
    },
  ],
});

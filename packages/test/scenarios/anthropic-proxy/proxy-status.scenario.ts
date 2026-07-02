import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const PROXY_STATUS = "PROXY_STATUS";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};
export default scenario({
  lane: "pr-deterministic",
  id: "anthropic-proxy.proxy-status",
  title: "Anthropic proxy: PROXY_STATUS reports status",
  domain: "anthropic-proxy",
  tags: ["smoke", "anthropic-proxy"],
  description: "Keyless PROXY_STATUS status report.",
  requires: { plugins: ["@elizaos/plugin-anthropic-proxy"] },
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "fx",
      apply: async (ctx) => {
        (ctx.runtime as R).scenarioLlmFixtures?.register(
          {
            name: "p1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("proxy status"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["general"],
              intents: ["status"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [PROXY_STATUS],
            },
            times: 1,
          },
          {
            name: "p2",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("proxy status"),
              toolName: PROXY_STATUS,
            },
            response: {
              text: "",
              thought: "status",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "c",
                  name: PROXY_STATUS,
                  type: "function",
                  arguments: {},
                },
              ],
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Proxy" },
  ],
  turns: [
    {
      kind: "message",
      name: "t",
      text: "What's the anthropic proxy status?",
      timeoutMs: 120000,
      assertTurn: (turn) => {
        const c = turn.actionsCalled.find((a) => a.actionName === PROXY_STATUS);
        if (!c)
          return `Expected ${PROXY_STATUS} but got: ${turn.actionsCalled.map((a) => a.actionName).join(", ")}`;
        if (!c.result?.success)
          return `${PROXY_STATUS} did not succeed: ${c.error?.message ?? c.result?.text ?? "unknown"}`;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: PROXY_STATUS,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): success only means the handler ran; the
      // status contract is `values` carrying the live service's report —
      // available:true plus the mode/listening fields read from
      // AnthropicProxyService.getStatus(). A missing service or an empty
      // status envelope fails here.
      type: "custom",
      name: "proxy-status-reports-live-service-state",
      predicate: (ctx) => {
        const call = successfulCalls(ctx, PROXY_STATUS)[0];
        const values = toRecord(call?.result?.values);
        if (!values) {
          return `no ${PROXY_STATUS} result values; calls: ${describeCalls(ctx)}`;
        }
        if (values.available !== true) {
          return `expected values.available true (service loaded), saw ${JSON.stringify(values).slice(0, 200)}`;
        }
        if (
          typeof values.mode !== "string" ||
          typeof values.listening !== "boolean"
        ) {
          return `expected live status fields {mode:string, listening:boolean}, saw ${JSON.stringify(values).slice(0, 200)}`;
        }
      },
    },
  ],
});

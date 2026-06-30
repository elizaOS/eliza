import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

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
  ],
});

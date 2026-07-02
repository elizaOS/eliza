/**
 * Keyless per-plugin e2e for `@elizaos/plugin-agent-orchestrator` (issue #8801).
 *
 * Exercises the orchestrator TASKS surface end-to-end through its `list_agents`
 * read operation. `list_agents` only reads the local ACP session store (no
 * external CLI, no live coding sub-agent, no credentials): with an empty store
 * the action reports "no active task agents" and succeeds — fully deterministic
 * under the strict LLM proxy.
 *
 * The plugin loads its real ACP service on a direct build with an executable
 * shell (the default on a Linux dev host), so the TASKS parent action is
 * registered and routes `action: "list_agents"` to `runListAgents`.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const TASKS = "TASKS";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "agent-orchestrator.list-agents",
  title: "Agent orchestrator: list active coding sub-agents",
  domain: "agent-orchestrator",
  tags: ["smoke", "agent-orchestrator", "coding"],
  description:
    "Lists active coding sub-agents through the orchestrator TASKS action against an empty ACP session store — keyless, no live sub-agent or CLI.",

  requires: { plugins: ["@elizaos/plugin-agent-orchestrator"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "orchestrator-list-agents-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        runtime.scenarioLlmFixtures?.register(
          {
            name: "orchestrator-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("coding agents"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["code"],
              intents: ["coding"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [TASKS],
            },
            times: 1,
          },
          {
            name: "orchestrator-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("coding agents"),
              toolName: TASKS,
            },
            response: {
              text: "",
              thought: "List the active coding sub-agents.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-tasks",
                  name: TASKS,
                  type: "function",
                  arguments: { action: "list_agents" },
                },
              ],
            },
            times: 1,
          },
          {
            // After TASKS returns, the runtime makes a final RESPONSE_HANDLER
            // (no HANDLE_RESPONSE tool) to decide FINISH/CONTINUE; an empty
            // agent list is terminal, so FINISH.
            name: "orchestrator-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "No active task agents; nothing more to do.",
              messageToUser: "There are no active coding sub-agents right now.",
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
      title: "Orchestrator",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "list-agents",
      text: "List the active coding agents.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === TASKS);
        if (!call) {
          return `Expected ${TASKS} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${TASKS} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: TASKS,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): list_agents really read the ACP session
      // store — a fresh runtime must surface an empty sessions array in the
      // result payload, not just handler success.
      type: "custom",
      name: "acp-session-store-read-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, TASKS);
        if (!data) {
          return `no successful ${TASKS} result data; calls: ${describeCalls(ctx)}`;
        }
        if (!Array.isArray(data.sessions)) {
          return `expected result.data.sessions array from the ACP session store, saw ${JSON.stringify(data.sessions ?? null)}`;
        }
        if (data.sessions.length !== 0) {
          return `fresh ACP session store must be empty; saw ${data.sessions.length} session(s)`;
        }
      },
    },
  ],
});

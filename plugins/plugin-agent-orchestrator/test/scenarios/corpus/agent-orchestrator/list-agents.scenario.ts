/**
 * Keyless per-plugin e2e for `@elizaos/plugin-agent-orchestrator` (issue #8801).
 *
 * Exercises the orchestrator TASKS surface end-to-end through its `list_agents`
 * read operation. `list_agents` only reads the local ACP session store (no
 * external CLI, no live coding sub-agent, no credentials): with an empty store
 * the action reports "no active task agents" and succeeds — fully deterministic
 * under the strict deterministic model provider.
 *
 * The plugin loads its real ACP service on a direct build with an executable
 * shell (the default on a Linux dev host), so the TASKS parent action is
 * registered and routes `action: "list_agents"` to `runListAgents`.
 */
import {
  describeCalls,
  successfulActionData,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const TASKS = "TASKS";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "orchestrator-list-agents-stage1",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: "List the active coding agents." },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          text: '{"contexts":["code"],"intents":["coding"],"replyText":"","threadOps":[],"candidateActionNames":["TASKS"]}',
        },
      },
      {
        name: "orchestrator-list-agents-planner",
        match: {
          modelType: "ACTION_PLANNER",
          input: { includes: "List the active coding agents." },
          toolNames: [
            "TASKS",
            "TASKS_CREATE",
            "TASKS_SPAWN_AGENT",
            "TASKS_SEND",
            "TASKS_STOP_AGENT",
            "TASKS_LIST_AGENTS",
            "TASKS_CANCEL",
            "TASKS_HISTORY",
            "TASKS_CONTROL",
            "TASKS_SHARE",
            "TASKS_PROVISION_WORKSPACE",
            "TASKS_SUBMIT_WORKSPACE",
            "TASKS_MANAGE_ISSUES",
            "TASKS_ARCHIVE",
            "TASKS_REOPEN",
            "REPLY",
            "IGNORE",
            "STOP",
          ],
        },
        response: {
          text: '{"text":"","thought":"List the active coding sub-agents.","messageToUser":"","completed":true,"finishReason":"tool-calls","toolCalls":[{"id":"call-tasks","name":"TASKS","type":"function","arguments":{"action":"list_agents"}}]}',
        },
      },
      {
        name: "orchestrator-list-agents-terminal-decision",
        match: {
          modelType: "RESPONSE_HANDLER",
          toolNames: [],
        },
        response: {
          text: '{"success":true,"decision":"FINISH","thought":"No active task agents; nothing more to do.","messageToUser":"There are no active coding sub-agents right now."}',
        },
      },
      {
        name: "orchestrator-list-agents-post-turn-evaluator",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "# Task: Post-turn evaluation" },
          toolNames: [],
        },
        response: { text: "{}" },
      },
    ],
  },
  id: "agent-orchestrator.list-agents",
  title: "Agent orchestrator: list active coding sub-agents",
  domain: "agent-orchestrator",
  tags: ["smoke", "agent-orchestrator", "coding"],
  description:
    "Lists active coding sub-agents through the orchestrator TASKS action against an empty ACP session store — keyless, no live sub-agent or CLI.",

  requires: { plugins: ["@elizaos/plugin-agent-orchestrator"] },
  isolation: "per-scenario",

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

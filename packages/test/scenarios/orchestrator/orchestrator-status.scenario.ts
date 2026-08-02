/**
 * Keyless per-plugin e2e for `@elizaos/plugin-task-coordinator` (issue #8801).
 *
 * The task-coordinator plugin's only agent-action surface is the view-scoped
 * `/orchestrator-status` slash command (`ORCHESTRATOR_STATUS_COMMAND`, #8790),
 * which the e2e-coverage gate flagged as having no keyless scenario. This drives
 * that command end-to-end through the deterministic LLM proxy with zero
 * credentials: the seed registers the universal slash command (exactly as a
 * live runtime does when the orchestrator view mounts), the routing fixtures
 * force action selection, and the action's own deterministic, no-LLM handler
 * returns the fixed status reply.
 *
 * Beyond the command contract, the scenario also proves REAL orchestrator
 * state over the REAL HTTP surface: it boots `@elizaos/plugin-agent-orchestrator`
 * alongside, mounts that plugin's route plugin onto the runtime, and reads
 * `/api/orchestrator/status` + `/api/orchestrator/tasks` through the scenario
 * API server — a genuine empty-store read (0 tasks, all status counts 0), not
 * a canned string.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { useRuntime } from "@elizaos/plugin-commands";
import { scenario } from "@elizaos/scenario-runner/schema";
import { codingAgentRoutePlugin } from "../../../../plugins/plugin-agent-orchestrator/src/setup-routes.ts";
import {
  ORCHESTRATOR_STATUS_COMMAND_ACTION,
  registerOrchestratorCommands,
} from "../../../../plugins/plugin-task-coordinator/src/orchestrator-command.ts";

const COMMAND_TEXT = "/orchestrator-status";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function statusRouteFixtures(): Array<Record<string, unknown>> {
  const inputMatches = (value: string) => value.includes(COMMAND_TEXT);
  return [
    {
      name: "route-orchestrator-status-stage1",
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: inputMatches,
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: ["general"],
        intents: ["command"],
        replyText: "",
        threadOps: [],
        candidateActionNames: [ORCHESTRATOR_STATUS_COMMAND_ACTION],
      },
      times: 1,
    },
    {
      name: "route-orchestrator-status-planner",
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: inputMatches,
        toolName: ORCHESTRATOR_STATUS_COMMAND_ACTION,
      },
      response: {
        text: "",
        thought:
          "Dispatch the deterministic orchestrator-status slash command.",
        messageToUser: "Here's the orchestrator status.",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-orchestrator-status",
            name: ORCHESTRATOR_STATUS_COMMAND_ACTION,
            type: "function",
            arguments: {},
          },
        ],
      },
      times: 1,
    },
  ];
}

export default scenario({
  lane: "pr-deterministic",
  id: "task-coordinator.orchestrator-status",
  title: "Task-coordinator slash command routes to ORCHESTRATOR_STATUS_COMMAND",
  domain: "task-coordinator",
  tags: ["smoke", "task-coordinator", "slash-command"],
  description:
    "Sends /orchestrator-status and verifies the deterministic ORCHESTRATOR_STATUS_COMMAND action is selected and succeeds with the fixed status reply — keyless, no credentials.",

  requires: {
    plugins: [
      "@elizaos/plugin-task-coordinator",
      "@elizaos/plugin-agent-orchestrator",
    ],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-orchestrator-command",
      apply: async (ctx) => {
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        // Register the view-scoped universal slash command, exactly as a live
        // runtime does when the orchestrator view mounts, so validate() resolves.
        useRuntime(runtime.agentId);
        registerOrchestratorCommands(runtime.agentId);
        // Mount the orchestrator's real route plugin onto the runtime so the
        // scenario API server serves /api/orchestrator/* exactly as an
        // app-core host would (the host normally drains the route-plugin
        // registry; the scenario runtime does not, so mount it explicitly).
        for (const route of codingAgentRoutePlugin.routes ?? []) {
          runtime.routes.push(route);
        }
        runtime.scenarioLlmFixtures?.register(...statusRouteFixtures());
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Task-coordinator: orchestrator status",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "orchestrator-status-command",
      text: COMMAND_TEXT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === ORCHESTRATOR_STATUS_COMMAND_ACTION,
        );
        if (!call) {
          return `Expected ${ORCHESTRATOR_STATUS_COMMAND_ACTION} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${ORCHESTRATOR_STATUS_COMMAND_ACTION} did not succeed: ${
            call.error?.message ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_STATUS_COMMAND_ACTION,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the slash command's deterministic handler
      // really produced its contractual status reply — the action's entire
      // observable behavior — not merely success=true.
      type: "custom",
      name: "orchestrator-status-reply-effect",
      predicate: (ctx) => {
        const call = ctx.actionsCalled.find(
          (action) =>
            action.actionName === ORCHESTRATOR_STATUS_COMMAND_ACTION &&
            action.result?.success === true,
        );
        if (!call) {
          return `no successful ${ORCHESTRATOR_STATUS_COMMAND_ACTION} call captured`;
        }
        if (call.result?.text !== "Orchestrator is online.") {
          return `expected the command's fixed status reply "Orchestrator is online." in result.text, saw ${JSON.stringify(call.result?.text ?? null)}`;
        }
      },
    },
    {
      // Real-state proof: the booted orchestrator's durable store is read over
      // the real HTTP surface. A fresh runtime must report zero tasks and
      // all-zero status counts — actual state, not the command's canned string.
      type: "custom",
      name: "orchestrator-real-state-over-http",
      predicate: async (ctx) => {
        const base = (ctx as { apiBaseUrl?: string }).apiBaseUrl;
        if (!base) {
          return "scenario context has no apiBaseUrl (scenario API server missing)";
        }
        const tasksRes = await fetch(`${base}/api/orchestrator/tasks`);
        if (!tasksRes.ok) {
          return `GET /api/orchestrator/tasks → ${tasksRes.status}: ${await tasksRes.text()}`;
        }
        const tasksBody = (await tasksRes.json()) as { tasks?: unknown };
        if (!Array.isArray(tasksBody.tasks)) {
          return `expected a tasks array from the orchestrator store, saw ${JSON.stringify(tasksBody).slice(0, 300)}`;
        }
        if (tasksBody.tasks.length !== 0) {
          return `fresh orchestrator store must have 0 tasks; saw ${tasksBody.tasks.length}`;
        }
        const statusRes = await fetch(`${base}/api/orchestrator/status`);
        if (!statusRes.ok) {
          return `GET /api/orchestrator/status → ${statusRes.status}: ${await statusRes.text()}`;
        }
        const status = (await statusRes.json()) as {
          byStatus?: Record<string, number>;
        };
        if (!status.byStatus || typeof status.byStatus !== "object") {
          return `expected byStatus counts in orchestrator status, saw ${JSON.stringify(status).slice(0, 300)}`;
        }
        const nonZero = Object.entries(status.byStatus).filter(
          ([, count]) => count !== 0,
        );
        if (nonZero.length > 0) {
          return `fresh orchestrator status must report all-zero counts; saw ${JSON.stringify(Object.fromEntries(nonZero))}`;
        }
      },
    },
  ],
});

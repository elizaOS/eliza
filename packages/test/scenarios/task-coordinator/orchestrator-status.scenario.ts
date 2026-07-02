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
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { useRuntime } from "@elizaos/plugin-commands";
import { scenario } from "@elizaos/scenario-runner/schema";
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
        messageToUser: "",
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
    plugins: ["@elizaos/plugin-task-coordinator"],
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
  ],
});

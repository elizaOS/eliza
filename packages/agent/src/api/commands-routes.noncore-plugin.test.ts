/**
 * Non-core plugin command contract (#8790).
 *
 * Proves the universal slash-command contract end to end with the
 * task-coordinator plugin's real server-side command contribution:
 *
 *   1. The plugin init registers a view-scoped slash command into the
 *      per-runtime `@elizaos/plugin-commands` registry (the standard
 *      command-registration API).
 *   2. That command is served by `GET /api/commands` — but only while the
 *      command's view (`orchestrator`) is the active surface (#8798).
 *   3. The command dispatches to the plugin's own deterministic handler action
 *      when the matching slash message arrives.
 *
 * This is the same register → catalog → dispatch path the built-in commands and
 * the connector bridges use, exercised from a non-core contributor.
 */

import type {
  Action,
  Content,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { initForRuntime } from "@elizaos/plugin-commands";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATOR_STATUS_COMMAND_ACTION,
  ORCHESTRATOR_STATUS_COMMAND_KEY,
  orchestratorStatusCommandAction,
  registerOrchestratorCommands,
} from "../../../../plugins/plugin-task-coordinator/src/orchestrator-command.ts";

import { handleCommandsRoutes } from "./commands-routes.ts";

const AGENT_ID = "task-coordinator-command-agent";
const res = {} as never;

interface ServedCommand {
  key: string;
  target: { kind: string; action?: string };
  views?: string[];
}

interface ServedPayload {
  commands: ServedCommand[];
  activeViewId: string | null;
  agentId: string | null;
}

const taskCoordinatorPlugin: Plugin = {
  name: "@elizaos/plugin-task-coordinator",
  description: "Task coordinator command contract fixture",
  init: async (_config, runtime) => {
    registerOrchestratorCommands(runtime.agentId);
  },
  actions: [orchestratorStatusCommandAction],
};

/** Drive the real route handler and return the served catalog payload. */
async function fetchCatalog(query: string): Promise<ServedPayload> {
  const json = vi.fn();
  const error = vi.fn();
  const handled = await handleCommandsRoutes({
    req: {} as never,
    res,
    method: "GET",
    pathname: "/api/commands",
    url: new URL(`http://localhost/api/commands${query}`),
    json,
    error,
    runtime: { agentId: AGENT_ID } as never,
  });
  expect(handled).toBe(true);
  expect(error).not.toHaveBeenCalled();
  return json.mock.calls[0][1] as ServedPayload;
}

beforeAll(async () => {
  // `@elizaos/plugin-commands` boots before app plugins and seeds the runtime's
  // command store; mirror that ordering here, then run the plugin's init().
  initForRuntime(AGENT_ID);
  await taskCoordinatorPlugin.init?.({}, {
    agentId: AGENT_ID,
  } as unknown as IAgentRuntime);
});

describe("@elizaos/plugin-task-coordinator command contract", () => {
  it("registers the handler action on the plugin surface", () => {
    const action = taskCoordinatorPlugin.actions?.find(
      (a) => a.name === ORCHESTRATOR_STATUS_COMMAND_ACTION,
    );
    expect(action).toBe(orchestratorStatusCommandAction);
  });

  it("serves the registered command from GET /api/commands when its view is active", async () => {
    const payload = await fetchCatalog("?surface=gui&view=orchestrator");
    expect(payload.agentId).toBe(AGENT_ID);
    expect(payload.activeViewId).toBe("orchestrator");

    const command = payload.commands.find(
      (c) => c.key === ORCHESTRATOR_STATUS_COMMAND_KEY,
    );
    expect(command).toBeDefined();
    expect(command?.views).toEqual(["orchestrator"]);
    expect(command?.target).toMatchObject({
      kind: "agent",
      action: ORCHESTRATOR_STATUS_COMMAND_ACTION,
    });
  });

  it("hides the view-scoped command when its view is not active (#8798)", async () => {
    const payload = await fetchCatalog("?surface=gui");
    const keys = new Set(payload.commands.map((c) => c.key));
    expect(keys.has(ORCHESTRATOR_STATUS_COMMAND_KEY)).toBe(false);
  });

  it("dispatches the matching slash message to the plugin's handler", async () => {
    const action: Action = orchestratorStatusCommandAction;
    const runtime = createMockRuntime({ agentId: AGENT_ID });
    const message = {
      entityId: "user-1",
      roomId: "room-1",
      content: { text: "/orchestrator-status", source: "gui" },
    } as unknown as Memory;

    expect(await action.validate(runtime, message, undefined)).toBe(true);

    const callback = vi.fn(async (_content: Content) => [] as Memory[]);
    const result = await action.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback,
    );
    expect(result).toMatchObject({ success: true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      text: "Orchestrator is online.",
      source: "command",
    });
  });

  it("does not intercept conversational text", async () => {
    const action: Action = orchestratorStatusCommandAction;
    const runtime = createMockRuntime({ agentId: AGENT_ID });
    const message = {
      entityId: "user-1",
      roomId: "room-1",
      content: { text: "what is the orchestrator status?", source: "gui" },
    } as unknown as Memory;
    expect(await action.validate(runtime, message, undefined)).toBe(false);
  });
});

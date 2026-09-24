/**
 * Verifies the lifecycle-only TASKS wrapper against the shared cross-harness
 * schema and core ActionResult ledger without executing production side effects.
 */
import {
  type Action,
  type ActionResult,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  LIFECYCLE_TASK_CONTEXTS,
  LIFECYCLE_TASKS_TOOL_CONTRACT,
  lifecycleCaptureOnlyPlugin,
  lifecycleCaptureOnlyTasksAction,
  projectLifecycleTaskExecutions,
  retainOnlyLifecycleTaskAction,
  runWithLifecycleTaskCapture,
} from "./lifecycle-task-action";

function baseTasksAction(
  handler = vi.fn(async () => ({ success: true })),
): Action {
  return {
    name: "TASKS",
    description: "Production task action.",
    contexts: ["code"],
    similes: ["SPAWN_AGENT"],
    examples: [],
    subActions: ["TASKS_SPAWN_AGENT"],
    suppressPostActionContinuation: true,
    suppressEarlyReply: true,
    validate: async () => false,
    handler,
  };
}

function benchmarkMessage(category: string): Memory {
  return {
    id: stringToUuid("00000000-0000-0000-0000-000000000001"),
    agentId: stringToUuid("00000000-0000-0000-0000-000000000002"),
    entityId: stringToUuid("00000000-0000-0000-0000-000000000003"),
    roomId: stringToUuid("00000000-0000-0000-0000-000000000004"),
    content: {
      text: `Lifecycle canary for ${category}`,
      source: "benchmark",
      metadata: { benchmark: "orchestrator_lifecycle", category },
    },
  };
}

describe("lifecycle capture-only TASKS action", () => {
  it("constructs a minimal plugin without production lifecycle services", () => {
    const productionHandler = vi.fn(async () => ({ success: true }));
    const sourcePlugin = {
      name: "@elizaos/plugin-agent-orchestrator",
      description: "Production orchestrator.",
      actions: [baseTasksAction(productionHandler)],
      providers: [{ name: "PRODUCTION_PROVIDER", get: vi.fn() }],
      services: [class ProductionService {}],
      routes: [{ name: "production-route", path: "/production" }],
      events: { MESSAGE_RECEIVED: [vi.fn()] },
      init: vi.fn(),
      dependencies: ["production-dependency"],
    } as never;

    const plugin = lifecycleCaptureOnlyPlugin(sourcePlugin);

    expect(Object.keys(plugin).sort()).toEqual([
      "actions",
      "description",
      "name",
    ]);
    expect(plugin.actions).toHaveLength(1);
    expect(plugin.actions?.[0]?.name).toBe("TASKS");
    expect(productionHandler).not.toHaveBeenCalled();
  });

  it("prunes only planner actions through the runtime's public registry API", () => {
    const runtime = {
      actions: [{ name: "REPLY" }, baseTasksAction(), { name: "POST" }],
      unregisterAction(name: string): boolean {
        const index = this.actions.findIndex((action) => action.name === name);
        if (index < 0) return false;
        this.actions.splice(index, 1);
        return true;
      },
    };

    retainOnlyLifecycleTaskAction(runtime as never);

    expect(runtime.actions.map((action) => action.name)).toEqual(["TASKS"]);
  });

  it("matches the shared schema and strips the production action surface", () => {
    const action = lifecycleCaptureOnlyTasksAction(baseTasksAction());
    const properties = Object.fromEntries(
      (action.parameters ?? []).map((parameter) => [
        parameter.name,
        {
          ...parameter.schema,
          description: parameter.description,
        },
      ]),
    );
    const required = (action.parameters ?? [])
      .filter((parameter) => parameter.required)
      .map((parameter) => parameter.name);

    expect(action.name).toBe("TASKS");
    expect(action.description).toBe(
      LIFECYCLE_TASKS_TOOL_CONTRACT.function.description,
    );
    expect({
      type: "object",
      properties,
      required,
      additionalProperties: action.allowAdditionalParameters ?? false,
    }).toEqual(LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters);
    expect(action.contexts).toEqual(LIFECYCLE_TASK_CONTEXTS);
    expect(action.contextGate).toEqual({});
    expect(action.roleGate).toEqual({ minRole: "NONE" });
    expect(action.similes).toEqual([]);
    expect(action.examples).toEqual([]);
    expect(action.subActions).toEqual([]);
    expect(action.subPlanner).toBe(false);
    expect(action.suppressPostActionContinuation).toBe(false);
    expect(action.suppressEarlyReply).toBe(false);
  });

  it.each([
    "clarification",
    "status",
    "scope",
    "interrupt",
    "completion_summary",
  ])("is planner-available for the %s scenario category", async (category) => {
    const action = lifecycleCaptureOnlyTasksAction(baseTasksAction());
    await expect(
      action.validate(
        {} as never,
        benchmarkMessage(category),
        undefined,
        undefined,
      ),
    ).resolves.toBe(true);
  });

  it("captures two executions in order without calling the production handler", async () => {
    const productionHandler = vi.fn(async () => ({ success: true }));
    const action = lifecycleCaptureOnlyTasksAction(
      baseTasksAction(productionHandler),
    );
    const turn = await runWithLifecycleTaskCapture(async () => {
      const first = await action.handler(
        {} as never,
        benchmarkMessage("delegation"),
        undefined,
        { parameters: { action: "spawn_agent", task: "fix tests" } },
      );
      const second = await action.handler(
        {} as never,
        benchmarkMessage("status"),
        undefined,
        { parameters: { action: "list_agents" } },
      );
      return [first, second];
    });

    expect(productionHandler).not.toHaveBeenCalled();
    expect(turn.executions).toEqual([
      {
        arguments: { action: "spawn_agent", task: "fix tests" },
        result: {
          captured: true,
          effect: "not_executed",
          sequence: 0,
          tool: "TASKS",
        },
      },
      {
        arguments: { action: "list_agents" },
        result: {
          captured: true,
          effect: "not_executed",
          sequence: 1,
          tool: "TASKS",
        },
      },
    ]);
    expect(turn.result.map((result) => result?.text)).toEqual(
      turn.executions.map((execution) => JSON.stringify(execution.result)),
    );

    const actionResults: ActionResult[] = turn.executions.map((execution) => ({
      success: true,
      data: {
        actionName: "TASKS",
        benchmarkCapture: execution.result,
      },
    }));
    const projection = projectLifecycleTaskExecutions(
      turn.executions,
      actionResults,
    );
    expect(projection.actions).toEqual(["TASKS", "TASKS"]);
    expect(projection.toolCalls).toEqual([
      {
        id: "call_lifecycle_0",
        name: "TASKS",
        arguments: { action: "spawn_agent", task: "fix tests" },
      },
      {
        id: "call_lifecycle_1",
        name: "TASKS",
        arguments: { action: "list_agents" },
      },
    ]);
    expect(projection.params.lifecycle_results).toEqual([
      {
        name: "TASKS",
        arguments: { action: "spawn_agent", task: "fix tests" },
        result: {
          captured: true,
          effect: "not_executed",
          sequence: 0,
          tool: "TASKS",
        },
      },
      {
        name: "TASKS",
        arguments: { action: "list_agents" },
        result: {
          captured: true,
          effect: "not_executed",
          sequence: 1,
          tool: "TASKS",
        },
      },
    ]);
  });

  it("fails closed when core's action ledger does not match capture", () => {
    expect(() =>
      projectLifecycleTaskExecutions(
        [
          {
            arguments: { action: "cancel" },
            result: {
              captured: true,
              effect: "not_executed",
              sequence: 0,
              tool: "TASKS",
            },
          },
        ],
        [],
      ),
    ).toThrow("capture/action-result count mismatch");
  });

  it.each([
    ["non-object parameters", { parameters: "spawn_agent" }],
    ["missing action", { parameters: { task: "inspect benchmark" } }],
    ["unknown action", { parameters: { action: "delete" } }],
    ["wrong field type", { parameters: { action: "cancel", all: "yes" } }],
    ["extra field", { parameters: { action: "cancel", unsupported: "value" } }],
  ])("rejects %s before appending a capture", async (_label, options) => {
    const action = lifecycleCaptureOnlyTasksAction(baseTasksAction());
    const turn = await runWithLifecycleTaskCapture(async () => {
      await expect(
        action.handler(
          {} as never,
          benchmarkMessage("invalid"),
          undefined,
          options as never,
        ),
      ).rejects.toMatchObject({
        code: "BENCHMARK_LIFECYCLE_TASKS_ARGUMENTS_INVALID",
      });
    });

    expect(turn.executions).toEqual([]);
  });
});

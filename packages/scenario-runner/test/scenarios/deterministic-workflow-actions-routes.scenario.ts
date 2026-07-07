/**
 * Keyless catalog coverage for the plugin-workflow action and route surface. Runs
 * on the pr-deterministic lane under the LLM proxy.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import workflowPlugin, {
  workflowRoutePlugin,
} from "../../../../plugins/plugin-workflow/src/index.ts";
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
  WORKFLOW_SERVICE_TYPE,
  type WorkflowService,
} from "../../../../plugins/plugin-workflow/src/services/index.ts";
import type { WorkflowDefinition } from "../../../../plugins/plugin-workflow/src/types/index.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const WORKFLOW_ID = "scenario-workflow-keyless-minimal";
const WORKFLOW_NAME = "Scenario keyless workflow";

const workflowExecutionParameters = {
  action: "executions",
  workflowId: WORKFLOW_ID,
  limit: 1,
};

const strictWorkflowRoutes = [
  {
    actionName: "WORKFLOW",
    args: workflowExecutionParameters,
    contextIds: ["automation"],
    input: "Run the workflow action to show executions",
    messageToUser: `Fetched 1 executions for workflow ${WORKFLOW_ID}.`,
  },
];

type JsonRecord = Record<string, unknown>;

type RuntimeWithWorkflowScenario = IAgentRuntime &
  RuntimeWithScenarioLlmFixtures & {
    db?: unknown;
    getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
    plugins?: Plugin[];
    registerPlugin?: (plugin: Plugin) => Promise<void>;
    routes?: Array<{
      type?: string;
      path: string;
      handler?: unknown;
      __scenarioWorkflowRoute?: boolean;
    }>;
  };

let seededExecutionId: string | null = null;
let scenarioRuntime: RuntimeWithWorkflowScenario | null = null;

const workflowDefinition: WorkflowDefinition = {
  id: WORKFLOW_ID,
  name: WORKFLOW_NAME,
  nodes: [
    {
      id: "manual",
      name: "Manual Trigger",
      type: "workflows-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: "set",
      name: "Set",
      type: "workflows-nodes-base.set",
      typeVersion: 3.4,
      position: [200, 0],
      parameters: {
        assignments: {
          assignments: [{ name: "scenario", value: "workflow-keyless" }],
        },
      },
    },
  ],
  connections: {
    "Manual Trigger": {
      main: [[{ node: "Set", type: "main", index: 0 }]],
    },
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function actionParameters(action: CapturedAction): JsonRecord {
  return isRecord(action.parameters) ? action.parameters : {};
}

function expectWorkflowActionOptions(
  action: CapturedAction,
): string | undefined {
  const actual = actionParameters(action);
  if (
    !expectEqual(
      actual,
      workflowExecutionParameters,
      "WORKFLOW handler options",
    )
  ) {
    return undefined;
  }
  const nested = isRecord(actual.parameters) ? actual.parameters : null;
  if (
    nested &&
    !expectEqual(
      nested,
      workflowExecutionParameters,
      "WORKFLOW nested handler parameters",
    )
  ) {
    return undefined;
  }
  return `expected WORKFLOW handler parameters to include ${stableStringify(workflowExecutionParameters)}, saw ${stableStringify(actual)}`;
}

function seededItem(execution: unknown): JsonRecord | null {
  const item = readPath(
    execution,
    "data.resultData.runData.Set.0.data.main.0.0.json",
  );
  return isRecord(item) ? item : null;
}

function expectSeededExecution(execution: unknown): string | undefined {
  for (const [path, expected] of Object.entries({
    workflowId: WORKFLOW_ID,
    status: "success",
    mode: "manual",
    finished: true,
  })) {
    const failure = expectEqual(readPath(execution, path), expected, path);
    if (failure) return failure;
  }
  const item = seededItem(execution);
  if (!item) {
    return `expected Set node runData item, saw ${stableStringify(execution)}`;
  }
  for (const [path, expected] of Object.entries({
    scenario: "workflow-keyless",
    trigger: "manual",
  })) {
    const failure = expectEqual(readPath(item, path), expected, `Set.${path}`);
    if (failure) return failure;
  }
  if (seededExecutionId && readPath(execution, "id") !== seededExecutionId) {
    return `expected execution id ${seededExecutionId}, saw ${String(readPath(execution, "id"))}`;
  }
  return undefined;
}

async function ensureWorkflowPlugin(
  runtime: RuntimeWithWorkflowScenario,
): Promise<void> {
  const registered = (runtime.plugins ?? []).some(
    (plugin) => plugin.name === workflowPlugin.name,
  );
  if (!registered) {
    await runtime.registerPlugin?.(workflowPlugin);
  }
  const routes = runtime.routes ?? [];
  // Workflow CRUD (GET/POST /api/workflow/workflows/:id) is served by the
  // canonical rawPath surface on `workflowRoutePlugin`, not the main plugin's
  // relative `routes`. Mount both so the CRUD read below resolves.
  const pluginRoutes = [
    ...(workflowPlugin.routes ?? []),
    ...(workflowRoutePlugin.routes ?? []),
  ];
  runtime.routes = routes.filter(
    (route) => route.__scenarioWorkflowRoute !== true,
  );
  for (const route of pluginRoutes) {
    runtime.routes.push({ ...route, __scenarioWorkflowRoute: true });
  }
}

async function workflowServices(runtime: RuntimeWithWorkflowScenario): Promise<{
  embedded: EmbeddedWorkflowService;
  service: WorkflowService;
}> {
  const embedded =
    ((await runtime.getServiceLoadPromise?.(EMBEDDED_WORKFLOW_SERVICE_TYPE)) as
      | EmbeddedWorkflowService
      | undefined) ??
    runtime.getService<EmbeddedWorkflowService>(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  const service =
    ((await runtime.getServiceLoadPromise?.(WORKFLOW_SERVICE_TYPE)) as
      | WorkflowService
      | undefined) ??
    runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);
  if (!embedded) throw new Error("EmbeddedWorkflowService was not registered");
  if (!service) throw new Error("WorkflowService was not registered");
  return { embedded, service };
}

async function seedWorkflow(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithWorkflowScenario | undefined;
  if (!runtime) return "scenario runtime was not available";
  scenarioRuntime = runtime;
  if (!runtime.db) return "scenario runtime db was not available";
  try {
    await ensureWorkflowPlugin(runtime);
    const { embedded, service } = await workflowServices(runtime);
    await embedded.deleteWorkflow(WORKFLOW_ID).catch(() => undefined);
    await embedded.createWorkflow(workflowDefinition);
    const execution = await embedded.executeWorkflow(WORKFLOW_ID);
    seededExecutionId = execution.id;
    const saved = await service.getWorkflow(WORKFLOW_ID);
    if (saved.id !== WORKFLOW_ID) {
      return `WorkflowService could not read seeded workflow ${WORKFLOW_ID}`;
    }
    const actionVisible = await service.listExecutions({
      workflowId: WORKFLOW_ID,
      limit: 1,
    });
    const failure = expectSeededExecution(actionVisible.data[0]);
    if (failure)
      return `seeded execution was not visible through WorkflowService: ${failure}`;
    registerStrictActionRouteFixtures(runtime, strictWorkflowRoutes);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function expectWorkflowAction(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "WORKFLOW");
  if (typeof action === "string") return action;
  const parametersFailure = expectWorkflowActionOptions(action);
  if (parametersFailure) return parametersFailure;
  if (action.result?.success !== true) {
    return `expected WORKFLOW result.success=true, saw ${stableStringify(action.result)}`;
  }
  if (
    action.result.text !== `Fetched 1 executions for workflow ${WORKFLOW_ID}.`
  ) {
    return `expected WORKFLOW success text, saw ${JSON.stringify(action.result.text)}`;
  }
  const executions = readPath(action.result, "data.executions");
  if (!Array.isArray(executions) || executions.length !== 1) {
    return `expected one workflow execution in action result, saw ${stableStringify(action.result)}`;
  }
  return expectSeededExecution(executions[0]);
}

function expectWorkflowRoute(
  status: number,
  body: unknown,
): string | undefined {
  if (status !== 200) return `expected status 200, saw ${status}`;
  // The canonical rawPath CRUD route returns the workflow object directly (no
  // `{ success, data }` envelope), so assert the workflow fields at the top level.
  for (const [path, expected] of Object.entries({
    id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
    "nodes.0.type": "workflows-nodes-base.manualTrigger",
    "nodes.1.type": "workflows-nodes-base.set",
  })) {
    const failure = expectEqual(readPath(body, path), expected, path);
    if (failure) return failure;
  }
  return undefined;
}

function expectExecutionsRoute(
  status: number,
  body: unknown,
): string | undefined {
  if (status !== 200) return `expected status 200, saw ${status}`;
  if (readPath(body, "success") !== true) {
    return `expected success=true, saw ${stableStringify(body)}`;
  }
  const executions = readPath(body, "data");
  if (!Array.isArray(executions) || executions.length !== 1) {
    return `expected one route execution, saw ${stableStringify(body)}`;
  }
  return expectSeededExecution(executions[0]);
}

async function finalWorkflowCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithWorkflowScenario | undefined;
  const activeRuntime = runtime ?? scenarioRuntime;
  if (!activeRuntime)
    return "scenario runtime was not available in final check";
  const { embedded, service } = await workflowServices(activeRuntime);
  const workflow = await service.getWorkflow(WORKFLOW_ID);
  if (workflow.id !== WORKFLOW_ID || workflow.name !== WORKFLOW_NAME) {
    return `expected seeded workflow through service, saw ${stableStringify(workflow)}`;
  }
  const executions = await embedded.listExecutions({
    workflowId: WORKFLOW_ID,
    limit: 1,
  });
  const failure = expectSeededExecution(executions.data[0]);
  if (failure) return failure;
  await embedded.deleteWorkflow(WORKFLOW_ID);
  return undefined;
}

export default scenario({
  id: "deterministic-workflow-actions-routes",
  lane: "pr-deterministic",
  title: "Deterministic workflow action and route coverage",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "workflow", "routes"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-workflow"],
  },
  seed: [
    {
      type: "custom",
      name: "seed and execute a real embedded Manual Trigger to Set workflow",
      apply: seedWorkflow,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "workflow",
      title: "Deterministic Workflow Actions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "WORKFLOW lists the seeded embedded execution",
      text: "Run the workflow action to show executions",
      assertTurn: expectWorkflowAction,
    },
    {
      kind: "api",
      name: "GET seeded workflow route",
      method: "GET",
      path: `/api/workflow/workflows/${WORKFLOW_ID}`,
      expectedStatus: 200,
      assertResponse: expectWorkflowRoute,
    },
    {
      kind: "api",
      name: "GET seeded execution route",
      method: "GET",
      path: `/executions?workflowId=${WORKFLOW_ID}&limit=1`,
      expectedStatus: 200,
      assertResponse: expectExecutionsRoute,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WORKFLOW",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "real embedded workflow services retain exact workflow and runData",
      predicate: finalWorkflowCheck,
    },
  ],
});

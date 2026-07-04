/**
 * Live-model coverage for the WORKFLOW action path (#12362 WI-6/WI-7).
 *
 * The deterministic sibling (`deterministic-workflow-actions-routes`) proves
 * the WORKFLOW action + routes under the LLM proxy with strict fixtures. This
 * scenario removes the fixtures and asserts a REAL model routes a natural
 * request ("show my workflow's recent runs") to the WORKFLOW action's
 * `executions` op over a genuinely seeded + executed embedded workflow, and
 * that the action returns the real execution the seed produced. It is
 * `live-only`: it needs a live model and is excluded from the pr-deterministic
 * lane.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import workflowPlugin from "../../../../plugins/plugin-workflow/src/index.ts";
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from "../../../../plugins/plugin-workflow/src/services/index.ts";
import type { WorkflowDefinition } from "../../../../plugins/plugin-workflow/src/types/index.ts";
import { getUserTagName } from "../../../../plugins/plugin-workflow/src/utils/context.ts";

const WORKFLOW_ID = "live-workflow-action-executions";
const WORKFLOW_NAME = "Morning digest";

type RuntimeWithWorkflow = IAgentRuntime & {
  db?: unknown;
  plugins?: Plugin[];
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  routes?: Array<
    { path: string; __scenarioWorkflowRoute?: boolean } & Record<
      string,
      unknown
    >
  >;
};

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
          assignments: [{ name: "digest", value: "sent" }],
        },
      },
    },
  ],
  connections: {
    "Manual Trigger": { main: [[{ node: "Set", type: "main", index: 0 }]] },
  },
};

let seededExecutionId: string | null = null;

async function embeddedService(
  runtime: RuntimeWithWorkflow,
): Promise<EmbeddedWorkflowService> {
  const embedded =
    ((await runtime.getServiceLoadPromise?.(EMBEDDED_WORKFLOW_SERVICE_TYPE)) as
      | EmbeddedWorkflowService
      | undefined) ??
    runtime.getService<EmbeddedWorkflowService>(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  if (!embedded) throw new Error("EmbeddedWorkflowService was not registered");
  return embedded;
}

async function seedWorkflow(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithWorkflow | undefined;
  if (!runtime?.db) return "scenario runtime db was not available";
  const registered = (runtime.plugins ?? []).some(
    (plugin) => plugin.name === workflowPlugin.name,
  );
  if (!registered) await runtime.registerPlugin?.(workflowPlugin);
  // Mount the plugin's routes so the executions op resolves the same way the
  // running app does.
  const existing = (runtime.routes ?? []).filter(
    (route) => route.__scenarioWorkflowRoute !== true,
  );
  runtime.routes = existing;
  for (const route of workflowPlugin.routes ?? []) {
    runtime.routes.push({ ...route, __scenarioWorkflowRoute: true });
  }

  // The ACTIVE_WORKFLOWS provider scopes by a per-user tag
  // (`WorkflowService.listWorkflows(userId)` filters by `getUserTagName`), so a
  // workflow created straight on the embedded engine is invisible to the model.
  // Create it (keeps our stable id + a real execution), then tag it for the
  // scenario's owner entity (the executor exposes it as ELIZA_ADMIN_ENTITY_ID)
  // so the provider surfaces it and the live model can route to it.
  const ownerId = runtime.getSetting?.("ELIZA_ADMIN_ENTITY_ID") as
    | string
    | undefined;
  if (!ownerId) return "scenario owner entity id was not available";

  const embedded = await embeddedService(runtime);
  await embedded.deleteWorkflow(WORKFLOW_ID).catch(() => undefined);
  await embedded.createWorkflow(workflowDefinition);

  const tagName = await getUserTagName(runtime, ownerId);
  const userTag = await embedded.getOrCreateTag(tagName);
  await embedded.updateWorkflowTags(WORKFLOW_ID, [userTag.id]);

  const execution = await embedded.executeWorkflow(WORKFLOW_ID);
  seededExecutionId = execution.id;
  return undefined;
}

/** The action must have run and returned the real seeded execution. */
function expectWorkflowExecutionsAction(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "WORKFLOW",
  );
  if (!action) {
    return `expected the WORKFLOW action to be selected, saw ${
      execution.actionsCalled.map((c) => c.actionName).join(", ") || "none"
    }`;
  }
  const result = action.result as
    | { success?: boolean; data?: { executions?: unknown[] } }
    | undefined;
  if (result?.success !== true) {
    return `expected WORKFLOW result.success=true, saw ${JSON.stringify(result)}`;
  }
  const executions = result.data?.executions;
  if (!Array.isArray(executions) || executions.length < 1) {
    return `expected at least one execution in the action result, saw ${JSON.stringify(result)}`;
  }
  return undefined;
}

async function finalWorkflowState(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithWorkflow | undefined;
  if (!runtime) return "scenario runtime unavailable in final check";
  const embedded = await embeddedService(runtime);
  const executions = await embedded.listExecutions({
    workflowId: WORKFLOW_ID,
    limit: 5,
  });
  const found = executions.data.some((e) => e.id === seededExecutionId);
  if (!found) {
    return `seeded execution ${seededExecutionId} not visible through the real service`;
  }
  await embedded.deleteWorkflow(WORKFLOW_ID).catch(() => undefined);
  return undefined;
}

export default scenario({
  id: "live-workflow-action-executions",
  lane: "live-only",
  title: "Live model routes a request to the WORKFLOW executions op",
  domain: "scenario-runner",
  tags: ["live", "workflow", "action-routing", "12362"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-workflow"] },
  seed: [
    {
      type: "custom",
      name: "register plugin-workflow, seed + execute a real embedded workflow",
      apply: seedWorkflow,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Workflow executions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user asks for the workflow's recent runs",
      text: `Can you check my "${WORKFLOW_NAME}" workflow and tell me its most recent runs?`,
      expectedActions: ["WORKFLOW"],
      assertTurn: expectWorkflowExecutionsAction,
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
      name: "the seeded execution is retained and readable through the real service",
      predicate: finalWorkflowState,
    },
  ],
});

/**
 * WI-6 (#12177) — integration proof that a workflow is schedulable via the
 * task/cron layer and dispatchable from a service, WITHOUT a live model.
 *
 * This drives the REAL path end to end:
 *   real EmbeddedWorkflowService (PGlite-backed persistence)
 *     -> a schedule-trigger node arms a real TRIGGER_DISPATCH core Task
 *     -> the REAL core TaskService tick (runDueTasks) fires it
 *     -> the REAL agent trigger worker (executeTriggerTask) dispatches
 *     -> the REAL WORKFLOW_DISPATCH service runs the workflow
 *     -> a row lands in workflow.embedded_executions + a TriggerRunRecord.
 *
 * The only test double is the runtime's task STORE (an in-memory map) — the
 * same lightweight harness the existing workflow-task-worker.test.ts uses. The
 * subject under test (workflow engine, dispatch, trigger worker, TaskService)
 * is all real code with real persistence.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Task, TaskWorker, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { TaskService } from "../../../../packages/core/src/services/task.ts";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import {
  executeTriggerTask,
  readTriggerRuns,
  registerTriggerTaskWorker,
} from "../../../../packages/agent/src/triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
} from "../../../../packages/agent/src/triggers/scheduling.ts";
import type { NormalizedTriggerDraft } from "../../../../packages/agent/src/triggers/types.ts";
import * as dbSchema from "../../src/db/schema";
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
  TRIGGER_TASK_NAME,
} from "../../src/services/embedded-workflow-service";
import {
  registerWorkflowDispatchService,
  WORKFLOW_DISPATCH_SERVICE_TYPE,
} from "../../src/services/workflow-dispatch";

setDefaultTimeout(60_000);

const AGENT_ID = stringToUuid("wi6-trigger-dispatch-agent");

interface Harness {
  runtime: IAgentRuntime;
  tasks: Map<UUID, Task>;
  workflow: EmbeddedWorkflowService;
  taskService: TaskService;
  close: () => Promise<void>;
}

/**
 * A runtime backed by a real PGlite DB and a real services registry, with an
 * in-memory task store. TaskService, EmbeddedWorkflowService and
 * WORKFLOW_DISPATCH all run for real against it.
 */
async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "wi6-trigger-"));
  const client = new PGlite({ dataDir: join(dir, "pglite") });
  const db = drizzle(client, { schema: dbSchema });

  const tasks = new Map<UUID, Task>();
  const workers = new Map<string, TaskWorker>();
  const services = new Map<string, unknown[]>();
  let nextId = 1;

  const runtime = {
    agentId: AGENT_ID,
    character: { settings: {} },
    db,
    serverless: true, // we drive ticks manually via runDueTasks()
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    services,
    getSetting: () => null,
    getService: (type: string) => {
      const entries = services.get(type);
      return entries && entries.length > 0 ? entries[0] : null;
    },
    registerTaskWorker: (worker: TaskWorker) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    createTask: async (task: Task) => {
      const id = (task.id ?? stringToUuid(`wi6-task-${nextId++}`)) as UUID;
      tasks.set(id, { ...task, id, agentId: AGENT_ID });
      return id;
    },
    getTask: async (id: UUID) => tasks.get(id) ?? null,
    getTasks: async (params: { tags?: string[] }) => {
      const wanted = params?.tags ?? [];
      return [...tasks.values()].filter((t) =>
        wanted.every((tag) => t.tags?.includes(tag)),
      );
    },
    getTasksByName: async (name: string) =>
      [...tasks.values()].filter((t) => t.name === name),
    updateTask: async (id: UUID, patch: Partial<Task>) => {
      const existing = tasks.get(id);
      if (existing) tasks.set(id, { ...existing, ...patch });
    },
    deleteTask: async (id: UUID) => {
      tasks.delete(id);
    },
  } as unknown as IAgentRuntime;

  // Register the REAL workflow engine + dispatch service on the runtime.
  const workflow = await EmbeddedWorkflowService.start(runtime);
  services.set(EMBEDDED_WORKFLOW_SERVICE_TYPE, [workflow]);
  registerWorkflowDispatchService(runtime);

  // Register the REAL trigger worker so the TaskService tick can dispatch it.
  registerTriggerTaskWorker(runtime);

  const taskService = (await TaskService.start(runtime)) as TaskService;

  return {
    runtime,
    tasks,
    workflow,
    taskService,
    async close() {
      await taskService.stop();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createScheduledWorkflow(
  workflow: EmbeddedWorkflowService,
  name: string,
  intervalMs: number,
): Promise<string> {
  const created = await workflow.createWorkflow({
    name,
    nodes: [
      {
        id: "sched",
        name: "Schedule Trigger",
        type: "workflows-nodes-base.scheduleTrigger",
        typeVersion: 1.2,
        position: [0, 0],
        parameters: { intervalMs },
      },
      {
        id: "set",
        name: "Set",
        type: "workflows-nodes-base.set",
        typeVersion: 3.4,
        position: [200, 0],
        parameters: { assignments: { assignments: [] } },
      },
    ],
    connections: {
      "Schedule Trigger": { main: [[{ node: "Set", type: "main", index: 0 }]] },
    },
  });
  return created.id;
}

/**
 * Force the single armed TRIGGER_DISPATCH task to be "due now" by rewinding its
 * schedule metadata into the past, then run one real TaskService tick.
 */
function makeTaskDueNow(task: Task): void {
  const meta = task.metadata as Record<string, unknown>;
  meta.updatedAt = 0;
  const trigger = meta.trigger as Record<string, unknown> | undefined;
  if (trigger) trigger.nextRunAtMs = 0;
}

describe("WI-6: workflow schedulable via the task/cron layer (real tick)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  test("(a) a scheduled workflow fires through the real TaskService tick and records an execution + a TriggerRunRecord", async () => {
    const workflowId = await createScheduledWorkflow(h.workflow, "WI6 sched", 60_000);
    await h.workflow.activateWorkflow(workflowId);

    const triggerTasks = [...h.tasks.values()].filter(
      (t) => t.name === TRIGGER_TASK_NAME,
    );
    expect(triggerTasks).toHaveLength(1);
    makeTaskDueNow(triggerTasks[0]);

    // The REAL core TaskService tick discovers the due queue task and runs the
    // REAL trigger worker, which dispatches through WORKFLOW_DISPATCH.
    await h.taskService.runDueTasks();

    // Domain artifact: an execution row landed in workflow.embedded_executions.
    const { data: executions } = await h.workflow.listExecutions({ workflowId });
    expect(executions.length).toBeGreaterThanOrEqual(1);

    // A TriggerRunRecord was appended to the task metadata.
    const refreshed = triggerTasks[0].id
      ? await h.runtime.getTask(triggerTasks[0].id)
      : null;
    expect(refreshed).not.toBeNull();
    const runs = refreshed ? readTriggerRuns(refreshed) : [];
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("success");
  });

  test("(b) the WORKFLOW_DISPATCH service runs a workflow by id (headless service call)", async () => {
    const workflowId = await createScheduledWorkflow(h.workflow, "WI6 dispatch", 60_000);
    const dispatch = h.runtime.getService(WORKFLOW_DISPATCH_SERVICE_TYPE) as {
      execute: (
        id: string,
        payload?: Record<string, unknown>,
        options?: { idempotencyKey?: string },
      ) => Promise<{ ok: boolean; executionId?: string; error?: string }>;
    } | null;
    expect(dispatch).not.toBeNull();

    const result = await dispatch?.execute(workflowId, {}, {});
    expect(result?.ok).toBe(true);

    const { data: executions } = await h.workflow.listExecutions({ workflowId });
    expect(executions.length).toBeGreaterThanOrEqual(1);
  });

  test("(c) one core TaskService clock drives both consumers — a trigger task and a LifeOps-scheduler task fire on the same tick", async () => {
    // Consumer 1: a real scheduled-workflow TRIGGER_DISPATCH task.
    const workflowId = await createScheduledWorkflow(h.workflow, "WI6 coexist", 60_000);
    await h.workflow.activateWorkflow(workflowId);
    const triggerTask = [...h.tasks.values()].find(
      (t) => t.name === TRIGGER_TASK_NAME,
    );
    expect(triggerTask).toBeDefined();
    if (triggerTask) makeTaskDueNow(triggerTask);

    // Consumer 2: a LifeOps-scheduler repeat task on the SAME clock. The real
    // LIFEOPS_SCHEDULER worker needs the full personal-assistant stack; here we
    // register a stand-in worker under the real name/tags to prove the single
    // core TaskService fires the second consumer on the same tick (the "one
    // clock, two consumers" architecture, verified structurally).
    let lifeopsFired = 0;
    h.runtime.registerTaskWorker({
      name: "LIFEOPS_SCHEDULER",
      execute: async () => {
        lifeopsFired += 1;
        return undefined;
      },
    });
    await h.runtime.createTask({
      name: "LIFEOPS_SCHEDULER",
      description: "LifeOps scheduler",
      tags: ["queue", "repeat", "lifeops"],
      metadata: { updatedAt: 0, updateInterval: 60_000 },
    });

    // A single tick of the ONE clock services both consumers.
    await h.taskService.runDueTasks();

    // Consumer 1 ran (workflow executed).
    const { data: executions } = await h.workflow.listExecutions({ workflowId });
    expect(executions.length).toBeGreaterThanOrEqual(1);
    // Consumer 2 ran on the same tick.
    expect(lifeopsFired).toBe(1);
  });

  test("(d) a disabled trigger does not fire; a re-enabled fire runs; maxRuns is respected", async () => {
    const workflowId = await createScheduledWorkflow(h.workflow, "WI6 gated", 60_000);

    // Build a maxRuns=1 workflow trigger task directly and drive executeTriggerTask.
    const draft: NormalizedTriggerDraft = {
      displayName: "Gated",
      instructions: `Run workflow ${workflowId}`,
      triggerType: "interval",
      wakeMode: "inject_now",
      enabled: false, // disabled
      createdBy: "wi6",
      intervalMs: 60_000,
      maxRuns: 1,
      kind: "workflow",
      workflowId,
    };
    const triggerId = stringToUuid("wi6-gated");
    const disabledTrigger = buildTriggerConfig({ draft, triggerId });
    const metadata = buildTriggerMetadata({ trigger: disabledTrigger, nowMs: Date.now() }) ?? {
      trigger: disabledTrigger,
    };
    const taskId = await h.runtime.createTask({
      name: TRIGGER_TASK_NAME,
      description: disabledTrigger.displayName,
      tags: ["queue", "repeat", "trigger", "workflow"],
      metadata: metadata as Task["metadata"],
    });
    const task = await h.runtime.getTask(taskId);
    if (!task) throw new Error("task not created");

    // Disabled → skipped, no execution.
    const skipped = await executeTriggerTask(h.runtime, task, { source: "scheduler" });
    expect(skipped.status).toBe("skipped");
    let executions = (await h.workflow.listExecutions({ workflowId })).data;
    expect(executions.length).toBe(0);

    // Enable it, run once → success, execution recorded.
    const enabledTrigger = { ...disabledTrigger, enabled: true };
    const enabledMeta =
      buildTriggerMetadata({ trigger: enabledTrigger, nowMs: Date.now() }) ??
      ({ trigger: enabledTrigger } as Task["metadata"]);
    await h.runtime.updateTask(taskId, { metadata: enabledMeta as Task["metadata"] });
    const enabledTask = await h.runtime.getTask(taskId);
    if (!enabledTask) throw new Error("task missing");
    const ran = await executeTriggerTask(h.runtime, enabledTask, { source: "scheduler" });
    expect(ran.status).toBe("success");
    executions = (await h.workflow.listExecutions({ workflowId })).data;
    expect(executions.length).toBe(1);

    // maxRuns=1 reached → the task is deleted so it never fires again.
    expect(ran.taskDeleted).toBe(true);
    expect(await h.runtime.getTask(taskId)).toBeNull();
  });
});

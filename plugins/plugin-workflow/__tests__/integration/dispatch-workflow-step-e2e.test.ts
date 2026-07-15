/**
 * #12362 WI-7 residual — the LifeOps `dispatch_workflow` workflow step drives
 * a REAL embedded workflow execution end to end.
 *
 * The subject under test is the seam between the two workflow layers: a
 * LifeOps owner-workflow step (`kind: "dispatch_workflow"`, contributed by
 * plugin-personal-assistant's default WorkflowStepRegistry pack) resolves the
 * REAL `WORKFLOW_DISPATCH` service and lands a row in the REAL
 * `workflow.embedded_executions` table (PGlite-backed EmbeddedWorkflowService).
 *
 * The step is invoked exactly the way the LifeOps dispatcher
 * (`WorkflowsDomain.executeWorkflowDefinition`,
 * plugin-personal-assistant/src/lifeops/domains/workflows-service.ts) invokes
 * it: registry bound to the runtime → `registry.get(step.kind)` →
 * `paramSchema.parse(step)` → `contribution.execute(validated, args, ctx)` —
 * NOT by calling the dispatch service directly. The full `WorkflowsDomain`
 * class is not importable here (its repository pulls built dists of
 * plugin-browser/finances/inbox), so this file drives the registry seam the
 * dispatcher consults; the loop mechanics around that seam are covered by
 * plugin-personal-assistant/test/workflow-step-registry.test.ts.
 *
 * Cases:
 *   (a) dispatch_workflow step → real execution row; the parent run's
 *       request + accumulated outputs are threaded into the nested
 *       execution's triggerData (the contribution's contract)
 *   (b) idempotent double-fire: same payload `__idempotencyKey` collapses two
 *       step executions onto one embedded execution row
 *   (c) WORKFLOW_DISPATCH not registered → structured failure, no execution
 *   (d) unknown workflowId → structured failure from the real dispatch, no row
 *   (e) malformed step (no workflowId) fails schema validation before dispatch
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { registerDefaultWorkflowStepPack } from '../../../plugin-personal-assistant/src/lifeops/registries/workflow-step-default-pack.ts';
import {
  createWorkflowStepRegistry,
  getWorkflowStepRegistry,
  registerWorkflowStepRegistry,
  type WorkflowStepExecuteArgs,
  type WorkflowStepExecuteContext,
} from '../../../plugin-personal-assistant/src/lifeops/registries/workflow-step-registry.ts';
import type { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import {
  registerWorkflowDispatchService,
  type WorkflowDispatchResult,
} from '../../src/services/workflow-dispatch';
import { type EmbeddedHarness, makeEmbeddedHarness } from './embedded-harness';

setDefaultTimeout(60_000);

/** A runnable two-node workflow the nested dispatch executes for real. */
async function createDispatchableWorkflow(
  workflow: EmbeddedWorkflowService,
  name: string
): Promise<string> {
  const created = await workflow.createWorkflow({
    name,
    nodes: [
      {
        id: 'sched',
        name: 'Schedule Trigger',
        type: 'workflows-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: { intervalMs: 60_000 },
      },
      {
        id: 'set',
        name: 'Set',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: { assignments: { assignments: [] } },
      },
    ],
    connections: {
      'Schedule Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    },
  });
  return created.id;
}

/** The minimal owner-workflow definition the step args carry; only ownership
 * defaults are read from it by contributions, none by dispatch_workflow. */
function makeLifeOpsDefinition(): WorkflowStepExecuteArgs['definition'] {
  return {
    id: 'lifeops-wf-1',
    agentId: 'agent',
    domain: 'personal',
    subjectType: 'agent',
    subjectId: 'agent',
    visibilityScope: 'owner_only',
    contextPolicy: 'default',
    title: 'Nested dispatch',
    triggerType: 'manual',
    schedule: { kind: 'manual' },
    actionPlan: { steps: [] },
    permissionPolicy: {
      allowBrowserActions: false,
      trustedBrowserActions: false,
    },
    status: 'active',
    createdBy: 'user',
    metadata: {},
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  } as unknown as WorkflowStepExecuteArgs['definition'];
}

function makeStepArgs(overrides: Partial<WorkflowStepExecuteArgs> = {}): WorkflowStepExecuteArgs {
  return {
    definition: makeLifeOpsDefinition(),
    startedAt: new Date().toISOString(),
    confirmBrowserActions: false,
    request: {},
    outputs: {},
    previousStepValue: null,
    ...overrides,
  };
}

/**
 * Execute one step the way `WorkflowsDomain.executeWorkflowDefinition` does:
 * consult the runtime-bound registry, validate against the contribution's
 * schema, then execute with the run args + service context.
 */
async function executeStepViaRegistry(
  h: EmbeddedHarness,
  step: Record<string, unknown>,
  args: WorkflowStepExecuteArgs
): Promise<unknown> {
  const registry = getWorkflowStepRegistry(h.runtime);
  if (!registry) throw new Error('registry not bound to runtime');
  const contribution = registry.get(String(step.kind));
  if (!contribution) throw new Error(`no contribution for kind ${step.kind}`);
  const validated = contribution.paramSchema.parse(step);
  const ctx = { runtime: h.runtime } as unknown as WorkflowStepExecuteContext;
  return contribution.execute(validated, args, ctx);
}

describe('dispatch_workflow step e2e (LifeOps registry -> WORKFLOW_DISPATCH -> embedded execution)', () => {
  let h: EmbeddedHarness;

  beforeEach(async () => {
    h = await makeEmbeddedHarness('dispatch-step-e2e-agent');
    registerWorkflowDispatchService(h.runtime);
    // The same wiring plugin-personal-assistant's init performs: default pack
    // registered into a registry bound to this runtime.
    const registry = createWorkflowStepRegistry();
    registerDefaultWorkflowStepPack(registry);
    registerWorkflowStepRegistry(h.runtime, registry);
  });

  afterEach(async () => {
    await h.close();
  });

  test("(a) the step lands a real execution row and threads request + outputs into the nested run's triggerData", async () => {
    const workflowId = await createDispatchableWorkflow(h.workflow, 'Nested digest');

    const args = makeStepArgs({
      request: { reason: 'parent-run' },
      outputs: { calendar: { eventCount: 3 } },
    });
    const result = (await executeStepViaRegistry(
      h,
      {
        kind: 'dispatch_workflow',
        workflowId,
        payload: { note: 'from-step' },
      },
      args
    )) as WorkflowDispatchResult;

    expect(result.ok).toBe(true);
    expect(result.executionId).toBeDefined();

    // Domain artifact: a real row in workflow.embedded_executions.
    const { data: executions } = await h.workflow.listExecutions({
      workflowId,
    });
    expect(executions).toHaveLength(1);
    const execution = executions[0];
    expect(execution.id).toBe(result.executionId as string);
    expect(execution.status).toBe('success');
    expect(execution.finished).toBe(true);
    expect(execution.mode).toBe('trigger');

    // The contribution's contract: step payload + parent request + accumulated
    // outputs all arrive as the nested execution's trigger data.
    const triggerData = execution.customData?.triggerData as Record<string, unknown>;
    expect(triggerData).toMatchObject({
      note: 'from-step',
      request: { reason: 'parent-run' },
      outputs: { calendar: { eventCount: 3 } },
    });
  });

  test('(b) two step fires sharing an idempotency key collapse onto one execution row', async () => {
    const workflowId = await createDispatchableWorkflow(h.workflow, 'Nested dedup');

    const step = {
      kind: 'dispatch_workflow',
      workflowId,
      // The dispatch layer's legacy payload contract: __idempotencyKey rides
      // inside the payload when the caller cannot pass a second argument —
      // exactly how a LifeOps step would express at-most-once semantics.
      payload: { __idempotencyKey: 'step-fire-1' },
    };

    const first = (await executeStepViaRegistry(h, step, makeStepArgs())) as WorkflowDispatchResult;
    const second = (await executeStepViaRegistry(
      h,
      step,
      makeStepArgs()
    )) as WorkflowDispatchResult;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.dedup).toBe(true);
    expect(second.executionId).toBe(first.executionId as string);

    const { data: executions } = await h.workflow.listExecutions({
      workflowId,
    });
    expect(executions).toHaveLength(1);
  });

  test('(c) missing WORKFLOW_DISPATCH service yields a structured failure and no execution', async () => {
    const missing = await makeEmbeddedHarness('dispatch-step-missing-service-agent');
    try {
      const registry = createWorkflowStepRegistry();
      registerDefaultWorkflowStepPack(registry);
      registerWorkflowStepRegistry(missing.runtime, registry);
      const workflowId = await createDispatchableWorkflow(missing.workflow, 'Nested orphan');

      const result = (await executeStepViaRegistry(
        missing,
        { kind: 'dispatch_workflow', workflowId },
        makeStepArgs()
      )) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toBe('WORKFLOW_DISPATCH service not registered');
      const { data: executions } = await missing.workflow.listExecutions({ workflowId });
      expect(executions).toHaveLength(0);
    } finally {
      await missing.close();
    }
  });

  test('(d) unknown workflowId is a structured failure from the real dispatch, not a throw', async () => {
    const result = (await executeStepViaRegistry(
      h,
      { kind: 'dispatch_workflow', workflowId: 'no-such-workflow' },
      makeStepArgs()
    )) as WorkflowDispatchResult;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    const { data: executions } = await h.workflow.listExecutions({
      workflowId: 'no-such-workflow',
    });
    expect(executions).toHaveLength(0);
  });

  test('(e) a step without workflowId fails schema validation before any dispatch', async () => {
    // The dispatcher parses against the contribution's schema before execute;
    // a malformed step must be rejected there, never reaching the service.
    await expect(
      executeStepViaRegistry(h, { kind: 'dispatch_workflow' }, makeStepArgs())
    ).rejects.toThrow();
  });
});

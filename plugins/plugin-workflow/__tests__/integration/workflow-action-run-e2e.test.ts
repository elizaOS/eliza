/**
 * #12362 WI-7 residual — the WORKFLOW action's `run` op executes a workflow
 * for real, keylessly (no model, no API key): action handler →
 * WorkflowService.runWorkflow → EmbeddedWorkflowService → a row in
 * workflow.embedded_executions.
 *
 * Complements the mocked-unit coverage in
 * __tests__/unit/workflow-action.test.ts (op dispatch against a mocked
 * service) and the live-only scenario
 * packages/scenario-runner/test/scenarios/live-workflow-action-executions.scenario.ts
 * (model routing): here the service stack under the action is entirely REAL —
 * a real WorkflowService started via WorkflowService.start() over a real
 * PGlite-backed EmbeddedWorkflowService. No workflow-service mocks.
 *
 * Cases:
 *   (a) run op → real execution row, asserted through the same real service
 *       layer the executions op reads (listExecutions)
 *   (b) a workflow whose node throws → success:false result AND a real
 *       error-status execution row (throwOnError:false path)
 *   (c) missing workflowId → structured failure, nothing executed
 *   (d) unknown workflowId → structured failure from the real store
 *   (e) validate() gates on the real service registration
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { HandlerCallback, HandlerOptions, IAgentRuntime, Memory } from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import type { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowExecution } from '../../src/types/index';
import { type EmbeddedHarness, makeEmbeddedHarness } from './embedded-harness';

setDefaultTimeout(60_000);

const message = { entityId: 'owner-test' } as Memory;

interface ActionHarness extends EmbeddedHarness {
  service: WorkflowService;
}

async function makeActionHarness(): Promise<ActionHarness> {
  const h = await makeEmbeddedHarness('workflow-action-run-agent');
  // The REAL service the action resolves — started keylessly the same way the
  // plugin's service lifecycle does; it adopts the registered embedded engine.
  const service = await WorkflowService.start(h.runtime);
  h.services.set(WORKFLOW_SERVICE_TYPE, [service]);
  return { ...h, service };
}

async function runOp(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  callback?: HandlerCallback
) {
  if (!workflowAction.handler) throw new Error('workflow action missing handler');
  return workflowAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as HandlerOptions,
    callback
  );
}

/** A manual-trigger workflow; `run` executes in manual mode. */
async function createManualWorkflow(
  workflow: EmbeddedWorkflowService,
  name: string,
  secondNode: { type: string; parameters: Record<string, unknown> }
): Promise<string> {
  const created = await workflow.createWorkflow({
    name,
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'workflows-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'work',
        name: 'Work',
        type: secondNode.type,
        typeVersion: 1,
        position: [200, 0],
        parameters: secondNode.parameters,
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Work', type: 'main', index: 0 }]] },
    },
  });
  return created.id;
}

describe('WORKFLOW action run op e2e (real WorkflowService + embedded engine, keyless)', () => {
  let h: ActionHarness;

  beforeEach(async () => {
    h = await makeActionHarness();
  });

  afterEach(async () => {
    await h.service.stop();
    await h.close();
  });

  test('(a) run executes the workflow and a real execution row is readable back through the service', async () => {
    const workflowId = await createManualWorkflow(h.workflow, 'Run me', {
      type: 'workflows-nodes-base.set',
      parameters: { assignments: { assignments: [] } },
    });

    const callbackContents: Array<Record<string, unknown>> = [];
    const callback: HandlerCallback = async (content) => {
      callbackContents.push(content as Record<string, unknown>);
      return [];
    };

    const result = await runOp(h.runtime, { action: 'run', workflowId }, callback);

    expect(result.success).toBe(true);
    expect(result.values?.status).toBe('success');
    const executionId = result.values?.executionId as string;
    expect(executionId).toBeDefined();

    // The user-facing callback reported the same real execution.
    expect(callbackContents).toHaveLength(1);
    expect(callbackContents[0].metadata).toMatchObject({
      workflowId,
      executionId,
      status: 'success',
    });

    // Domain artifact through the SAME real service layer the executions op
    // uses: a finished manual-mode row in workflow.embedded_executions.
    const { data: executions } = await h.service.listExecutions({ workflowId });
    expect(executions).toHaveLength(1);
    const execution = executions[0];
    expect(execution.id).toBe(executionId);
    expect(execution.status).toBe('success');
    expect(execution.finished).toBe(true);
    expect(execution.mode).toBe('manual');
  });

  test('(b) a workflow whose node throws yields success:false AND a real error-status execution row', async () => {
    const workflowId = await createManualWorkflow(h.workflow, 'Run me broken', {
      type: 'workflows-nodes-base.code',
      parameters: { jsCode: 'throw new Error("boom")' },
    });

    const result = await runOp(h.runtime, { action: 'run', workflowId });

    expect(result.success).toBe(false);
    expect(result.values?.status).toBe('error');

    // The failed run is still a persisted domain artifact (throwOnError:false
    // records the error execution instead of raising).
    const { data: executions } = await h.service.listExecutions({ workflowId });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe('error');
    expect(executions[0].finished).toBe(true);
    // The persisted diagnostics name the failing node (the embedded engine
    // echoes the node failure ahead of Smithers' wrapper error).
    const runError = (executions[0] as WorkflowExecution).data?.resultData?.error as
      | { message?: string }
      | undefined;
    expect(runError?.message ?? '').toContain('Node "Work" failed');
  });

  test('(c) run without workflowId is a structured failure and executes nothing', async () => {
    const result = await runOp(h.runtime, { action: 'run' });
    expect(result.success).toBe(false);
    expect(result.text).toBe('workflowId is required to run a workflow.');

    const { data: executions } = await h.service.listExecutions();
    expect(executions).toHaveLength(0);
  });

  test("(d) run with an unknown workflowId surfaces the real store's not-found failure", async () => {
    const result = await runOp(h.runtime, {
      action: 'run',
      workflowId: 'no-such-workflow',
    });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/not found/i);

    const { data: executions } = await h.service.listExecutions();
    expect(executions).toHaveLength(0);
  });

  test('(e) validate() reflects real service registration', async () => {
    if (!workflowAction.validate) throw new Error('workflow action missing validate');
    expect(await workflowAction.validate(h.runtime, message, undefined)).toBe(true);
    h.services.delete(WORKFLOW_SERVICE_TYPE);
    expect(await workflowAction.validate(h.runtime, message, undefined)).toBe(false);
  });
});

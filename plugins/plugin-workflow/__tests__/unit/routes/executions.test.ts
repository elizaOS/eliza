/** Execution query routes over real workflow services and persisted execution rows. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { executionRoutes } from '../../../src/routes/executions';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../../src/services/workflow-service';
import { createRouteRequest, createRouteResponse } from '../../helpers/routeHarness';
import { type EmbeddedHarness, makeEmbeddedHarness } from '../../integration/embedded-harness';

const listHandler = executionRoutes[0].handler;
const getHandler = executionRoutes[1].handler;
if (!listHandler || !getHandler) throw new Error('expected execution route handlers');

setDefaultTimeout(60_000);

let harness: EmbeddedHarness;
let firstWorkflowId: string;
let firstExecutionId: string;

async function createAndExecute(
  name: string
): Promise<{ workflowId: string; executionId: string }> {
  const workflow = await harness.workflow.createWorkflow({
    name,
    nodes: [
      {
        id: 'trigger',
        name: 'Manual Trigger',
        type: 'workflows-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
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
      'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    },
  });
  const execution = await harness.workflow.executeWorkflow(workflow.id, {
    mode: 'manual',
    triggerData: { suite: 'execution-routes' },
  });
  return { workflowId: workflow.id, executionId: execution.id };
}

beforeAll(async () => {
  harness = await makeEmbeddedHarness('execution-route-runtime');
  await harness.runtime.registerPlugin({
    name: 'execution-route-workflow-facade',
    description: 'Real workflow facade for execution route coverage',
    services: [WorkflowService],
  });
  const loadedService = await harness.runtime.getServiceLoadPromise(WORKFLOW_SERVICE_TYPE);
  if (!(loadedService instanceof WorkflowService)) {
    throw new Error('expected real WorkflowService');
  }
  const first = await createAndExecute('First execution route workflow');
  firstWorkflowId = first.workflowId;
  firstExecutionId = first.executionId;
  await createAndExecute('Second execution route workflow');
});

afterAll(async () => {
  await harness.close();
});

describe('GET /executions', () => {
  test('returns persisted executions', async () => {
    const { response, result } = createRouteResponse();
    await listHandler(createRouteRequest(), response, harness.runtime);

    const body = result().body as {
      success: boolean;
      data: Array<{ id: string; status: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data.map((execution) => execution.id)).toContain(firstExecutionId);
    expect(body.data.every((execution) => execution.status === 'success')).toBe(true);
  });

  test('applies workflow and limit filters in the real query path', async () => {
    const { response, result } = createRouteResponse();
    await listHandler(
      createRouteRequest({
        query: { workflowId: firstWorkflowId, status: 'success', limit: '1' },
      }),
      response,
      harness.runtime
    );

    const body = result().body as {
      success: boolean;
      data: Array<{ id: string; workflowId: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: firstExecutionId,
      workflowId: firstWorkflowId,
    });
  });

  test('uses the designed default for an invalid limit', async () => {
    const { response, result } = createRouteResponse();
    await listHandler(
      createRouteRequest({ query: { limit: 'not-a-number' } }),
      response,
      harness.runtime
    );

    const outcome = result();
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ success: true });
    expect((outcome.body as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe('GET /executions/:id', () => {
  test('returns persisted execution detail', async () => {
    const { response, result } = createRouteResponse();
    await getHandler(
      createRouteRequest({ params: { id: firstExecutionId } }),
      response,
      harness.runtime
    );

    const body = result().body as {
      success: boolean;
      data: { id: string; workflowId: string; status: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: firstExecutionId,
      workflowId: firstWorkflowId,
      status: 'success',
    });
  });

  test('returns 400 when id is missing without touching the service', async () => {
    const { response, result } = createRouteResponse();
    await getHandler(createRouteRequest({ params: {} }), response, harness.runtime);

    expect(result()).toEqual({
      status: 400,
      body: { success: false, error: 'execution_id_required' },
    });
  });

  test('returns a structured failure for an unknown execution', async () => {
    const { response, result } = createRouteResponse();
    await getHandler(
      createRouteRequest({ params: { id: 'missing-execution' } }),
      response,
      harness.runtime
    );

    expect(result()).toMatchObject({
      status: 500,
      body: { success: false, error: 'failed_to_fetch_execution' },
    });
  });
});

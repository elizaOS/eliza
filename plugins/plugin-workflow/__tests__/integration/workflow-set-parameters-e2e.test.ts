/**
 * Proves Set/Edit Fields normalization through the real WorkflowService,
 * PGlite persistence, Smithers execution, and stored execution artifact.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { stringToUuid } from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowDefinition } from '../../src/types/index';
import { type EmbeddedHarness, makeEmbeddedHarness } from './embedded-harness';

setDefaultTimeout(60_000);

const OWNER_ID = stringToUuid('workflow-set-parameter-owner');

function definition(assignments: Array<Record<string, unknown>>): WorkflowDefinition {
  return {
    name: 'Smithers Set parameter integrity',
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
        id: 'set',
        name: 'Set Result',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: {
          mode: 'manual',
          fields: { values: assignments },
        },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Set Result', type: 'main', index: 0 }]] },
    },
  };
}

describe('Set/Edit Fields deploy and Smithers execution', () => {
  let harness: EmbeddedHarness;
  let service: WorkflowService;

  beforeEach(async () => {
    harness = await makeEmbeddedHarness('workflow-set-parameter-agent');
    await harness.runtime.registerPlugin({
      name: 'workflow-set-parameter-integration-harness',
      description: 'Real WorkflowService for Set parameter boundary coverage',
      services: [WorkflowService],
    });
    service = (await harness.runtime.getServiceLoadPromise(
      WORKFLOW_SERVICE_TYPE
    )) as WorkflowService;
  });

  afterEach(async () => {
    await harness.close();
  });

  test('normalizes typed values, persists them, and emits them through Smithers', async () => {
    const deployed = await service.deployWorkflow(
      definition([
        {
          name: 'message',
          type: 'stringValue',
          stringValue: 'smithers-final-20260717',
        },
        { name: 'empty', type: 'stringValue', stringValue: '' },
        { name: 'enabled', type: 'booleanValue', booleanValue: false },
        { name: 'count', type: 'numberValue', numberValue: 0 },
      ]),
      OWNER_ID
    );

    const stored = await service.getWorkflow(deployed.id, OWNER_ID);
    expect(stored.nodes[1]?.parameters).toMatchObject({
      assignments: {
        assignments: [
          { name: 'message', type: 'string', value: 'smithers-final-20260717' },
          { name: 'empty', type: 'string', value: '' },
          { name: 'enabled', type: 'boolean', value: false },
          { name: 'count', type: 'number', value: 0 },
        ],
      },
    });
    expect(stored.nodes[1]?.parameters.fields).toBeUndefined();

    const execution = await service.runWorkflow(deployed.id, undefined, OWNER_ID);
    const output = execution.data?.resultData?.runData?.['Set Result']?.[0]?.data?.main?.[0]?.[0]
      ?.json as Record<string, unknown> | undefined;

    expect(execution.status).toBe('success');
    expect(output).toMatchObject({
      message: 'smithers-final-20260717',
      empty: '',
      enabled: false,
      count: 0,
    });
  });

  test('rejects a value-less generated assignment without creating a workflow row', async () => {
    await expect(
      service.deployWorkflow(definition([{ name: 'message', type: 'stringValue' }]), OWNER_ID)
    ).rejects.toMatchObject({
      name: 'ElizaError',
      code: 'WORKFLOW_SET_PARAMETERS_INVALID',
    });

    expect(await service.listWorkflows(OWNER_ID)).toEqual([]);
  });
});

/** Proves the workflow facade enforces owner isolation before every embedded Smithers operation. */

import { describe, expect, test } from 'bun:test';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type ExecuteWorkflowOptions,
} from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';
import type {
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
} from '../../src/types/index';
import { WorkflowApiError } from '../../src/types/index';

function definition(name: string): WorkflowDefinition {
  return {
    name,
    language: 'tsx',
    source: `import { createSmithers } from 'smthrs/create';
const api = createSmithers({}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
export default api.smithers(() => api.Workflow({ name: '${name}' }));`,
  };
}

function harness() {
  const workflows = new Map<string, WorkflowDefinitionResponse>();
  const executions = new Map<string, WorkflowExecution>();
  let sequence = 0;
  const embedded = {
    async createWorkflow(workflow: WorkflowDefinition) {
      sequence += 1;
      const id = workflow.id ?? `workflow-${sequence}`;
      const stored = {
        ...workflow,
        id,
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
        versionId: `version-${sequence}`,
      } satisfies WorkflowDefinitionResponse;
      workflows.set(id, stored);
      return stored;
    },
    async updateWorkflow(id: string, workflow: WorkflowDefinition) {
      const current = await this.getWorkflow(id);
      const stored = {
        ...workflow,
        id,
        createdAt: current.createdAt,
        updatedAt: '2026-08-13T00:01:00.000Z',
        versionId: `version-${++sequence}`,
      } satisfies WorkflowDefinitionResponse;
      workflows.set(id, stored);
      return stored;
    },
    async listWorkflows() {
      return { data: [...workflows.values()] };
    },
    async getWorkflow(id: string) {
      const workflow = workflows.get(id);
      if (!workflow) throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
      return workflow;
    },
    async deleteWorkflow(id: string) {
      workflows.delete(id);
    },
    async activateWorkflow(id: string) {
      return this.updateWorkflow(id, { ...(await this.getWorkflow(id)), active: true });
    },
    async deactivateWorkflow(id: string) {
      return this.updateWorkflow(id, { ...(await this.getWorkflow(id)), active: false });
    },
    async startWorkflow(id: string, options: ExecuteWorkflowOptions = {}) {
      const workflow = await this.getWorkflow(id);
      const execution: WorkflowExecution = {
        id: `execution-${++sequence}`,
        workflowId: id,
        workflowVersionId: workflow.versionId,
        workflowName: workflow.name,
        mode: options.mode ?? 'manual',
        status: 'queued',
        finished: false,
        startedAt: '2026-08-13T00:02:00.000Z',
        input: options.input ?? {},
      };
      executions.set(execution.id, execution);
      return execution;
    },
    async executeWorkflow(id: string, options: ExecuteWorkflowOptions = {}) {
      return this.startWorkflow(id, options);
    },
    async listExecutions(params: { workflowId?: string; limit?: number } = {}) {
      const data = [...executions.values()].filter(
        (execution) => !params.workflowId || execution.workflowId === params.workflowId
      );
      return { data: params.limit ? data.slice(0, params.limit) : data };
    },
    async getExecution(id: string) {
      const execution = executions.get(id);
      if (!execution) throw new WorkflowApiError(`Workflow execution not found: ${id}`, 404);
      return execution;
    },
    async cancelExecution(id: string) {
      return this.getExecution(id);
    },
    async listWorkflowRevisions() {
      return { data: [] };
    },
    async restoreWorkflowRevision(id: string) {
      return this.getWorkflow(id);
    },
  };
  const runtime = {
    agentId: '00000000-0000-4000-8000-000000000001' as UUID,
    character: { name: 'Owner isolation test' },
    getService: (type: string) => (type === EMBEDDED_WORKFLOW_SERVICE_TYPE ? embedded : null),
  } as unknown as IAgentRuntime;
  return { service: new WorkflowService(runtime), embedded, workflows };
}

async function expectNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    throw new Error('Expected owner isolation to reject the operation');
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowApiError);
    expect((error as WorkflowApiError).statusCode).toBe(404);
  }
}

describe('workflow owner isolation', () => {
  test('scopes CRUD, execution, and revision access to the creating principal', async () => {
    const { service } = harness();
    const created = await service.deployWorkflow(definition('Private'), 'owner-a');

    const visible = await service.listWorkflows('owner-a');
    expect(visible).toHaveLength(1);
    expect(visible[0]?.metadata).not.toHaveProperty('elizaOwnerEntityId');
    expect(await service.listWorkflows('owner-b')).toHaveLength(0);
    await expectNotFound(() => service.getWorkflow(created.id, 'owner-b'));
    await expectNotFound(() =>
      service.updateWorkflow(created.id, definition('Hijacked'), 'owner-b')
    );
    await expectNotFound(() => service.activateWorkflow(created.id, 'owner-b'));
    await expectNotFound(() => service.deleteWorkflow(created.id, 'owner-b'));
    await expectNotFound(() => service.startWorkflow(created.id, {}, 'owner-b'));
    await expectNotFound(() => service.getWorkflowRevisions(created.id, 20, 'owner-b'));

    const execution = await service.startWorkflow(created.id, { input: { ok: true } }, 'owner-a');
    await expectNotFound(() => service.getExecutionDetail(execution.id, 'owner-b'));
    await expectNotFound(() => service.cancelExecution(execution.id, 'owner-b'));
    expect((await service.listExecutions({}, 'owner-b')).data).toHaveLength(0);
    expect((await service.listExecutions({}, 'owner-a')).data).toHaveLength(1);
  });

  test('does not let a caller replace persisted ownership metadata', async () => {
    const { service } = harness();
    const created = await service.deployWorkflow(definition('Owned'), 'owner-a');
    await service.updateWorkflow(
      created.id,
      { ...definition('Still owned'), metadata: { elizaOwnerEntityId: 'owner-b' } },
      'owner-a'
    );

    expect((await service.getWorkflow(created.id, 'owner-a')).name).toBe('Still owned');
    await expectNotFound(() => service.getWorkflow(created.id, 'owner-b'));
  });
});

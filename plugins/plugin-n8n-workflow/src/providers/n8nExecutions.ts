import {
  encodeToonValue,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from '../services/index';
import type { N8nExecution } from '../types/index';

const DEFAULT_PER_WORKFLOW_LIMIT = 5;
const MAX_WORKFLOWS = 10;

interface ExecutionRow {
  workflowId: string;
  workflowName: string;
  executionId: string;
  status: N8nExecution['status'];
  startedAt: string;
  stoppedAt?: string;
  error?: string;
}

/**
 * Provider that surfaces recent n8n workflow execution history as a TOON table.
 *
 * Replaces the legacy GET_N8N_EXECUTIONS action. Surfacing executions through a
 * provider lets the planner reason over recent runs every turn without paying
 * an LLM hop to match a workflow.
 */
export const n8nExecutionsProvider: Provider = {
  name: 'n8nExecutions',
  description: 'Recent n8n workflow execution history (status, start/stop, errors).',
  descriptionCompressed: 'Recent n8n workflow execution history.',

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);
    if (!service) {
      return { text: '', data: {}, values: {} };
    }

    try {
      const userId = message.entityId;
      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        return {
          text: encodeToonValue({
            n8nExecutions: { status: 'no_workflows', executions: [] },
          }),
          data: { executions: [] },
          values: { hasExecutions: false },
        };
      }

      const targets = workflows.slice(0, MAX_WORKFLOWS);
      const rows: ExecutionRow[] = [];

      const executionsByWorkflow = await Promise.all(
        targets.map(async (wf) => {
          try {
            const executions = await service.getWorkflowExecutions(
              wf.id,
              DEFAULT_PER_WORKFLOW_LIMIT
            );
            return { workflow: wf, executions };
          } catch (error) {
            logger.debug(
              { src: 'plugin:n8n-workflow:provider:executions' },
              `Could not fetch executions for workflow ${wf.id}: ${error instanceof Error ? error.message : String(error)}`
            );
            return { workflow: wf, executions: [] as N8nExecution[] };
          }
        })
      );

      for (const entry of executionsByWorkflow) {
        for (const exec of entry.executions) {
          const row: ExecutionRow = {
            workflowId: entry.workflow.id,
            workflowName: entry.workflow.name,
            executionId: exec.id,
            status: exec.status,
            startedAt: exec.startedAt,
          };
          if (exec.stoppedAt) {
            row.stoppedAt = exec.stoppedAt;
          }
          const errorMessage = exec.data?.resultData?.error?.message;
          if (errorMessage) {
            row.error = errorMessage;
          }
          rows.push(row);
        }
      }

      if (rows.length === 0) {
        return {
          text: encodeToonValue({
            n8nExecutions: { status: 'no_executions', executions: [] },
          }),
          data: { executions: [] },
          values: { hasExecutions: false },
        };
      }

      return {
        text: encodeToonValue({
          n8nExecutions: {
            status: 'ready',
            instruction:
              "Recent execution rows for the user's n8n workflows. Use `error` to diagnose failed runs.",
            executions: rows,
          },
        }),
        data: { executions: rows },
        values: { hasExecutions: true, executionCount: rows.length },
      };
    } catch (error) {
      logger.error(
        { src: 'plugin:n8n-workflow:provider:executions' },
        `Failed to load executions: ${error instanceof Error ? error.message : String(error)}`
      );
      return { text: '', data: {}, values: {} };
    }
  },
};

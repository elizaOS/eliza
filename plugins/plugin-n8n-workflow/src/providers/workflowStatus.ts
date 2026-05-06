import { type IAgentRuntime, logger, type Memory, type Provider, type State } from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from '../services/index';

export const workflowStatusProvider: Provider = {
  name: 'n8n_workflow_status',

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const service = runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);

      if (!service) {
        logger.warn(
          { src: 'plugin:n8n-workflow:provider:workflowStatus' },
          'N8n Workflow service not available for provider'
        );
        return {
          text: '',
          data: {},
          values: {},
        };
      }

      // Get workflows for the user
      const userId = _message.entityId;

      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        return {
          text: 'No n8n workflows configured yet.',
          data: {},
          values: {},
        };
      }

      let status = `Current n8n workflows (${workflows.length}):\n\n`;

      for (const workflow of workflows.slice(0, 10)) {
        const statusEmoji = workflow.active ? '✅' : '⏸️';
        status += `${statusEmoji} ${workflow.name} (ID: ${workflow.id})\n`;
        status += `   Nodes: ${workflow.nodes?.length || 0}\n`;

        // Try to get last execution (if possible)
        try {
          const executions = await service.getWorkflowExecutions(workflow.id, 1);
          if (executions.length > 0) {
            const lastExec = executions[0];
            const execEmoji =
              lastExec.status === 'success' ? '✅' : lastExec.status === 'error' ? '❌' : '⏳';
            status += `   Last run: ${execEmoji} ${lastExec.status} at ${new Date(lastExec.startedAt).toLocaleString()}\n`;
          }
        } catch (_error) {
          // Ignore execution fetch errors
          logger.debug(
            { src: 'plugin:n8n-workflow:provider:workflowStatus' },
            `Could not fetch executions for workflow ${workflow.id}`
          );
        }

        status += '\n';
      }

      if (workflows.length > 10) {
        status += `\n... and ${workflows.length - 10} more workflows.`;
      }

      return {
        text: status,
        data: { workflows },
        values: { workflowCount: workflows.length },
      };
    } catch (error) {
      logger.error(
        { src: 'plugin:n8n-workflow:provider:workflowStatus' },
        `Failed to get workflow status: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        text: '',
        data: {},
        values: {},
      };
    }
  },
};

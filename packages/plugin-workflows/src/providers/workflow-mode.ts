import { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { WorkflowService } from '../services/workflow';

export const workflowModeProvider: Provider = {
  name: 'workflowMode',
  description: 'Provides information about applicable workflows for the current context',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      const workflowService = runtime.getService('workflow') as WorkflowService;
      
      if (!workflowService) {
        return {
          text: 'STANDARD_MODE: Workflow service not available. Proceed with normal LLM-based processing.'
        };
      }
      
      // Check if there's a workflow that should handle this message
      const applicableWorkflows = await workflowService.getApplicableWorkflows(message);
      
      if (applicableWorkflows.length > 0) {
        return {
          text: `WORKFLOW_MODE: The following deterministic workflows apply to this message:
${applicableWorkflows.map(w => `- ${w.name}: ${w.description}`).join('\n')}

These will be executed automatically. You should acknowledge this and not attempt to handle these actions yourself.`,
          data: {
            mode: 'workflow',
            workflows: applicableWorkflows.map(w => ({ id: w.id, name: w.name }))
          }
        };
      }
      
      return {
        text: 'STANDARD_MODE: No deterministic workflows apply. Proceed with normal LLM-based processing.',
        data: {
          mode: 'standard'
        }
      };
    } catch (error) {
      console.error('[WorkflowModeProvider] Error:', error);
      return {
        text: 'STANDARD_MODE: Error checking workflows. Proceed with normal LLM-based processing.',
        data: {
          mode: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }
}; 
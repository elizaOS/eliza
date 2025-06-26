import { Plugin } from '@elizaos/core';
import { WorkflowService } from './services/workflow';
import { 
  createWorkflowAction, 
  toggleWorkflowAction, 
  listWorkflowsAction, 
  executeWorkflowAction 
} from './actions/workflow-management';
import { workflowModeProvider } from './providers/workflow-mode';

export const workflowPlugin: Plugin = {
  name: 'workflow',
  description: 'Deterministic workflow execution system for ElizaOS',
  
  services: [WorkflowService],
  
  actions: [
    createWorkflowAction,
    toggleWorkflowAction,
    listWorkflowsAction,
    executeWorkflowAction
  ],
  
  providers: [workflowModeProvider],
  
  init: async (runtime) => {
    console.log('[WorkflowPlugin] Initializing...');
    
    // Get the workflow service
    const workflowService = runtime.getService<WorkflowService>('workflow');
    
    if (workflowService) {
      await workflowService.initialize();
      console.log('[WorkflowPlugin] Workflow service initialized');
    } else {
      console.error('[WorkflowPlugin] Failed to get workflow service');
    }
  }
};

// Export types for external use
export * from './services/workflow';
export { WorkflowExecutionEngine } from './engine/execution';

// Default export for convenience
export default workflowPlugin; 
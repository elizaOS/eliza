import { 
  Action, 
  IAgentRuntime, 
  Memory, 
  State, 
  HandlerCallback,
  UUID,
  Content,
  Workflow
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowService } from '../services/workflow';

export const createWorkflowAction: Action = {
  name: 'CREATE_WORKFLOW',
  description: 'Create a new deterministic workflow from JSON definition',
  similes: ['define-workflow', 'add-workflow', 'register-workflow'],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Check if message contains JSON workflow definition
    const text = message.content.text;
    if (!text) return false;
    
    try {
      const json = JSON.parse(text);
      return json.name && json.steps && Array.isArray(json.steps);
    } catch {
      return false;
    }
  },
  
  handler: async (
    runtime: IAgentRuntime, 
    message: Memory, 
    state?: State, 
    options?: any, 
    callback?: HandlerCallback
  ) => {
    try {
      const workflowService = runtime.getService('workflow') as WorkflowService;
      if (!workflowService) {
        await callback?.({
          text: 'Workflow service is not available. Please ensure the workflow plugin is loaded.',
          source: message.content.source
        });
        return;
      }
      
      const workflowData = JSON.parse(message.content.text || '{}');
      
      const workflow: Workflow = {
        ...workflowData,
        id: workflowData.id || (uuidv4() as UUID),
        version: workflowData.version || '1.0.0',
        enabled: workflowData.enabled !== false, // Default to enabled
        tags: workflowData.tags || []
      };
      
      await workflowService.registerWorkflow(workflow);
      
      await callback?.({
        text: `Workflow "${workflow.name}" created successfully with ID: ${workflow.id}`,
        metadata: { workflowId: workflow.id }
      });
    } catch (error) {
      await callback?.({
        text: `Failed to create workflow: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source
      });
    }
  }
};

export const toggleWorkflowAction: Action = {
  name: 'TOGGLE_WORKFLOW',
  description: 'Enable or disable a workflow',
  similes: ['enable-workflow', 'disable-workflow', 'workflow-toggle'],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text;
    return text.includes('workflow') && (text.includes('enable') || text.includes('disable'));
  },
  
  handler: async (
    runtime: IAgentRuntime, 
    message: Memory, 
    state: State, 
    options: any, 
    callback?: HandlerCallback
  ) => {
    try {
      const workflowService = runtime.getService('workflow') as WorkflowService;
      if (!workflowService) {
        await callback?.({
          text: 'Workflow service is not available.',
          source: message.content.source
        });
        return;
      }
      
      // Extract workflow ID and action from message
      const text = message.content.text;
      const workflowIdMatch = text.match(/workflow\s+([a-f0-9-]+)/i);
      const enabled = text.includes('enable');
      
      if (!workflowIdMatch) {
        await callback?.({
          text: 'Please specify a workflow ID. Example: "enable workflow abc123..."',
          source: message.content.source
        });
        return;
      }
      
      const workflowId = workflowIdMatch[1] as UUID;
      await workflowService.updateWorkflow(workflowId, { enabled });
      
      await callback?.({
        text: `Workflow ${workflowId} is now ${enabled ? 'enabled' : 'disabled'}`,
        metadata: { workflowId, enabled }
      });
    } catch (error) {
      await callback?.({
        text: `Failed to toggle workflow: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source
      });
    }
  }
};

export const listWorkflowsAction: Action = {
  name: 'LIST_WORKFLOWS',
  description: 'List all registered workflows',
  similes: ['show-workflows', 'get-workflows', 'workflows-list'],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('list') && text.includes('workflow');
  },
  
  handler: async (
    runtime: IAgentRuntime, 
    message: Memory, 
    state: State, 
    options: any, 
    callback?: HandlerCallback
  ) => {
    try {
      const workflowService = runtime.getService('workflow') as WorkflowService;
      if (!workflowService) {
        await callback?.({
          text: 'Workflow service is not available.',
          source: message.content.source
        });
        return;
      }
      
      const workflows = await workflowService.listWorkflows();
      
      if (workflows.length === 0) {
        await callback?.({
          text: 'No workflows registered.',
          source: message.content.source
        });
        return;
      }
      
      const workflowList = workflows.map(w => 
        `- ${w.name} (${w.id.substring(0, 8)}...) - ${w.enabled ? 'Enabled' : 'Disabled'}\n  ${w.description}`
      ).join('\n\n');
      
      await callback?.({
        text: `Registered workflows:\n\n${workflowList}`,
        metadata: { workflows: workflows.map(w => ({ id: w.id, name: w.name, enabled: w.enabled })) }
      });
    } catch (error) {
      await callback?.({
        text: `Failed to list workflows: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source
      });
    }
  }
};

export const executeWorkflowAction: Action = {
  name: 'EXECUTE_WORKFLOW',
  description: 'Manually execute a workflow',
  similes: ['run-workflow', 'trigger-workflow', 'workflow-execute'],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return (text.includes('execute') || text.includes('run')) && text.includes('workflow');
  },
  
  handler: async (
    runtime: IAgentRuntime, 
    message: Memory, 
    state: State, 
    options: any, 
    callback?: HandlerCallback
  ) => {
    try {
      const workflowService = runtime.getService('workflow') as WorkflowService;
      if (!workflowService) {
        await callback?.({
          text: 'Workflow service is not available.',
          source: message.content.source
        });
        return;
      }
      
      // Extract workflow ID from message
      const text = message.content.text;
      const workflowIdMatch = text.match(/workflow\s+([a-f0-9-]+)/i);
      
      if (!workflowIdMatch) {
        await callback?.({
          text: 'Please specify a workflow ID. Example: "execute workflow abc123..."',
          source: message.content.source
        });
        return;
      }
      
      const workflowId = workflowIdMatch[1] as UUID;
      
      // Extract any inputs from message metadata
      const inputs = message.content.metadata?.workflowInputs || {};
      
      const execution = await workflowService.executeWorkflow(
        workflowId,
        {
          type: 'manual',
          event: 'MANUAL_EXECUTION',
          payload: message
        },
        inputs
      );
      
      await callback?.({
        text: `Workflow execution ${execution.status}: ${execution.id}`,
        metadata: { 
          executionId: execution.id, 
          status: execution.status,
          outputs: execution.outputs
        }
      });
    } catch (error) {
      await callback?.({
        text: `Failed to execute workflow: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source
      });
    }
  }
}; 
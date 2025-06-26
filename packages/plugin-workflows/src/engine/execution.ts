import { 
  IAgentRuntime, 
  UUID, 
  Memory, 
  Content,
  Workflow, 
  WorkflowExecution, 
  WorkflowStep,
  WorkflowAction,
  WorkflowCondition,
  State
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { JSONPath } from 'jsonpath-plus';

export class WorkflowExecutionEngine {
  constructor(private runtime: IAgentRuntime) {}
  
  async execute(workflow: Workflow, execution: WorkflowExecution): Promise<Record<string, any>> {
    const context = execution.context;
    const stepResults: Record<string, any> = {};
    
    // Find starting step (one without any incoming next references)
    let currentStepId: string | undefined = workflow.steps.find(s => 
      !workflow.steps.some(other => other.next === s.id)
    )?.id;
    
    if (!currentStepId) {
      // If no explicit start, use first step
      currentStepId = workflow.steps[0]?.id;
    }
    
    while (currentStepId) {
      const step = workflow.steps.find(s => s.id === currentStepId);
      if (!step) break;
      
      execution.currentStepId = currentStepId;
      
      try {
        const result = await this.executeStep(step, context, stepResults);
        stepResults[step.id] = result;
        
        // Update context with step result
        context[`steps.${step.id}`] = result;
        
        // Determine next step
        if (step.type === 'condition' && step.condition) {
          const conditionMet = await this.evaluateCondition(step.condition.if, context);
          currentStepId = conditionMet ? step.condition.then : step.condition.else;
        } else {
          currentStepId = step.next;
        }
        
      } catch (error) {
        if (step.action?.onError === 'continue') {
          currentStepId = step.next;
        } else if (step.action?.onError === 'goto' && step.action.errorHandler) {
          currentStepId = step.action.errorHandler;
        } else {
          throw error;
        }
      }
    }
    
    // Extract outputs
    const outputs: Record<string, any> = {};
    if (workflow.outputs) {
      for (const [key, path] of Object.entries(workflow.outputs)) {
        outputs[key] = this.extractValue(context, path);
      }
    }
    
    return outputs;
  }
  
  private async executeStep(
    step: WorkflowStep, 
    context: Record<string, any>,
    stepResults: Record<string, any>
  ): Promise<any> {
    switch (step.type) {
      case 'action':
        if (!step.action) {
          throw new Error(`Action step ${step.id} missing action configuration`);
        }
        return await this.executeAction(step.action, context);
        
      case 'parallel':
        if (!step.parallel) {
          throw new Error(`Parallel step ${step.id} missing parallel configuration`);
        }
        return await this.executeParallel(step.parallel, context);
        
      case 'loop':
        if (!step.loop) {
          throw new Error(`Loop step ${step.id} missing loop configuration`);
        }
        return await this.executeLoop(step.loop, context);
        
      case 'condition':
        // Condition steps don't execute, they just determine flow
        return { type: 'condition', evaluated: true };
        
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }
  
  private async executeAction(action: WorkflowAction, context: Record<string, any>): Promise<any> {
    const registeredAction = this.runtime.actions.find(a => a.name === action.name);
    
    if (!registeredAction) {
      throw new Error(`Action ${action.name} not found`);
    }
    
    // Process inputs with template substitution
    const processedInputs = this.processTemplates(action.inputs, context);
    
    // Create a synthetic message for the action
    const message: Memory = {
      id: uuidv4() as UUID,
      entityId: this.runtime.agentId,
      roomId: context.trigger?.roomId || (uuidv4() as UUID),
      worldId: context.trigger?.worldId || (uuidv4() as UUID),
      content: {
        text: '', // Actions in workflows don't need text
        metadata: {
          workflowAction: true,
          inputs: processedInputs
        }
      }
    };
    
    // Create state with workflow context
    const state: State = {
      values: new Map(),
      data: context,
      text: `Workflow execution: ${context._workflow?.name || 'Unknown'}`,
    };
    
    // Add workflow inputs to state
    for (const [key, value] of Object.entries(processedInputs)) {
      state.values.set(key, value);
    }
    
    let result: any = null;
    const callback = async (response: Content): Promise<Memory[]> => {
      result = response;
      // Return empty array since workflow actions don't create memories
      return [];
    };
    
    // Execute with timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Action timeout')), action.timeout || 30000);
    });
    
    // Handle retry policy
    let lastError: Error | null = null;
    const maxAttempts = action.retryPolicy?.maxAttempts || 1;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await Promise.race([
          registeredAction.handler(this.runtime, message, state, {}, callback),
          timeoutPromise
        ]);
        
        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxAttempts) {
          // Wait before retry
          await new Promise(resolve => 
            setTimeout(resolve, action.retryPolicy?.backoffMs || 1000)
          );
        }
      }
    }
    
    throw lastError || new Error('Action execution failed');
  }
  
  private async executeParallel(stepIds: string[], context: Record<string, any>): Promise<any[]> {
    // Execute all steps in parallel
    const promises = stepIds.map(async (stepId) => {
      const step = context._workflow.steps?.find((s: WorkflowStep) => s.id === stepId);
      if (!step) {
        throw new Error(`Parallel step ${stepId} not found`);
      }
      
      return await this.executeStep(step, context, {});
    });
    
    return await Promise.all(promises);
  }
  
  private async executeLoop(
    loop: { over: string; as: string; steps: string[] }, 
    context: Record<string, any>
  ): Promise<any[]> {
    // Extract array to loop over
    const items = this.extractValue(context, loop.over);
    if (!Array.isArray(items)) {
      throw new Error(`Loop target ${loop.over} is not an array`);
    }
    
    const results: any[] = [];
    
    // Execute steps for each item
    for (const item of items) {
      // Create loop context
      const loopContext = {
        ...context,
        [loop.as]: item
      };
      
      // Execute all steps in sequence for this item
      for (const stepId of loop.steps) {
        const step = context._workflow.steps?.find((s: WorkflowStep) => s.id === stepId);
        if (!step) {
          throw new Error(`Loop step ${stepId} not found`);
        }
        
        const result = await this.executeStep(step, loopContext, {});
        results.push(result);
      }
    }
    
    return results;
  }
  
  private async evaluateCondition(condition: WorkflowCondition, context: any): Promise<boolean> {
    try {
      const value = this.extractValue(context, condition.field);
      
      switch (condition.operator) {
        case 'equals':
          return value === condition.value;
        case 'contains':
          return String(value).includes(String(condition.value));
        case 'matches':
          return condition.regex ? new RegExp(condition.regex).test(String(value)) : false;
        case 'exists':
          return value !== undefined;
        case 'gt':
          return Number(value) > Number(condition.value);
        case 'lt':
          return Number(value) < Number(condition.value);
        default:
          return false;
      }
    } catch (error) {
      return false;
    }
  }
  
  private extractValue(context: any, path: string): any {
    // Handle template syntax {{path}}
    const templateMatch = path.match(/^{{(.+)}}$/);
    if (templateMatch) {
      path = `$.${templateMatch[1]}`;
    }
    
    // Use JSONPath to extract value
    const results = JSONPath({ path, json: context });
    return results.length > 0 ? results[0] : undefined;
  }
  
  private processTemplates(obj: any, context: any): any {
    if (typeof obj === 'string') {
      // Replace {{path}} with actual values
      return obj.replace(/{{(.+?)}}/g, (match, path) => {
        const value = this.extractValue(context, `{{${path}}}`);
        return value !== undefined ? String(value) : match;
      });
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.processTemplates(item, context));
    }
    
    if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.processTemplates(value, context);
      }
      return result;
    }
    
    return obj;
  }
} 
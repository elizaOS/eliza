import { 
  Service, 
  ServiceType, 
  IAgentRuntime, 
  UUID, 
  Memory,
  Workflow,
  WorkflowExecution,
  WorkflowTrigger,
  WorkflowCondition
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import * as cron from 'node-cron';
import { JSONPath } from 'jsonpath-plus';
import { WorkflowExecutionEngine } from '../engine/execution';

export class WorkflowService extends Service {
  static serviceType = ServiceType.WORKFLOW;
  capabilityDescription = 'Workflow Management Service';
  
  private workflows: Map<UUID, Workflow> = new Map();
  private executions: Map<UUID, WorkflowExecution> = new Map();
  private executionEngine: WorkflowExecutionEngine;
  private scheduledTasks: Map<UUID, cron.ScheduledTask> = new Map();
  private eventListeners: Map<string, Set<UUID>> = new Map();
  
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.executionEngine = new WorkflowExecutionEngine(runtime);
    }
  }
  
  async initialize() {
    if (!this.runtime) {
      throw new Error('Runtime not initialized');
    }
    
    this.executionEngine = new WorkflowExecutionEngine(this.runtime);
    
    // Load workflows from database
    await this.loadWorkflows();
    
    // Register event listeners for all workflow triggers
    for (const workflow of this.workflows.values()) {
      await this.registerWorkflowTriggers(workflow);
    }
    
    // Start schedule checker for time-based workflows
    this.startScheduleChecker();
    
    console.log('[WorkflowService] Initialized successfully');
  }
  
  private async loadWorkflows() {
    try {
      const workflowMemories = await this.runtime.getMemories({
        tableName: 'workflows',
        agentId: this.runtime.agentId
      });
      
      for (const memory of workflowMemories) {
        if (memory.content?.type === 'workflow' && memory.content?.data) {
          const workflow = memory.content.data as Workflow;
          this.workflows.set(workflow.id, workflow);
        }
      }
      
      console.log(`[WorkflowService] Loaded ${this.workflows.size} workflows`);
    } catch (error) {
      console.error('[WorkflowService] Error loading workflows:', error);
    }
  }
  
  async registerWorkflow(workflow: Workflow): Promise<void> {
    // Validate workflow
    this.validateWorkflow(workflow);
    
    // Store in database
    const defaultUuid = '00000000-0000-0000-0000-000000000000' as UUID;
    await this.runtime.createMemory({
      id: workflow.id,
      content: { 
        type: 'workflow', 
        data: workflow,
        text: `Workflow: ${workflow.name} - ${workflow.description}`
      },
      entityId: this.runtime.agentId,
      roomId: defaultUuid,
      worldId: defaultUuid,
    }, 'workflows');
    
    // Register triggers
    this.workflows.set(workflow.id, workflow);
    await this.registerWorkflowTriggers(workflow);
    
    console.log(`[WorkflowService] Registered workflow: ${workflow.name} (${workflow.id})`);
  }
  
  private validateWorkflow(workflow: Workflow) {
    if (!workflow.id || !workflow.name || !workflow.steps || workflow.steps.length === 0) {
      throw new Error('Invalid workflow: missing required fields');
    }
    
    // Validate step references
    const stepIds = new Set(workflow.steps.map(s => s.id));
    
    for (const step of workflow.steps) {
      if (step.next && !stepIds.has(step.next)) {
        throw new Error(`Invalid workflow: step ${step.id} references non-existent next step ${step.next}`);
      }
      
      if (step.type === 'condition' && step.condition) {
        if (step.condition.then && !stepIds.has(step.condition.then)) {
          throw new Error(`Invalid workflow: condition step ${step.id} references non-existent then step ${step.condition.then}`);
        }
        if (step.condition.else && !stepIds.has(step.condition.else)) {
          throw new Error(`Invalid workflow: condition step ${step.id} references non-existent else step ${step.condition.else}`);
        }
      }
      
      if (step.type === 'parallel' && step.parallel) {
        for (const parallelStepId of step.parallel) {
          if (!stepIds.has(parallelStepId)) {
            throw new Error(`Invalid workflow: parallel step ${step.id} references non-existent step ${parallelStepId}`);
          }
        }
      }
    }
  }
  
  private async registerWorkflowTriggers(workflow: Workflow) {
    for (const trigger of workflow.triggers) {
      if (trigger.type === 'event' && trigger.event) {
        const events = Array.isArray(trigger.event) ? trigger.event : [trigger.event];
        
        for (const event of events) {
          // Track which workflows listen to which events
          if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
          }
          this.eventListeners.get(event)!.add(workflow.id);
          
          // Register deterministic handler that bypasses LLM
          this.runtime.registerEvent(event, async (payload) => {
            if (await this.evaluateTriggerConditions(trigger, payload)) {
              await this.executeWorkflow(workflow.id, {
                type: 'event',
                event,
                payload
              });
            }
          });
        }
      } else if (trigger.type === 'schedule' && trigger.schedule) {
        // Create cron job for scheduled triggers
        const task = cron.schedule(trigger.schedule, async () => {
          await this.executeWorkflow(workflow.id, {
            type: 'schedule',
            event: 'SCHEDULED_TRIGGER'
          });
        }, {
          scheduled: workflow.enabled
        });
        
        this.scheduledTasks.set(workflow.id, task);
      }
    }
  }
  
  private async evaluateTriggerConditions(trigger: WorkflowTrigger, payload: any): Promise<boolean> {
    if (!trigger.conditions || trigger.conditions.length === 0) {
      return true;
    }
    
    for (const condition of trigger.conditions) {
      if (!await this.evaluateCondition(condition, payload)) {
        return false;
      }
    }
    
    return true;
  }
  
  async evaluateCondition(condition: WorkflowCondition, context: any): Promise<boolean> {
    try {
      const value = JSONPath({ path: condition.field, json: context })[0];
      
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
      this.runtime.logger.error('[WorkflowService] Error evaluating condition:', error);
      return false;
    }
  }
  
  async executeWorkflow(
    workflowId: UUID, 
    trigger: WorkflowExecution['trigger'],
    inputs?: Record<string, any>
  ): Promise<WorkflowExecution> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || !workflow.enabled) {
      throw new Error(`Workflow ${workflowId} not found or disabled`);
    }
    
    // Create execution record
    const execution: WorkflowExecution = {
      id: uuidv4() as UUID,
      workflowId,
      status: 'running',
      trigger,
      context: {
        ...workflow.inputs,
        ...inputs,
        trigger: trigger.payload,
        _workflow: { id: workflow.id, name: workflow.name }
      },
      startedAt: Date.now()
    };
    
    this.executions.set(execution.id, execution);
    
    // Emit execution started event
    this.runtime.emitEvent('WORKFLOW_EXECUTION_STARTED', {
      workflowId,
      executionId: execution.id,
      trigger
    });
    
    // Execute workflow
    try {
      const result = await this.executionEngine.execute(workflow, execution);
      
      execution.status = 'completed';
      execution.completedAt = Date.now();
      execution.outputs = result;
      
      // Store execution record
      await this.runtime.createMemory({
        id: execution.id,
        content: {
          type: 'workflow_execution',
          data: execution,
          text: `Workflow execution: ${workflow.name} - ${execution.status}`
        },
        entityId: this.runtime.agentId,
        roomId: null,
        worldId: null,
      } as Memory, 'workflow_executions');
      
      // Emit completion event
      this.runtime.emitEvent('WORKFLOW_EXECUTION_COMPLETED', {
        workflowId,
        executionId: execution.id,
        outputs: result
      });
      
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : String(error);
      execution.completedAt = Date.now();
      
      // Store failed execution record
      await this.runtime.createMemory({
        id: execution.id,
        content: {
          type: 'workflow_execution',
          data: execution,
          text: `Workflow execution failed: ${workflow.name} - ${execution.error}`
        },
        entityId: this.runtime.agentId,
        roomId: null,
        worldId: null,
      } as Memory, 'workflow_executions');
      
      // Emit failure event
      this.runtime.emitEvent('WORKFLOW_EXECUTION_FAILED', {
        workflowId,
        executionId: execution.id,
        error: execution.error
      });
    }
    
    return execution;
  }
  
  private startScheduleChecker() {
    // Schedule checker runs every minute to check for scheduled workflows
    setInterval(() => {
      for (const [workflowId, task] of this.scheduledTasks) {
        const workflow = this.workflows.get(workflowId);
        if (workflow && workflow.enabled && !task.getStatus()) {
          task.start();
        } else if (workflow && !workflow.enabled && task.getStatus()) {
          task.stop();
        }
      }
    }, 60000); // Check every minute
  }
  
  async getApplicableWorkflows(message: Memory): Promise<Workflow[]> {
    const applicableWorkflows: Workflow[] = [];
    
    // Check MESSAGE_RECEIVED event workflows
    const messageWorkflowIds = this.eventListeners.get('MESSAGE_RECEIVED') || new Set();
    
    for (const workflowId of messageWorkflowIds) {
      const workflow = this.workflows.get(workflowId);
      if (!workflow || !workflow.enabled) continue;
      
      // Check if trigger conditions are met
      const trigger = workflow.triggers.find(t => 
        t.type === 'event' && 
        (t.event === 'MESSAGE_RECEIVED' || 
         (Array.isArray(t.event) && t.event.includes('MESSAGE_RECEIVED')))
      );
      
      if (trigger && await this.evaluateTriggerConditions(trigger, message)) {
        applicableWorkflows.push(workflow);
      }
    }
    
    return applicableWorkflows;
  }
  
  async updateWorkflow(workflowId: UUID, updates: Partial<Workflow>): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }
    
    const updatedWorkflow = { ...workflow, ...updates };
    this.workflows.set(workflowId, updatedWorkflow);
    
    // Update in database
    await this.runtime.updateMemory({
      id: workflowId,
      content: {
        type: 'workflow',
        data: updatedWorkflow,
        text: `Workflow: ${updatedWorkflow.name} - ${updatedWorkflow.description}`
      }
    });
    
    // Re-register triggers if needed
    if (updates.triggers || updates.enabled !== undefined) {
      // Unregister old triggers
      if (this.scheduledTasks.has(workflowId)) {
        this.scheduledTasks.get(workflowId)!.stop();
        this.scheduledTasks.delete(workflowId);
      }
      
      // Re-register if enabled
      if (updatedWorkflow.enabled) {
        await this.registerWorkflowTriggers(updatedWorkflow);
      }
    }
  }
  
  async getWorkflow(workflowId: UUID): Promise<Workflow | undefined> {
    return this.workflows.get(workflowId);
  }
  
  async listWorkflows(): Promise<Workflow[]> {
    return Array.from(this.workflows.values());
  }
  
  async getExecution(executionId: UUID): Promise<WorkflowExecution | undefined> {
    return this.executions.get(executionId);
  }
  
  async stop(): Promise<void> {
    // Stop all scheduled tasks
    for (const task of this.scheduledTasks.values()) {
      task.stop();
    }
    this.scheduledTasks.clear();
    
    // Clear event listeners
    this.eventListeners.clear();
    
    this.runtime.logger.info('[WorkflowService] Stopped');
  }
} 
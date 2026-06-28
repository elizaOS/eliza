import type {
  CreateLifeOpsWorkflowRequest,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  UpdateLifeOpsWorkflowRequest,
} from "../contracts/index.js";
import {
  matchesCalendarEventEndedFilters,
  type WorkflowsDeps,
  WorkflowsDomain,
} from "./domains/workflows-service.js";
import type { WorkflowStepExecuteContext } from "./registries/workflow-step-registry.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export { matchesCalendarEventEndedFilters };

export interface LifeOpsWorkflowService {
  listWorkflows(): Promise<LifeOpsWorkflowRecord[]>;
  getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord>;
  createWorkflow(
    request: CreateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord>;
  updateWorkflow(
    workflowId: string,
    request: UpdateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord>;
  runWorkflow(
    workflowId: string,
    request?: { now?: string; confirmBrowserActions?: boolean },
  ): Promise<LifeOpsWorkflowRun>;
}

export function withWorkflows<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsWorkflowService> {
  class LifeOpsWorkflowServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly workflowsDomain = new WorkflowsDomain(this, {
      recordWorkflowAudit: (...args) => this.recordWorkflowAudit(...args),
      getWorkflowDefinition: (...args) => this.getWorkflowDefinition(...args),
      readEffectiveScheduleState: (...args) =>
        (this as unknown as WorkflowsDeps).readEffectiveScheduleState(...args),
      emitWorkflowRunNudge: (...args) =>
        (this as unknown as WorkflowsDeps).emitWorkflowRunNudge(...args),
      // Workflow-step contributions reach across many domains, so the
      // execution context is the fully composed service instance, not the
      // workflows sub-service.
      workflowStepContext: this as unknown as WorkflowStepExecuteContext,
    });

    listWorkflows(): Promise<LifeOpsWorkflowRecord[]> {
      return this.workflowsDomain.listWorkflows();
    }

    getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord> {
      return this.workflowsDomain.getWorkflow(workflowId);
    }

    createWorkflow(
      request: CreateLifeOpsWorkflowRequest,
    ): Promise<LifeOpsWorkflowRecord> {
      return this.workflowsDomain.createWorkflow(request);
    }

    updateWorkflow(
      workflowId: string,
      request: UpdateLifeOpsWorkflowRequest,
    ): Promise<LifeOpsWorkflowRecord> {
      return this.workflowsDomain.updateWorkflow(workflowId, request);
    }

    runWorkflow(
      workflowId: string,
      request: { now?: string; confirmBrowserActions?: boolean } = {},
    ): Promise<LifeOpsWorkflowRun> {
      return this.workflowsDomain.runWorkflow(workflowId, request);
    }

    // Consumed by the reminders scheduler via the composed instance.
    runDueWorkflows(
      args: Parameters<WorkflowsDomain["runDueWorkflows"]>[0],
    ): Promise<LifeOpsWorkflowRun[]> {
      return this.workflowsDomain.runDueWorkflows(args);
    }

    runDueEventWorkflows(
      args: Parameters<WorkflowsDomain["runDueEventWorkflows"]>[0],
    ): Promise<LifeOpsWorkflowRun[]> {
      return this.workflowsDomain.runDueEventWorkflows(args);
    }
  }

  return LifeOpsWorkflowServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsWorkflowService
  >;
}

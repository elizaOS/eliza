/** Barrel for native embedded execution, dispatch, and the WorkflowService facade. */
export {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from './embedded-workflow-service';
export {
  createWorkflowDispatchService,
  registerWorkflowDispatchService,
  WORKFLOW_DISPATCH_SERVICE_TYPE,
  type WorkflowDispatchResult,
  type WorkflowDispatchService,
} from './workflow-dispatch';
export {
  WORKFLOW_SERVICE_TYPE,
  WorkflowService,
  type WorkflowServiceConfig,
} from './workflow-service';

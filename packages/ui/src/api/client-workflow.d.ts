/**
 * Workflow domain methods — status, workflow CRUD.
 *
 * All routes hit `/api/workflow/*` on the local agent server.
 * The workflow CRUD routes are served by the workflow plugin itself
 * but exposed through the same base URL via the plugin's route registration.
 */
import type {
  WorkflowDefinition,
  WorkflowDefinitionGenerateRequest,
  WorkflowDefinitionGenerateResponse,
  WorkflowDefinitionResolveClarificationRequest,
  WorkflowDefinitionWriteRequest,
  WorkflowExecution,
  WorkflowStatusResponse,
} from "./client-types-chat";

declare module "./client-base" {
  interface ElizaClient {
    getWorkflowStatus(): Promise<WorkflowStatusResponse>;
    getWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    listWorkflowDefinitions(): Promise<WorkflowDefinition[]>;
    createWorkflowDefinition(
      request: WorkflowDefinitionWriteRequest,
    ): Promise<WorkflowDefinition>;
    updateWorkflowDefinition(
      id: string,
      request: WorkflowDefinitionWriteRequest,
    ): Promise<WorkflowDefinition>;
    generateWorkflowDefinition(
      request: WorkflowDefinitionGenerateRequest,
    ): Promise<WorkflowDefinitionGenerateResponse>;
    resolveWorkflowClarification(
      request: WorkflowDefinitionResolveClarificationRequest,
    ): Promise<WorkflowDefinitionGenerateResponse>;
    activateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deactivateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deleteWorkflowDefinition(id: string): Promise<{
      ok: boolean;
    }>;
    getWorkflowExecutions(
      id: string,
      limit?: number,
    ): Promise<WorkflowExecution[]>;
  }
}
//# sourceMappingURL=client-workflow.d.ts.map

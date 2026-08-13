/**
 * Workflow domain methods — status, workflow CRUD.
 *
 * All routes hit `/api/workflow/*`, served by plugin-workflow's route
 * registration. Requests go through `workflowSurfaceClient` so a mobile device
 * whose bundled runtime cannot host plugin-workflow serves the surface from its
 * linked Cloud agent instead of dead-ending on a 404.
 */

import { ElizaClient } from "./client-base";
import type {
  WorkflowDefinition,
  WorkflowDefinitionWriteRequest,
  WorkflowEvaluationSuite,
  WorkflowExecution,
  WorkflowRevision,
  WorkflowStatusResponse,
} from "./client-types-chat";
import { workflowSurfaceClient } from "./workflow-surface-routing";

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

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
    activateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deactivateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deleteWorkflowDefinition(id: string): Promise<{ ok: boolean }>;
    runWorkflowDefinition(
      id: string,
      input?: Record<string, unknown>,
    ): Promise<WorkflowExecution>;
    getWorkflowExecutions(
      id: string,
      limit?: number,
    ): Promise<WorkflowExecution[]>;
    getWorkflowExecution(id: string): Promise<WorkflowExecution>;
    cancelWorkflowExecution(id: string): Promise<WorkflowExecution>;
    decideWorkflowApproval(
      runId: string,
      nodeId: string,
      iteration: number,
      approved: boolean,
      decision?: unknown,
    ): Promise<WorkflowExecution>;
    signalWorkflowExecution(
      runId: string,
      signal: string,
      payload?: unknown,
    ): Promise<WorkflowExecution>;
    getWorkflowEvaluationSamples(
      id: string,
      limit?: number,
    ): Promise<WorkflowEvaluationSuite>;
    getWorkflowRevisions(
      id: string,
      limit?: number,
    ): Promise<{
      currentVersionId: string | null;
      revisions: WorkflowRevision[];
    }>;
    restoreWorkflowRevision(
      id: string,
      versionId: string,
    ): Promise<WorkflowDefinition>;
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

ElizaClient.prototype.getWorkflowStatus = async function (
  this: ElizaClient,
): Promise<WorkflowStatusResponse> {
  return workflowSurfaceClient(this).fetch<WorkflowStatusResponse>(
    "/api/workflow/status",
  );
};

ElizaClient.prototype.getWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
  );
};

ElizaClient.prototype.listWorkflowDefinitions = async function (
  this: ElizaClient,
): Promise<WorkflowDefinition[]> {
  const res = await workflowSurfaceClient(this).fetch<{
    workflows: WorkflowDefinition[];
  }>("/api/workflow/workflows");
  return res.workflows ?? [];
};

ElizaClient.prototype.createWorkflowDefinition = async function (
  this: ElizaClient,
  request: WorkflowDefinitionWriteRequest,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    "/api/workflow/workflows",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
};

ElizaClient.prototype.updateWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
  request: WorkflowDefinitionWriteRequest,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
};

ElizaClient.prototype.activateWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/activate`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.deactivateWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/deactivate`,
    { method: "POST" },
  );
};

ElizaClient.prototype.deleteWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<{ ok: boolean }> {
  return workflowSurfaceClient(this).fetch<{ ok: boolean }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.runWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
  input?: Record<string, unknown>,
): Promise<WorkflowExecution> {
  const result = await workflowSurfaceClient(this).fetch<{
    execution?: WorkflowExecution;
  }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/run`,
    {
      method: "POST",
      body: JSON.stringify({ input: input ?? {} }),
    },
    // This route owns 202 as "execution accepted". Bypass the generic
    // dedicated-agent resume loop or the same workflow POST is retried.
    { timeoutMs: 30_000, skipResume: true },
  );
  if (!result.execution) {
    throw new Error("Workflow run response did not include an execution.");
  }
  return result.execution;
};

ElizaClient.prototype.getWorkflowExecutions = async function (
  this: ElizaClient,
  id: string,
  limit = 10,
): Promise<WorkflowExecution[]> {
  const result = await workflowSurfaceClient(this).fetch<{
    executions?: WorkflowExecution[];
  }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/executions?limit=${limit}`,
  );
  return result.executions ?? [];
};

ElizaClient.prototype.getWorkflowExecution = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowExecution> {
  const result = await workflowSurfaceClient(this).fetch<{
    execution?: WorkflowExecution;
  }>(`/api/workflow/executions/${encodeURIComponent(id)}`);
  if (!result.execution) {
    throw new Error(
      "Workflow execution response did not include an execution.",
    );
  }
  return result.execution;
};

ElizaClient.prototype.cancelWorkflowExecution = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowExecution> {
  const result = await workflowSurfaceClient(this).fetch<{
    execution?: WorkflowExecution;
  }>(`/api/workflow/executions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  if (!result.execution) {
    throw new Error(
      "Workflow cancellation response did not include an execution.",
    );
  }
  return result.execution;
};

ElizaClient.prototype.decideWorkflowApproval = async function (
  this: ElizaClient,
  runId: string,
  nodeId: string,
  iteration: number,
  approved: boolean,
  decision?: unknown,
): Promise<WorkflowExecution> {
  const result = await workflowSurfaceClient(this).fetch<{
    execution?: WorkflowExecution;
  }>(
    `/api/workflow/executions/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}/${iteration}`,
    { method: "POST", body: JSON.stringify({ approved, decision }) },
  );
  if (!result.execution)
    throw new Error("Approval response did not include an execution.");
  return result.execution;
};

ElizaClient.prototype.signalWorkflowExecution = async function (
  this: ElizaClient,
  runId: string,
  signal: string,
  payload?: unknown,
): Promise<WorkflowExecution> {
  const result = await workflowSurfaceClient(this).fetch<{
    execution?: WorkflowExecution;
  }>(
    `/api/workflow/executions/${encodeURIComponent(runId)}/signals/${encodeURIComponent(signal)}`,
    { method: "POST", body: JSON.stringify({ payload }) },
  );
  if (!result.execution)
    throw new Error("Signal response did not include an execution.");
  return result.execution;
};

ElizaClient.prototype.getWorkflowEvaluationSamples = async function (
  this: ElizaClient,
  id: string,
  limit = 10,
): Promise<WorkflowEvaluationSuite> {
  return workflowSurfaceClient(this).fetch<WorkflowEvaluationSuite>(
    `/api/workflow/workflows/${encodeURIComponent(
      id,
    )}/evaluation-samples?limit=${limit}`,
  );
};

ElizaClient.prototype.getWorkflowRevisions = async function (
  this: ElizaClient,
  id: string,
  limit = 20,
): Promise<{
  currentVersionId: string | null;
  revisions: WorkflowRevision[];
}> {
  const result = await workflowSurfaceClient(this).fetch<{
    currentVersionId?: string | null;
    revisions?: WorkflowRevision[];
  }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/revisions?limit=${limit}`,
  );
  return {
    currentVersionId: result.currentVersionId ?? null,
    revisions: result.revisions ?? [],
  };
};

ElizaClient.prototype.restoreWorkflowRevision = async function (
  this: ElizaClient,
  id: string,
  versionId: string,
): Promise<WorkflowDefinition> {
  return workflowSurfaceClient(this).fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(
      versionId,
    )}/restore`,
    { method: "POST" },
  );
};

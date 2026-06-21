/**
 * Workflow domain methods — status, workflow CRUD.
 *
 * All routes hit `/api/workflow/*` on the local agent server.
 * The workflow CRUD routes are served by the workflow plugin itself
 * but exposed through the same base URL via the plugin's route registration.
 */

import { ElizaClient } from "./client-base";
import type {
  WorkflowDefinition,
  WorkflowDefinitionGenerateRequest,
  WorkflowDefinitionGenerateResponse,
  WorkflowDefinitionResolveClarificationRequest,
  WorkflowDefinitionWriteRequest,
  WorkflowEvaluationSuite,
  WorkflowExecution,
  WorkflowRevision,
  WorkflowStatusResponse,
} from "./client-types-chat";

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
    generateWorkflowDefinition(
      request: WorkflowDefinitionGenerateRequest,
    ): Promise<WorkflowDefinitionGenerateResponse>;
    resolveWorkflowClarification(
      request: WorkflowDefinitionResolveClarificationRequest,
    ): Promise<WorkflowDefinitionGenerateResponse>;
    activateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deactivateWorkflowDefinition(id: string): Promise<WorkflowDefinition>;
    deleteWorkflowDefinition(id: string): Promise<{ ok: boolean }>;
    runWorkflowDefinition(id: string): Promise<WorkflowExecution>;
    getWorkflowExecutions(
      id: string,
      limit?: number,
    ): Promise<WorkflowExecution[]>;
    getWorkflowExecution(id: string): Promise<WorkflowExecution>;
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
  return this.fetch<WorkflowStatusResponse>("/api/workflow/status");
};

ElizaClient.prototype.getWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowDefinition> {
  return this.fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
  );
};

ElizaClient.prototype.listWorkflowDefinitions = async function (
  this: ElizaClient,
): Promise<WorkflowDefinition[]> {
  const res = await this.fetch<{ workflows: WorkflowDefinition[] }>(
    "/api/workflow/workflows",
  );
  return res.workflows ?? [];
};

ElizaClient.prototype.createWorkflowDefinition = async function (
  this: ElizaClient,
  request: WorkflowDefinitionWriteRequest,
): Promise<WorkflowDefinition> {
  return this.fetch<WorkflowDefinition>("/api/workflow/workflows", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.updateWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
  request: WorkflowDefinitionWriteRequest,
): Promise<WorkflowDefinition> {
  return this.fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
};

ElizaClient.prototype.generateWorkflowDefinition = async function (
  this: ElizaClient,
  request: WorkflowDefinitionGenerateRequest,
): Promise<WorkflowDefinitionGenerateResponse> {
  // LLM-driven workflow generation runs keyword extraction, node search,
  // generation, multiple correction passes, and feasibility assessment
  // sequentially — easily 30-90s on a cold cache. The 10s default fetch
  // timeout is far too aggressive and surfaces as
  // "Request timed out after 10000ms" in the Automations UI even when
  // the backend would have succeeded a few seconds later.
  return this.fetch<WorkflowDefinitionGenerateResponse>(
    "/api/workflow/workflows/generate",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.resolveWorkflowClarification = async function (
  this: ElizaClient,
  request: WorkflowDefinitionResolveClarificationRequest,
): Promise<WorkflowDefinitionGenerateResponse> {
  // Patch + deploy is server-side and synchronous from the user's view, but
  // it still runs validateAndRepair + a deploy round-trip. Reuse the same
  // generous timeout as the generate call so a slow workflow write does not
  // surface as a misleading "Request timed out" toast.
  return this.fetch<WorkflowDefinitionGenerateResponse>(
    "/api/workflow/workflows/resolve-clarification",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.activateWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowDefinition> {
  return this.fetch<WorkflowDefinition>(
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
  return this.fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/deactivate`,
    { method: "POST" },
  );
};

ElizaClient.prototype.deleteWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.runWorkflowDefinition = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowExecution> {
  const result = await this.fetch<{
    execution?: WorkflowExecution;
  }>(`/api/workflow/workflows/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
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
  const result = await this.fetch<{ executions?: WorkflowExecution[] }>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/executions?limit=${limit}`,
  );
  return result.executions ?? [];
};

ElizaClient.prototype.getWorkflowExecution = async function (
  this: ElizaClient,
  id: string,
): Promise<WorkflowExecution> {
  const result = await this.fetch<{
    execution?: WorkflowExecution;
  }>(`/api/workflow/executions/${encodeURIComponent(id)}`);
  if (!result.execution) {
    throw new Error(
      "Workflow execution response did not include an execution.",
    );
  }
  return result.execution;
};

ElizaClient.prototype.getWorkflowEvaluationSamples = async function (
  this: ElizaClient,
  id: string,
  limit = 10,
): Promise<WorkflowEvaluationSuite> {
  return this.fetch<WorkflowEvaluationSuite>(
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
  const result = await this.fetch<{
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
  return this.fetch<WorkflowDefinition>(
    `/api/workflow/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(
      versionId,
    )}/restore`,
    { method: "POST" },
  );
};

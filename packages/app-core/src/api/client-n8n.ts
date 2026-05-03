/**
 * n8n domain methods — status, workflow CRUD, sidecar start.
 *
 * All routes hit `/api/n8n/*` on the local agent server.
 * The workflow CRUD routes are served by the n8n plugin itself
 * but exposed through the same base URL via the plugin's route registration.
 */

import { ElizaClient } from "./client-base";
import type {
  N8nStatusResponse,
  N8nWorkflow,
  N8nWorkflowGenerateRequest,
  N8nWorkflowGenerateResponse,
  N8nWorkflowResolveClarificationRequest,
  N8nWorkflowWriteRequest,
} from "./client-types-chat";

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    getN8nStatus(): Promise<N8nStatusResponse>;
    getN8nWorkflow(id: string): Promise<N8nWorkflow>;
    listN8nWorkflows(): Promise<N8nWorkflow[]>;
    createN8nWorkflow(request: N8nWorkflowWriteRequest): Promise<N8nWorkflow>;
    updateN8nWorkflow(
      id: string,
      request: N8nWorkflowWriteRequest,
    ): Promise<N8nWorkflow>;
    generateN8nWorkflow(
      request: N8nWorkflowGenerateRequest,
    ): Promise<N8nWorkflowGenerateResponse>;
    resolveN8nClarification(
      request: N8nWorkflowResolveClarificationRequest,
    ): Promise<N8nWorkflowGenerateResponse>;
    activateN8nWorkflow(id: string): Promise<N8nWorkflow>;
    deactivateN8nWorkflow(id: string): Promise<N8nWorkflow>;
    deleteN8nWorkflow(id: string): Promise<{ ok: boolean }>;
    startN8nSidecar(): Promise<{ ok: boolean }>;
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

ElizaClient.prototype.getN8nStatus = async function (
  this: ElizaClient,
): Promise<N8nStatusResponse> {
  return this.fetch<N8nStatusResponse>("/api/n8n/status");
};

ElizaClient.prototype.getN8nWorkflow = async function (
  this: ElizaClient,
  id: string,
): Promise<N8nWorkflow> {
  return this.fetch<N8nWorkflow>(
    `/api/n8n/workflows/${encodeURIComponent(id)}`,
  );
};

ElizaClient.prototype.listN8nWorkflows = async function (
  this: ElizaClient,
): Promise<N8nWorkflow[]> {
  const res = await this.fetch<{ workflows: N8nWorkflow[] }>(
    "/api/n8n/workflows",
  );
  return res.workflows ?? [];
};

ElizaClient.prototype.createN8nWorkflow = async function (
  this: ElizaClient,
  request: N8nWorkflowWriteRequest,
): Promise<N8nWorkflow> {
  return this.fetch<N8nWorkflow>("/api/n8n/workflows", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.updateN8nWorkflow = async function (
  this: ElizaClient,
  id: string,
  request: N8nWorkflowWriteRequest,
): Promise<N8nWorkflow> {
  return this.fetch<N8nWorkflow>(
    `/api/n8n/workflows/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
};

ElizaClient.prototype.generateN8nWorkflow = async function (
  this: ElizaClient,
  request: N8nWorkflowGenerateRequest,
): Promise<N8nWorkflowGenerateResponse> {
  // LLM-driven workflow generation runs keyword extraction, node search,
  // generation, multiple correction passes, and feasibility assessment
  // sequentially — easily 30-90s on a cold cache. The 10s default fetch
  // timeout is far too aggressive and surfaces as
  // "Request timed out after 10000ms" in the Automations UI even when
  // the backend would have succeeded a few seconds later.
  return this.fetch<N8nWorkflowGenerateResponse>(
    "/api/n8n/workflows/generate",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.resolveN8nClarification = async function (
  this: ElizaClient,
  request: N8nWorkflowResolveClarificationRequest,
): Promise<N8nWorkflowGenerateResponse> {
  // Patch + deploy is server-side and synchronous from the user's view, but
  // it still runs validateAndRepair + a deploy round-trip. Reuse the same
  // generous timeout as the generate call so a slow n8n write does not
  // surface as a misleading "Request timed out" toast.
  return this.fetch<N8nWorkflowGenerateResponse>(
    "/api/n8n/workflows/resolve-clarification",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    { timeoutMs: 120_000 },
  );
};

ElizaClient.prototype.activateN8nWorkflow = async function (
  this: ElizaClient,
  id: string,
): Promise<N8nWorkflow> {
  return this.fetch<N8nWorkflow>(
    `/api/n8n/workflows/${encodeURIComponent(id)}/activate`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.deactivateN8nWorkflow = async function (
  this: ElizaClient,
  id: string,
): Promise<N8nWorkflow> {
  return this.fetch<N8nWorkflow>(
    `/api/n8n/workflows/${encodeURIComponent(id)}/deactivate`,
    { method: "POST" },
  );
};

ElizaClient.prototype.deleteN8nWorkflow = async function (
  this: ElizaClient,
  id: string,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>(
    `/api/n8n/workflows/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.startN8nSidecar = async function (
  this: ElizaClient,
): Promise<{ ok: boolean }> {
  return this.fetch<{ ok: boolean }>("/api/n8n/sidecar/start", {
    method: "POST",
  });
};

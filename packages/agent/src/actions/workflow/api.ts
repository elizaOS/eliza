/**
 * Shared HTTP helpers for n8n workflow actions.
 *
 * Workflow CRUD lives in the app-core HTTP layer (n8n-routes.ts) and proxies
 * out to the local n8n sidecar or to Eliza Cloud. The agent runtime does not
 * own a workflow service, so these actions reach back into the local API
 * server the same way app-control.ts does.
 */

import { resolveServerOnlyPort } from "@elizaos/shared";

export function getApiBase(): string {
  const port = resolveServerOnlyPort(process.env);
  return `http://localhost:${port}`;
}

export interface WorkflowDefinitionResponse {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  nodeCount?: number;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T | null; raw: string }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const raw = await response.text();
  let data: T | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data, raw };
}

export async function findWorkflowById(
  workflowId: string,
): Promise<WorkflowDefinitionResponse | null> {
  const base = getApiBase();
  const result = await fetchJson<WorkflowDefinitionResponse>(
    `${base}/api/workflow/workflows/${encodeURIComponent(workflowId)}`,
    { method: "GET" },
  );
  if (result.status === 404) return null;
  if (!result.ok || !result.data) return null;
  return result.data;
}

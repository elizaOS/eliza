/**
 * Workflow dispatch service — executes a workflow by id via the in-process
 * EmbeddedWorkflowService registered by `@elizaos/plugin-workflow`.
 *
 * Consumed by the trigger dispatcher (Track F1) at boot: triggers carrying
 * `kind: "workflow"` resolve a workflow id and call
 *   runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
 *
 * The dispatch service is a thin routing layer — it looks up the embedded
 * workflow service on the runtime and delegates to its `executeWorkflow`
 * method. There is no HTTP boundary, no auth, no sidecar lifecycle.
 */

import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

const EMBEDDED_WORKFLOW_SERVICE_TYPE = "embedded_workflow_service";

export interface N8nDispatchResult {
  ok: boolean;
  error?: string;
  executionId?: string;
}

export interface N8nDispatchService {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>,
  ): Promise<N8nDispatchResult>;
}

interface EmbeddedWorkflowServiceLike {
  executeWorkflow(
    id: string,
    options?: { mode?: string },
  ): Promise<{ id?: string }>;
}

export interface CreateN8nDispatchServiceOptions {
  runtime: AgentRuntime;
}

function resolveEmbeddedService(
  runtime: AgentRuntime,
): EmbeddedWorkflowServiceLike | null {
  const service = runtime.getService?.(EMBEDDED_WORKFLOW_SERVICE_TYPE) as
    | EmbeddedWorkflowServiceLike
    | null
    | undefined;
  if (service && typeof service.executeWorkflow === "function") {
    return service;
  }
  return null;
}

/**
 * Construct the dispatch service. The returned value is registered under
 * `"WORKFLOW_DISPATCH"` on the runtime by `ensureN8nDispatchService` in
 * runtime/eliza.ts.
 */
export function createN8nDispatchService(
  options: CreateN8nDispatchServiceOptions,
): N8nDispatchService {
  const { runtime } = options;

  const execute = async (
    workflowId: string,
    _payload: Record<string, unknown> = {},
  ): Promise<N8nDispatchResult> => {
    const id = workflowId.trim();
    if (!id) {
      return { ok: false, error: "workflow id required" };
    }

    const service = resolveEmbeddedService(runtime);
    if (!service) {
      return { ok: false, error: "embedded workflow service not registered" };
    }

    try {
      const execution = await service.executeWorkflow(id, { mode: "trigger" });
      return execution.id
        ? { ok: true, executionId: execution.id }
        : { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[workflow-dispatch] execution failed for ${id}: ${message}`);
      return { ok: false, error: message };
    }
  };

  return { execute };
}

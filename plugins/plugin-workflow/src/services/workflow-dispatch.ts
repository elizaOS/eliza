/**
 * Workflow dispatch service - executes a workflow by id via the in-process
 * EmbeddedWorkflowService registered by `@elizaos/plugin-workflow`.
 *
 * Consumed by the trigger dispatcher: triggers carrying `kind: "workflow"`
 * resolve a workflow id and call
 *   runtime.getService("WORKFLOW_DISPATCH").execute(workflowId).
 *
 * Registered into the runtime services map by the plugin's `init` (see
 * `plugins/plugin-workflow/src/index.ts`).
 *
 * The dispatch service is a thin routing layer - it looks up the embedded
 * workflow service on the runtime and delegates to its `executeWorkflow`
 * method. There is no HTTP boundary and no sidecar lifecycle.
 */

import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from './embedded-workflow-service';

export const WORKFLOW_DISPATCH_SERVICE_TYPE = 'WORKFLOW_DISPATCH' as const;

export interface WorkflowDispatchResult {
  ok: boolean;
  error?: string;
  executionId?: string;
}

export interface WorkflowDispatchService {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>
  ): Promise<WorkflowDispatchResult>;
}

interface WorkflowDispatchServiceEntry extends WorkflowDispatchService {
  stop(): Promise<void>;
  capabilityDescription: string;
}

interface RuntimeServiceRegistry {
  set(serviceType: string, services: WorkflowDispatchServiceEntry[]): void;
}

function resolveEmbeddedService(
  runtime: IAgentRuntime
): EmbeddedWorkflowService | null {
  const service = runtime.getService<EmbeddedWorkflowService>(
    EMBEDDED_WORKFLOW_SERVICE_TYPE
  );
  if (service && typeof service.executeWorkflow === 'function') {
    return service;
  }
  return null;
}

function getRuntimeServiceRegistry(
  runtime: IAgentRuntime
): RuntimeServiceRegistry | null {
  const services: unknown = Reflect.get(runtime, 'services');
  if (!services || typeof services !== 'object') {
    return null;
  }

  const set: unknown = Reflect.get(services, 'set');
  if (typeof set !== 'function') {
    return null;
  }

  return {
    set(serviceType, serviceEntries) {
      Reflect.apply(set, services, [serviceType, serviceEntries]);
    },
  };
}

/**
 * Construct the dispatch service. Registered under `WORKFLOW_DISPATCH` on the
 * runtime by the plugin's `init` lifecycle hook.
 */
export function createWorkflowDispatchService(
  runtime: IAgentRuntime
): WorkflowDispatchService {
  return {
    async execute(
      workflowId: string,
      _payload: Record<string, unknown> = {}
    ): Promise<WorkflowDispatchResult> {
      const id = workflowId.trim();
      if (!id) {
        return { ok: false, error: 'workflow id required' };
      }
      const service = resolveEmbeddedService(runtime);
      if (!service) {
        return { ok: false, error: 'embedded workflow service not registered' };
      }
      try {
        const execution = await service.executeWorkflow(id, { mode: 'trigger' });
        return execution.id
          ? { ok: true, executionId: execution.id }
          : { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { src: 'plugin:workflow:dispatch' },
          `Workflow execution failed for ${id}: ${message}`
        );
        return { ok: false, error: message };
      }
    },
  };
}

/**
 * Register the dispatch service in the runtime services map under
 * `WORKFLOW_DISPATCH`. Called from the plugin's `init`.
 *
 * The runtime's `registerService(ServiceClass)` API expects a class with a
 * static `start()`. The dispatch is a closure-based singleton, so we set the
 * services map slot directly (mirrors `runtime/plugin-lifecycle.ts` and
 * `test/scripts/*.ts`).
 */
export function registerWorkflowDispatchService(runtime: IAgentRuntime): void {
  const dispatch = createWorkflowDispatchService(runtime);
  const serviceEntry: WorkflowDispatchServiceEntry = {
    execute: dispatch.execute,
    stop: async () => {},
    capabilityDescription:
      'Executes embedded workflows by id via the in-process workflow service.',
  };
  getRuntimeServiceRegistry(runtime)?.set(WORKFLOW_DISPATCH_SERVICE_TYPE, [
    serviceEntry,
  ]);
}

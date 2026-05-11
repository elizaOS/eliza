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
  /**
   * True when the call was short-circuited by an idempotency-key match.
   * Callers (the trigger dispatcher, dashboards) can record a dedup
   * instead of treating the call as a fresh execution.
   */
  dedup?: boolean;
}

/**
 * Optional, structured dispatch options. The `idempotencyKey` field is
 * the durable contract: same workflow + same key → at most one
 * execution. Passed inline through the legacy `payload` shape (key
 * `__idempotencyKey`) when the caller can't pass a second argument.
 */
export interface WorkflowDispatchOptions {
  triggerData?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface WorkflowDispatchService {
  execute(
    workflowId: string,
    payload?: Record<string, unknown>,
    options?: WorkflowDispatchOptions
  ): Promise<WorkflowDispatchResult>;
}

interface WorkflowDispatchServiceEntry extends WorkflowDispatchService {
  stop(): Promise<void>;
  capabilityDescription: string;
}

/**
 * Pull `__idempotencyKey` out of the legacy `payload` shape so existing
 * callers (the trigger dispatcher's `event` payload) can attach a key
 * without growing the signature. The wrapper key is stripped before the
 * payload is forwarded as `triggerData`.
 */
function partitionPayload(payload: Record<string, unknown> | undefined): {
  triggerData: Record<string, unknown>;
  idempotencyKey?: string;
} {
  if (!payload) return { triggerData: {} };
  const { __idempotencyKey, ...rest } = payload;
  return {
    triggerData: rest,
    idempotencyKey: typeof __idempotencyKey === 'string' ? __idempotencyKey : undefined,
  };
}

interface RuntimeServiceRegistry {
  set(serviceType: string, services: WorkflowDispatchServiceEntry[]): void;
}

function resolveEmbeddedService(runtime: IAgentRuntime): EmbeddedWorkflowService | null {
  const service = runtime.getService<EmbeddedWorkflowService>(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  if (service && typeof service.executeWorkflow === 'function') {
    return service;
  }
  return null;
}

function getRuntimeServiceRegistry(runtime: IAgentRuntime): RuntimeServiceRegistry | null {
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
 *
 * Idempotency contract: when a caller passes an `idempotencyKey` (either via
 * the explicit `options.idempotencyKey` or via the legacy
 * `payload.__idempotencyKey`), the dispatch service first looks up an
 * existing execution row for `(workflowId, idempotencyKey)`. If one exists,
 * the new run is suppressed and the prior execution id is returned with
 * `{ ok: true, dedup: true }`. Scheduled workflow dispatches use a
 * minute-bucketed key so two simultaneous schedule fires collapse to one
 * execution.
 *
 * Concurrent dispatches that race past the lookup are still safely
 * coalesced because the embedded service persists the idempotency key on
 * the execution row, so the second-to-write completes but is detectable
 * as a duplicate on future lookups.
 */
export function createWorkflowDispatchService(runtime: IAgentRuntime): WorkflowDispatchService {
  // Track in-flight executions by `(workflowId, idempotencyKey)` so that
  // two concurrent dispatches inside the same process collapse onto one
  // run. The map entry resolves once the original run finishes, and the
  // late caller returns the same execution id.
  const inflight = new Map<string, Promise<WorkflowDispatchResult>>();

  return {
    async execute(
      workflowId: string,
      payload: Record<string, unknown> = {},
      options: WorkflowDispatchOptions = {}
    ): Promise<WorkflowDispatchResult> {
      const id = workflowId.trim();
      if (!id) {
        return { ok: false, error: 'workflow id required' };
      }
      const service = resolveEmbeddedService(runtime);
      if (!service) {
        return { ok: false, error: 'embedded workflow service not registered' };
      }

      const partitioned = partitionPayload(payload);
      const triggerData =
        options.triggerData && Object.keys(options.triggerData).length > 0
          ? options.triggerData
          : partitioned.triggerData;
      const idempotencyKey = options.idempotencyKey ?? partitioned.idempotencyKey;

      if (idempotencyKey) {
        const existing = await service.findExecutionByIdempotencyKey(id, idempotencyKey);
        if (existing) {
          return existing.id
            ? { ok: true, executionId: existing.id, dedup: true }
            : { ok: true, dedup: true };
        }

        const inflightKey = `${id}::${idempotencyKey}`;
        const pending = inflight.get(inflightKey);
        if (pending) {
          const result = await pending;
          return result.ok ? { ...result, dedup: true } : result;
        }

        const promise = runDispatch(service, id, triggerData, idempotencyKey).finally(() => {
          inflight.delete(inflightKey);
        });
        inflight.set(inflightKey, promise);
        return promise;
      }

      return runDispatch(service, id, triggerData, undefined);
    },
  };
}

async function runDispatch(
  service: EmbeddedWorkflowService,
  workflowId: string,
  triggerData: Record<string, unknown>,
  idempotencyKey: string | undefined
): Promise<WorkflowDispatchResult> {
  try {
    const execution = await service.executeWorkflow(workflowId, {
      mode: 'trigger',
      triggerData,
      idempotencyKey,
    });
    return execution.id ? { ok: true, executionId: execution.id } : { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { src: 'plugin:workflow:dispatch' },
      `Workflow execution failed for ${workflowId}: ${message}`
    );
    return { ok: false, error: message };
  }
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
    execute: dispatch.execute.bind(dispatch),
    stop: async () => {},
    capabilityDescription: 'Executes embedded workflows by id via the in-process workflow service.',
  };
  getRuntimeServiceRegistry(runtime)?.set(WORKFLOW_DISPATCH_SERVICE_TYPE, [serviceEntry]);
}

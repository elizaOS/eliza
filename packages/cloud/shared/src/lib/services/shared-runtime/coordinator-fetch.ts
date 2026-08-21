/**
 * Applies a bounded deadline to shared-runtime Durable Object fetches.
 *
 * The adapter preserves the platform's complete `RequestInfo | URL` input
 * contract while composing caller cancellation with the per-hop timeout.
 */

import type { RuntimeDurableObjectStub } from "../../../types/cloud-worker-env";

const SHARED_RUNTIME_FETCH_TIMEOUT_MS = 10_000;

export function coordinatorFetch(
  stub: RuntimeDurableObjectStub,
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = SHARED_RUNTIME_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return stub.fetch(input, {
    ...init,
    signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
  });
}

export function deadlineBoundCoordinatorStub(
  stub: RuntimeDurableObjectStub,
): RuntimeDurableObjectStub {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinatorFetch(stub, input, init),
  };
}

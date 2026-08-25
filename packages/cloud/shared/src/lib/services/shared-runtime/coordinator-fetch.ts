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
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new DOMException("Shared runtime coordinator response headers timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  return stub.fetch(input, { ...init, signal }).finally(() => clearTimeout(timeout));
}

export function deadlineBoundCoordinatorStub(
  stub: RuntimeDurableObjectStub,
): RuntimeDurableObjectStub {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => coordinatorFetch(stub, input, init),
  };
}

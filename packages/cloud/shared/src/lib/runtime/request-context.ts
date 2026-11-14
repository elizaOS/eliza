/**
 * Per-request context for shared `packages/lib` code.
 *
 * The Cloud API wraps every request in `runWithRequestContext({ clientIp }, …)`
 * so library code deep in the call tree can read the originating client IP
 * without threading it through every intermediate function. Mirrors the ambient
 * pattern in `cloud-bindings.ts`.
 *
 * Outside a Worker request (no store), `getClientIp()` returns `undefined`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestTaskDefer = (task: Promise<unknown>) => void;

export interface RequestContext {
  clientIp?: string;
  /**
   * Stable per-request idempotency key (from the `Idempotency-Key`/`X-Request-Id`
   * header, else a per-request uuid). #10423: money-settlement code keys the
   * app-creator earnings credit on this so a retried settlement (a re-run of the
   * chat/message `onFinish` for the SAME request) doesn't double-credit — without
   * threading it through every intermediate helper.
   */
  idempotencyKey?: string;
  /**
   * Register post-response work with the current runtime. Worker shells bind
   * this to `c.executionCtx.waitUntil(task)`; non-Worker callers omit it and
   * shared services must await the same task before returning.
   */
  defer?: RequestTaskDefer;
  /**
   * Rewrite this request's cached inference auth entry from the primary, off
   * the response. Registered by inference authentication and bound to the
   * request's admission, which calls it when the entry's funding standing is
   * no longer true.
   */
  refreshInferenceAuthEntry?: () => void;
}

const als = new AsyncLocalStorage<RequestContext>();

export async function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return await als.run(context, fn);
}

/** The originating client IP for the current request, or `undefined`. */
export function getClientIp(): string | undefined {
  return als.getStore()?.clientIp;
}

/** The stable per-request idempotency key for the current request, or `undefined`. */
export function getRequestIdempotencyKey(): string | undefined {
  return als.getStore()?.idempotencyKey;
}

/** Register the cached-auth-entry refresh for the current request. */
export function setRequestInferenceAuthEntryRefresh(refresh: () => void): void {
  const store = als.getStore();
  if (store) store.refreshInferenceAuthEntry = refresh;
}

/** The current request's cached-auth-entry refresh, when authentication registered one. */
export function getRequestInferenceAuthEntryRefresh(): (() => void) | undefined {
  return als.getStore()?.refreshInferenceAuthEntry;
}

/** Runtime-owned post-response task registrar for the current async chain. */
export function getRequestTaskDefer(): RequestTaskDefer | undefined {
  return als.getStore()?.defer;
}

/**
 * Per-request context for shared `packages/lib` code.
 *
 * The Cloud API wraps every request in `runWithRequestContext({ clientIp }, …)`
 * so library code deep in the call tree (e.g. signup credit grants) can read the
 * originating client IP for anti-sybil checks without threading it through every
 * intermediate function. Mirrors the ambient pattern in `cloud-bindings.ts`.
 *
 * Outside a Worker request (no store), `getClientIp()` returns `undefined`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  clientIp?: string;
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

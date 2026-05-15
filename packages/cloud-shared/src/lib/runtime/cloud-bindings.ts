/**
 * Per-request Cloudflare Worker bindings for shared `packages/lib` code.
 *
 * On Workers, secrets live on `c.env`, not `process.env`. The Cloud API runs
 * `runWithCloudBindings(c.env, () => next())` so libraries can call
 * `getCloudAwareEnv()` and read string secrets the same way as on Node.
 *
 * Non-string bindings (R2, Queues, etc.) are ignored by `getCloudAwareEnv`;
 * pass those explicitly (e.g. `setRuntimeR2Bucket`) or extend call sites.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Run `fn` with Worker bindings visible to `getCloudAwareEnv()`.
 */
export function runWithCloudBindings<T>(bindings: Record<string, unknown>, fn: () => T): T {
  return als.run(bindings, fn);
}

/**
 * Async variant — use from Hono middleware with `await next()`.
 */
export async function runWithCloudBindingsAsync<T>(
  bindings: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return await als.run(bindings, fn);
}

/**
 * `process.env` merged with string values from the current `c.env` store.
 * Outside a Worker request (no store), returns `process.env` unchanged.
 */
export function getCloudAwareEnv(): NodeJS.ProcessEnv {
  const store = als.getStore();
  if (!store) {
    return process.env;
  }
  const base = process.env as NodeJS.ProcessEnv;
  return new Proxy(base, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop);
      }
      if (Object.hasOwn(store, prop)) {
        const v = store[prop];
        if (typeof v === "string") {
          return v;
        }
      }
      return Reflect.get(target, prop);
    },
  }) as NodeJS.ProcessEnv;
}

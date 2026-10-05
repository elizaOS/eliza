/** One caller's renderer state, shared by HTTP handlers and their async agent work. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IAgentRuntime } from "@elizaos/core";

export interface ViewClientScope {
  hostKey: object;
  clientId: string;
}
const callers = new AsyncLocalStorage<ViewClientScope | undefined>();
export const runWithViewClient = <T>(
  scope: ViewClientScope | undefined,
  run: () => T,
): T => callers.run(scope, run);
export const getViewClientScope = (): ViewClientScope | undefined =>
  callers.getStore();

export function createViewClientStore<T>() {
  const runtimes = new WeakMap<
    IAgentRuntime,
    WeakMap<object, Map<string, T>>
  >();
  function clients(
    runtime: IAgentRuntime,
    scope: ViewClientScope,
    create = false,
  ) {
    let hosts = runtimes.get(runtime);
    if (!hosts && create) {
      hosts = new WeakMap();
      runtimes.set(runtime, hosts);
    }
    let values = hosts?.get(scope.hostKey);
    if (!values && create) {
      values = new Map();
      hosts?.set(scope.hostKey, values);
    }
    return values;
  }
  return {
    get(runtime: IAgentRuntime, scope = getViewClientScope()): T | null {
      return scope
        ? (clients(runtime, scope)?.get(scope.clientId) ?? null)
        : null;
    },
    set(runtime: IAgentRuntime, value: T, scope = getViewClientScope()): void {
      if (scope) clients(runtime, scope, true)?.set(scope.clientId, value);
    },
    delete(runtime: IAgentRuntime, scope = getViewClientScope()): void {
      if (scope) clients(runtime, scope)?.delete(scope.clientId);
    },
  };
}

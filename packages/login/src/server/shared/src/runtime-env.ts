import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const runtimeEnvironmentStorage = new AsyncLocalStorage<RuntimeEnvironment>();

function snapshotRuntimeEnvironment(
  environment: Record<string, unknown>,
): RuntimeEnvironment {
  const snapshot: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === "string") snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

/** Bind an immutable environment snapshot to one asynchronous request. */
export function withRuntimeEnvironment<T>(
  environment: Record<string, unknown>,
  callback: () => T,
): T {
  return runtimeEnvironmentStorage.run(
    snapshotRuntimeEnvironment(environment),
    callback,
  );
}

/** Resolve one setting from the current request snapshot or Bun process. */
export function runtimeEnvironmentValue(name: string): string | undefined {
  const requestEnvironment = runtimeEnvironmentStorage.getStore();
  return requestEnvironment ? requestEnvironment[name] : process.env[name];
}

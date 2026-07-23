/**
 * Promise cache for the renderer's deferred app-module imports. Each deferred
 * import is identified by a role-qualified key — the canonical package name for
 * a package-root facade (e.g. "@elizaos/plugin-personal-assistant"), a
 * `/register`-suffixed or `#register`-qualified key for a side-effect
 * registration entry — so two different module namespaces from the same
 * package can never share a cached promise: whichever loader ran first would
 * otherwise hand its namespace to consumers expecting the other entry's
 * exports (#16504).
 *
 * The cache dedupes loader invocations, not module evaluation (the ES module
 * registry already guarantees a module body runs once); its job is to let the
 * idle boot schedule and on-demand consumers request the same entry without
 * racing duplicate fetches.
 */

const appModuleCache = new Map<string, Promise<unknown>>();

export function cachedDynamicImport<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = appModuleCache.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = loader();
  appModuleCache.set(key, promise);
  return promise;
}

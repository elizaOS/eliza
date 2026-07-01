export interface ReusablePgliteManager {
  isShuttingDown(): boolean;
}

export interface PgliteManagerCache<TManager extends ReusablePgliteManager> {
  pgLiteClientManager?: TManager;
  pgLiteClientManagers?: Map<string, TManager>;
  activePgliteManagerKey?: string;
}

export function pgliteManagerCacheKey(dataDir: string | undefined, agentId: string): string {
  return JSON.stringify({ dataDir: dataDir ?? null, agentId });
}

export function getOrCreatePgliteManagerForAgent<TManager extends ReusablePgliteManager>(
  cache: PgliteManagerCache<TManager>,
  dataDir: string | undefined,
  agentId: string,
  createManager: () => TManager
): TManager {
  const key = pgliteManagerCacheKey(dataDir, agentId);
  cache.pgLiteClientManagers ??= new Map();

  const existing = cache.pgLiteClientManagers.get(key);
  if (existing && !existing.isShuttingDown()) {
    cache.pgLiteClientManager = existing;
    cache.activePgliteManagerKey = key;
    return existing;
  }

  const manager = createManager();
  cache.pgLiteClientManagers.set(key, manager);
  cache.pgLiteClientManager = manager;
  cache.activePgliteManagerKey = key;
  return manager;
}

export function getActivePgliteManager<TManager extends ReusablePgliteManager>(
  cache: PgliteManagerCache<TManager>
): TManager | undefined {
  if (cache.activePgliteManagerKey && cache.pgLiteClientManagers) {
    return cache.pgLiteClientManagers.get(cache.activePgliteManagerKey);
  }

  return cache.pgLiteClientManager;
}

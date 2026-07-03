export interface ReusablePgliteManager {
  isShuttingDown(): boolean;
}

export interface PgliteManagerCache<TManager extends ReusablePgliteManager> {
  pgLiteClientManager?: TManager;
  pgLiteClientManagers?: Map<string, TManager>;
  activePgliteManagerKey?: string;
}

/**
 * The minimal PGlite manager surface hosts interact with through the public
 * singleton accessors. Kept intentionally narrow so callers cannot reach into
 * manager internals; the concrete manager type stays private to plugin-sql.
 */
export interface PgliteSingletonManager {
  isShuttingDown(): boolean;
  close(): Promise<void>;
}

/**
 * Public handle onto the process-global PGlite singleton cache. Lets a host
 * pre-seed or inspect the active manager without hand-copying plugin-sql's
 * private `Symbol.for("elizaos.plugin-sql.global-singletons")`.
 */
export interface PgliteSingletonCache {
  pgLiteClientManager?: PgliteSingletonManager;
}

/** Result of {@link closePgliteSingleton}. */
export interface ClosePgliteSingletonResult {
  /** Whether a manager was present and its close() was invoked. */
  closed: boolean;
  /** Whether close() exceeded the timeout and was abandoned. */
  timedOut: boolean;
  /** Error thrown by close(), if any; the manager is dropped regardless. */
  error: Error | null;
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

export function dropActivePgliteManager<TManager extends ReusablePgliteManager>(
  cache: PgliteManagerCache<TManager>,
  manager: TManager
): void {
  const activeKey = cache.activePgliteManagerKey;
  if (activeKey && cache.pgLiteClientManagers?.get(activeKey) === manager) {
    cache.pgLiteClientManagers.delete(activeKey);
    delete cache.activePgliteManagerKey;
  } else if (cache.pgLiteClientManagers) {
    for (const [key, cachedManager] of cache.pgLiteClientManagers) {
      if (cachedManager === manager) {
        cache.pgLiteClientManagers.delete(key);
      }
    }
  }

  if (cache.pgLiteClientManager === manager) {
    delete cache.pgLiteClientManager;
  }
}

import { logger } from "@elizaos/core";

const LIFEOPS_APP_STATE_CACHE_KEY = "eliza:lifeops-app-state";

export interface LifeOpsAppState {
  enabled: boolean;
}

type RuntimeCacheLike = {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | void>;
};

const DEFAULT_LIFEOPS_APP_STATE: LifeOpsAppState = {
  enabled: true,
};

export async function loadLifeOpsAppState(
  runtime: RuntimeCacheLike | null,
): Promise<LifeOpsAppState> {
  if (!runtime) {
    return DEFAULT_LIFEOPS_APP_STATE;
  }

  try {
    const cached = await runtime.getCache<Partial<LifeOpsAppState>>(
      LIFEOPS_APP_STATE_CACHE_KEY,
    );
    if (cached == null) {
      return DEFAULT_LIFEOPS_APP_STATE;
    }
    return {
      enabled: cached.enabled !== false,
    };
  } catch (error) {
    logger.debug(
      `[lifeops] Failed to load app state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return DEFAULT_LIFEOPS_APP_STATE;
  }
}

export async function saveLifeOpsAppState(
  runtime: RuntimeCacheLike,
  state: LifeOpsAppState,
): Promise<LifeOpsAppState> {
  const nextState: LifeOpsAppState = {
    enabled: state.enabled === true,
  };

  try {
    await runtime.setCache(LIFEOPS_APP_STATE_CACHE_KEY, nextState);
  } catch (error) {
    logger.warn(
      `[lifeops] Failed to persist app state (enabled=${nextState.enabled}): ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

  return nextState;
}

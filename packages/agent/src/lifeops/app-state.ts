import { logger } from "@elizaos/core";

const LIFEOPS_APP_STATE_CACHE_KEY = "eliza:lifeops-app-state";

export interface LifeOpsAppState {
  enabled: boolean;
}

type RuntimeCacheLike = {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | undefined>;
};

const DEFAULT_LIFEOPS_APP_STATE: LifeOpsAppState = {
  enabled: false,
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
    return {
      enabled: cached?.enabled === true,
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
    logger.debug(
      `[lifeops] Failed to save app state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return nextState;
}

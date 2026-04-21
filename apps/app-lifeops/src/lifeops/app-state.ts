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

function isLifeOpsAppState(value: unknown): value is LifeOpsAppState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Partial<LifeOpsAppState>).enabled === "boolean"
  );
}

export async function loadLifeOpsAppState(
  runtime: RuntimeCacheLike | null,
): Promise<LifeOpsAppState> {
  if (!runtime) {
    return DEFAULT_LIFEOPS_APP_STATE;
  }

  const cached = await runtime.getCache<unknown>(LIFEOPS_APP_STATE_CACHE_KEY);
  if (cached == null) {
    return DEFAULT_LIFEOPS_APP_STATE;
  }
  if (!isLifeOpsAppState(cached)) {
    throw new Error(
      "[lifeops] invalid cached app state: expected { enabled: boolean }",
    );
  }
  return cached;
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

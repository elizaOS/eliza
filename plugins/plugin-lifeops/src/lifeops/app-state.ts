import { logger } from "@elizaos/core";

const LIFEOPS_APP_STATE_CACHE_KEY = "eliza:lifeops-app-state";

export interface LifeOpsPriorityScoringState {
  /** Master toggle for LLM-based priority scoring on the inbox. */
  enabled: boolean;
  /**
   * Optional model id to invoke. When unset the scorer uses
   * `ModelType.TEXT_SMALL` from the runtime.
   */
  model: string | null;
}

export interface LifeOpsAppState {
  enabled: boolean;
  /** Inbox smart-features configuration. */
  priorityScoring: LifeOpsPriorityScoringState;
}

type RuntimeCacheLike = {
  getCache<T>(key: string): Promise<T | null | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean | undefined>;
};

const DEFAULT_PRIORITY_SCORING: LifeOpsPriorityScoringState = {
  enabled: true,
  model: null,
};

const DEFAULT_LIFEOPS_APP_STATE: LifeOpsAppState = {
  enabled: true,
  priorityScoring: DEFAULT_PRIORITY_SCORING,
};

function isLifeOpsPriorityScoringState(
  value: unknown,
): value is LifeOpsPriorityScoringState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<LifeOpsPriorityScoringState>;
  if (typeof v.enabled !== "boolean") return false;
  if (v.model !== null && typeof v.model !== "string") return false;
  return true;
}

function isLifeOpsAppState(value: unknown): value is LifeOpsAppState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<LifeOpsAppState>;
  if (typeof v.enabled !== "boolean") return false;
  // priorityScoring is optional on disk for backwards compat — older payloads
  // only carried `enabled`. We hydrate defaults below.
  if (
    v.priorityScoring !== undefined &&
    !isLifeOpsPriorityScoringState(v.priorityScoring)
  ) {
    return false;
  }
  return true;
}

function hydrate(state: LifeOpsAppState): LifeOpsAppState {
  return {
    enabled: state.enabled === true,
    priorityScoring: state.priorityScoring
      ? {
          enabled: state.priorityScoring.enabled === true,
          model:
            typeof state.priorityScoring.model === "string" &&
            state.priorityScoring.model.trim().length > 0
              ? state.priorityScoring.model.trim()
              : null,
        }
      : { ...DEFAULT_PRIORITY_SCORING },
  };
}

export async function loadLifeOpsAppState(
  runtime: RuntimeCacheLike | null,
): Promise<LifeOpsAppState> {
  if (!runtime) {
    return { ...DEFAULT_LIFEOPS_APP_STATE };
  }

  const cached = await runtime.getCache<unknown>(LIFEOPS_APP_STATE_CACHE_KEY);
  if (cached == null) {
    return { ...DEFAULT_LIFEOPS_APP_STATE };
  }
  if (!isLifeOpsAppState(cached)) {
    throw new Error(
      "[lifeops] invalid cached app state: expected { enabled: boolean, priorityScoring? }",
    );
  }
  return hydrate(cached);
}

export async function saveLifeOpsAppState(
  runtime: RuntimeCacheLike,
  state: LifeOpsAppState,
): Promise<LifeOpsAppState> {
  const nextState = hydrate(state);

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

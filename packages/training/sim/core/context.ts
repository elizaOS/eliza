/**
 * Engine and tick context factories.
 */

import { type DrizzleClient, db } from "@babylon/db";
import { BabylonLLMClient } from "@babylon/engine";
import { type Logger, logger } from "@babylon/shared";
import { DefaultLLMOrchestrator } from "./llm-orchestrator";
import { DefaultTickMetrics } from "./metrics";
import { DefaultServiceContainer } from "./service-container";
import type {
  EngineConfig,
  EngineContext,
  LLMOrchestrator,
  RuntimeHookable,
  ServiceContainer,
  TickContext,
  TickSharedData,
} from "./types";

// ---------------------------------------------------------------------------
// DefaultTickSharedData
// ---------------------------------------------------------------------------

export class DefaultTickSharedData implements TickSharedData {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}

// ---------------------------------------------------------------------------
// createEngineContext
// ---------------------------------------------------------------------------

/** Noop hookable used when no engine hooks are provided (e.g. in tests). */
const noopHookable: RuntimeHookable = {
  hook: () => () => {},
  hookOnce: () => () => {},
};

export interface CreateEngineContextOptions {
  db?: DrizzleClient;
  llmClient?: BabylonLLMClient;
  llm?: LLMOrchestrator;
  logger?: Logger;
  services?: ServiceContainer;
  config?: Partial<EngineConfig>;
  hooks?: RuntimeHookable;
}

export function createEngineContext(
  options: CreateEngineContextOptions = {},
): EngineContext {
  const envBudget = process.env.GAME_TICK_BUDGET_MS;
  const parsedBudget = envBudget ? Number(envBudget) : undefined;

  const config: EngineConfig = {
    budgetMs: parsedBudget && parsedBudget > 0 ? parsedBudget : 180000,
    ...options.config,
  };

  return {
    db: options.db ?? db,
    llm:
      options.llm ??
      new DefaultLLMOrchestrator(options.llmClient ?? new BabylonLLMClient()),
    logger: options.logger ?? logger,
    services: options.services ?? new DefaultServiceContainer(),
    config,
    hooks: options.hooks ?? noopHookable,
  };
}

// ---------------------------------------------------------------------------
// createTickContext
// ---------------------------------------------------------------------------

export function createTickContext(
  engineCtx: EngineContext,
  tickNumber: number,
  dayNumber?: number,
): TickContext {
  const now = new Date();
  const deadline = Date.now() + engineCtx.config.budgetMs;
  const metrics = new DefaultTickMetrics();
  const shared = new DefaultTickSharedData();

  return {
    ...engineCtx,
    timestamp: now,
    deadline,
    dayNumber,
    tickNumber,
    shared,
    metrics,
    isPastDeadline() {
      return Date.now() > deadline;
    },
  };
}

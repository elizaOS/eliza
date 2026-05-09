/**
 * Framework type definitions.
 * All interfaces for the system engine, contexts, and runtime.
 */

import type { DrizzleClient } from "@babylon/db";
import type { PromptDefinition } from "@babylon/engine";
import type { Logger } from "@babylon/shared";
import type {
  BabylonConfig,
  BabylonHooks,
  BabylonServices,
  BabylonSharedData,
} from "./augments";

// ---------------------------------------------------------------------------
// Utility: check if an interface has been augmented (has at least one key)
// ---------------------------------------------------------------------------

type IsEmpty<T> = keyof T extends never ? true : false;

// ---------------------------------------------------------------------------
// TickPhase — maps to real game-tick.ts section ordering
// ---------------------------------------------------------------------------

export const TickPhase = {
  Bootstrap: 100,
  Questions: 200,
  Events: 300,
  Markets: 400,
  Rebalancing: 500,
  ContentMaintenance: 600,
  Social: 700,
  Finalize: 800,
} as const;

export type TickPhase = (typeof TickPhase)[keyof typeof TickPhase];

// ---------------------------------------------------------------------------
// System result
// ---------------------------------------------------------------------------

export interface SystemTickResult {
  metrics?: Record<string, number | string | boolean>;
  sharedData?: Record<string, unknown>;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Service container — typed when BabylonServices is augmented
// ---------------------------------------------------------------------------

/** Typed overloads when BabylonServices has been augmented. */
interface TypedServiceContainer {
  register<K extends keyof BabylonServices>(
    token: K,
    instance: BabylonServices[K],
  ): void;
  register<T>(token: string, instance: T): void;

  get<K extends keyof BabylonServices>(token: K): BabylonServices[K];
  get<T>(token: string): T;

  has(token: string): boolean;
  has(token: keyof BabylonServices): boolean;

  tokens(): string[];
}

/** Untyped fallback when BabylonServices is empty. */
interface UntypedServiceContainer {
  register<T>(token: string, instance: T): void;
  get<T>(token: string): T;
  has(token: string): boolean;
  tokens(): string[];
}

export type ServiceContainer =
  IsEmpty<BabylonServices> extends true
    ? UntypedServiceContainer
    : TypedServiceContainer;

// ---------------------------------------------------------------------------
// Tick metrics
// ---------------------------------------------------------------------------

export interface TickMetrics {
  set(key: string, value: number | string | boolean): void;
  get(key: string): number | string | boolean | undefined;
  increment(key: string, amount?: number): void;
  addWarning(warning: string): void;
  warnings(): string[];
  snapshot(): Record<string, number | string | boolean>;
}

// ---------------------------------------------------------------------------
// Tick shared data — typed when BabylonSharedData is augmented
// ---------------------------------------------------------------------------

/** Typed overloads when BabylonSharedData has been augmented. */
interface TypedTickSharedData {
  get<K extends keyof BabylonSharedData>(
    key: K,
  ): BabylonSharedData[K] | undefined;
  get<T>(key: string): T | undefined;

  set<K extends keyof BabylonSharedData>(
    key: K,
    value: BabylonSharedData[K],
  ): void;
  set(key: string, value: unknown): void;

  has(key: string): boolean;
  has(key: keyof BabylonSharedData): boolean;
}

/** Untyped fallback when BabylonSharedData is empty. */
interface UntypedTickSharedData {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
}

export type TickSharedData =
  IsEmpty<BabylonSharedData> extends true
    ? UntypedTickSharedData
    : TypedTickSharedData;

// ---------------------------------------------------------------------------
// Engine config — typed when BabylonConfig is augmented
// ---------------------------------------------------------------------------

export type EngineConfig = {
  budgetMs: number;
} & (IsEmpty<BabylonConfig> extends true
  ? { [key: string]: unknown }
  : BabylonConfig & { [key: string]: unknown });

// ---------------------------------------------------------------------------
// LLM orchestrator
// ---------------------------------------------------------------------------

export interface LLMOrchestrator {
  execute<T>(options: LLMExecuteOptions): Promise<T>;
  getClient(): unknown;
}

export interface LLMExecuteOptions {
  prompt: PromptDefinition;
  variables?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  model?: string;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export interface RuntimeHookable {
  hook<T extends keyof RuntimeHooks>(name: T, fn: RuntimeHooks[T]): () => void;
  hookOnce<T extends keyof RuntimeHooks>(
    name: T,
    fn: RuntimeHooks[T],
  ): () => void;
}

export interface EngineContext {
  readonly db: DrizzleClient;
  readonly llm: LLMOrchestrator;
  readonly logger: Logger;
  readonly services: ServiceContainer;
  readonly config: EngineConfig;
  readonly hooks: RuntimeHookable;
}

export interface TickContext extends EngineContext {
  readonly timestamp: Date;
  readonly deadline: number;
  readonly dayNumber: number | undefined;
  readonly tickNumber: number;
  readonly shared: TickSharedData;
  readonly metrics: TickMetrics;
  isPastDeadline(): boolean;
}

// ---------------------------------------------------------------------------
// BabylonSystem
// ---------------------------------------------------------------------------

export interface BabylonSystem {
  readonly id: string;
  readonly name: string;
  readonly phase: TickPhase;
  readonly dependencies?: string[];
  /** If true, this system always runs even when past the tick deadline. */
  readonly skipDeadlineCheck?: boolean;
  readonly intervals?: Record<
    string,
    {
      /** Run every N ticks (tick-count-based). */
      every?: number;
      /** Run every N milliseconds (time-based, checked per tick). */
      everyMs?: number;
      handler: (ctx: TickContext) => Promise<SystemTickResult>;
    }
  >;
  register?(ctx: EngineContext): Promise<void>;
  onTick(ctx: TickContext): Promise<SystemTickResult>;
  destroy?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime hooks — lifecycle events emitted by BabylonEngine
// ---------------------------------------------------------------------------

export type RuntimeHooks = {
  /** Called after the engine has booted and all systems are registered. */
  "engine:boot": (ctx: EngineContext) => void | Promise<void>;
  /** Called before the engine shuts down. */
  "engine:shutdown": () => void | Promise<void>;

  /** Called at the start of each tick, before any systems run. */
  "tick:before": (ctx: TickContext) => void | Promise<void>;
  /** Called after all systems have run for a tick. */
  "tick:after": (
    ctx: TickContext,
    metrics: Record<string, number | string | boolean>,
  ) => void | Promise<void>;

  /** Called before a specific system's onTick runs. */
  "system:before": (systemId: string, ctx: TickContext) => void | Promise<void>;
  /** Called after a specific system's onTick completes. */
  "system:after": (
    systemId: string,
    ctx: TickContext,
    result: SystemTickResult,
  ) => void | Promise<void>;
  /** Called when a system throws during onTick. */
  "system:error": (
    systemId: string,
    error: Error,
    ctx: TickContext,
  ) => void | Promise<void>;
} & (IsEmpty<BabylonHooks> extends true ? Record<string, never> : BabylonHooks);

/**
 * unctx-based composables for implicit context access.
 *
 * Instead of threading TickContext through every function call,
 * systems and their helpers can use these composables:
 *
 *   const ctx = useTick()        // current TickContext (throws if not in a tick)
 *   const engine = useEngine()   // current EngineContext
 *   const hooks = useHooks()     // runtime hookable
 *   const db = useDB()           // database client
 *   const llm = useLLM()         // LLM orchestrator
 *   const services = useServices() // service container
 *   const metrics = useMetrics() // tick metrics
 *   const shared = useShared()   // tick shared data
 *
 * Context is set by BabylonEngine during tick execution using AsyncLocalStorage,
 * so it works across async boundaries without build-time transforms.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DrizzleClient } from "@babylon/db";
import { createContext } from "unctx";
import type {
  EngineContext,
  LLMOrchestrator,
  RuntimeHookable,
  ServiceContainer,
  TickContext,
  TickMetrics,
  TickSharedData,
} from "./types";

// ---------------------------------------------------------------------------
// Contexts (with AsyncLocalStorage for async safety)
// ---------------------------------------------------------------------------

const engineContext = createContext<EngineContext>({
  asyncContext: true,
  AsyncLocalStorage,
});

const tickContext = createContext<TickContext>({
  asyncContext: true,
  AsyncLocalStorage,
});

// ---------------------------------------------------------------------------
// Internal — used by BabylonEngine to set/call context
// ---------------------------------------------------------------------------

export const _engine = engineContext;
export const _tick = tickContext;

// ---------------------------------------------------------------------------
// Public composables
// ---------------------------------------------------------------------------

/** Get the current EngineContext. Throws if called outside engine lifecycle. */
export function useEngine(): EngineContext {
  return engineContext.use();
}

/** Get the current TickContext. Throws if called outside a tick. */
export function useTick(): TickContext {
  return tickContext.use();
}

/** Try to get the current TickContext. Returns null if not in a tick. */
export function tryUseTick(): TickContext | null {
  return tickContext.tryUse();
}

/** Get the database client from the current engine context. */
export function useDB(): DrizzleClient {
  return engineContext.use().db;
}

/** Get the LLM orchestrator from the current engine context. */
export function useLLM(): LLMOrchestrator {
  return engineContext.use().llm;
}

/** Get the runtime hooks from the current engine context. */
export function useHooks(): RuntimeHookable {
  return engineContext.use().hooks;
}

/** Get the service container from the current engine context. */
export function useServices(): ServiceContainer {
  return engineContext.use().services;
}

/** Get the tick metrics. Throws if called outside a tick. */
export function useMetrics(): TickMetrics {
  return tickContext.use().metrics;
}

/** Get the tick shared data. Throws if called outside a tick. */
export function useShared(): TickSharedData {
  return tickContext.use().shared;
}

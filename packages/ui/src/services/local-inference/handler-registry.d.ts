/**
 * Side-registry of model handlers registered on an AgentRuntime.
 *
 * The elizaOS core exposes `runtime.registerModel(type, handler, provider,
 * priority)` but no way to list who registered what. This module intercepts
 * `registerModel` at runtime to record every registration in a Map keyed by
 * model type, plus fires status listeners so the UI can render a live
 * [ModelType × Provider] routing table.
 *
 * Because we monkey-patch `registerModel` we also keep the original
 * handler reference — the router-handler (see `router-handler.ts`) uses
 * this to dispatch inference calls by policy without going through
 * `runtime.useModel` (which would loop back to us and recurse).
 */
import { AgentRuntime, type IAgentRuntime } from "@elizaos/core";
export interface HandlerRegistration {
  modelType: string;
  provider: string;
  priority: number;
  registeredAt: string;
  /**
   * The original handler function. Captured so the router-handler can
   * dispatch to it directly, bypassing `runtime.useModel` which would
   * re-enter the router itself.
   */
  handler: (
    runtime: IAgentRuntime,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}
type Listener = (registrations: HandlerRegistration[]) => void;
declare class HandlerRegistry {
  private readonly registrations;
  private readonly listeners;
  private installedOn;
  /**
   * Snapshot of all registrations grouped by model type, sorted by
   * priority descending inside each group (matches core's selection
   * order). Callers must not mutate the returned array.
   */
  getAll(): HandlerRegistration[];
  /** All registrations for a given model type, sorted by priority desc. */
  getForType(modelType: string): HandlerRegistration[];
  /**
   * Registrations excluding a specific provider. Used by the router-handler
   * to find "all providers except me" when dispatching.
   */
  getForTypeExcluding(
    modelType: string,
    excludeProvider: string,
  ): HandlerRegistration[];
  subscribe(listener: Listener): () => void;
  private emit;
  private record;
  /**
   * Install the interception on a runtime. Idempotent per runtime instance.
   * For most boot paths the prototype-level patch below already covers the
   * runtime before any plugin registers; this method is the belt-and-braces
   * fallback for runtimes constructed before the patch ran.
   */
  installOn(runtime: AgentRuntime): void;
  /** Exposed so the prototype patch can record through the singleton. */
  recordFromPrototype(reg: HandlerRegistration): void;
}
export declare const handlerRegistry: HandlerRegistry;
/**
 * Public type used by the API/UI — omits the handler function for
 * serialisation and to prevent UI code from accidentally calling it.
 */
export interface PublicRegistration {
  modelType: string;
  provider: string;
  priority: number;
  registeredAt: string;
}
export declare function toPublicRegistration(
  reg: HandlerRegistration,
): PublicRegistration;
//# sourceMappingURL=handler-registry.d.ts.map

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

// Type-only import: pulling the `AgentRuntime` *value* here would drag core's
// ~2MB browser bundle into the eager first-paint graph. Local inference is
// opt-in, so the prototype patch is installed lazily from the runtime instance
// passed to `installOn()` (see below) — we never need the static class.
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";

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

class HandlerRegistry {
  private readonly registrations = new Map<string, HandlerRegistration[]>();
  private readonly listeners = new Set<Listener>();
  private installedOn: WeakSet<object> = new WeakSet();

  /**
   * Snapshot of all registrations grouped by model type, sorted by
   * priority descending inside each group (matches core's selection
   * order). Callers must not mutate the returned array.
   */
  getAll(): HandlerRegistration[] {
    const out: HandlerRegistration[] = [];
    for (const list of this.registrations.values()) {
      out.push(...list);
    }
    return out;
  }

  /** All registrations for a given model type, sorted by priority desc. */
  getForType(modelType: string): HandlerRegistration[] {
    const list = this.registrations.get(modelType);
    return list ? [...list] : [];
  }

  /**
   * Registrations excluding a specific provider. Used by the router-handler
   * to find "all providers except me" when dispatching.
   */
  getForTypeExcluding(
    modelType: string,
    excludeProvider: string,
  ): HandlerRegistration[] {
    return this.getForType(modelType).filter(
      (r) => r.provider !== excludeProvider,
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getAll();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  private record(reg: HandlerRegistration): void {
    const existing = this.registrations.get(reg.modelType) ?? [];
    // Replace any prior registration from the same provider for this
    // model type. Core allows multiple providers per type but only one
    // registration per (type, provider) pair — last write wins.
    const filtered = existing.filter((r) => r.provider !== reg.provider);
    filtered.push(reg);
    filtered.sort((a, b) => b.priority - a.priority);
    this.registrations.set(reg.modelType, filtered);
    this.emit();
  }

  /**
   * Install the interception on a runtime. Idempotent per runtime instance.
   * For most boot paths the prototype-level patch below already covers the
   * runtime before any plugin registers; this method is the belt-and-braces
   * fallback for runtimes constructed before the patch ran.
   */
  installOn(runtime: AgentRuntime): void {
    // Patch the prototype via the live instance (no static `AgentRuntime`
    // import needed). Idempotent and benign — forwards to the original.
    const proto = Object.getPrototypeOf(runtime) as {
      registerModel?: RegisterModelMethod;
    } | null;
    if (proto) installPrototypePatch(proto);
    const rt = runtime as AgentRuntime & {
      registerModel?: unknown;
    };
    if (typeof rt.registerModel !== "function") return;
    if (this.installedOn.has(rt)) return;
    this.installedOn.add(rt);

    // If the runtime already inherited the patched prototype method the
    // prototype handles every call. Nothing to do per-instance.
    const protoMethod = Object.getPrototypeOf(rt)?.registerModel as
      | RegisterModelMethod
      | undefined;
    if (protoMethod && isPatchedRegisterModel(protoMethod)) {
      return;
    }

    // Per-instance wrap only for legacy runtimes whose prototype pre-dates
    // our prototype patch (shouldn't happen in practice).
    const original = rt.registerModel.bind(runtime) as (
      modelType: string,
      handler: HandlerRegistration["handler"],
      provider: string,
      priority?: number,
    ) => void;
    rt.registerModel = ((
      modelType: string,
      handler: HandlerRegistration["handler"],
      provider: string,
      priority?: number,
    ) => {
      this.record({
        modelType: String(modelType),
        provider: String(provider),
        priority: typeof priority === "number" ? priority : 0,
        registeredAt: new Date().toISOString(),
        handler,
      });
      return original(modelType, handler, provider, priority);
    }) as typeof rt.registerModel;
  }

  /** Exposed so the prototype patch can record through the singleton. */
  recordFromPrototype(reg: HandlerRegistration): void {
    this.record(reg);
  }
}

const PATCH_MARK = Symbol.for("eliza.local-inference.registerModel.patched");
let prototypePatched = false;

type RegisterModelMethod = (
  this: AgentRuntime,
  modelType: string,
  handler: HandlerRegistration["handler"],
  provider: string,
  priority?: number,
) => void;

type PatchedRegisterModelMethod = RegisterModelMethod & {
  [PATCH_MARK]?: true;
};

function isPatchedRegisterModel(
  method: unknown,
): method is PatchedRegisterModelMethod {
  return (
    typeof method === "function" &&
    (method as { [PATCH_MARK]?: true })[PATCH_MARK] === true
  );
}

/**
 * One-shot patch of `AgentRuntime.prototype.registerModel` so every runtime
 * instance — including ones constructed later in boot — records through
 * the singleton handler registry. Idempotent.
 *
 * Takes the prototype object (obtained from a live runtime instance) rather
 * than referencing the static `AgentRuntime` class, so this module never
 * value-imports `@elizaos/core` and stays off the eager bundle graph.
 */
function installPrototypePatch(proto: {
  registerModel?: RegisterModelMethod;
}): void {
  if (prototypePatched) return;
  const original = proto.registerModel;
  if (typeof original !== "function") return;
  if (isPatchedRegisterModel(original)) {
    prototypePatched = true;
    return;
  }
  const patched = function patchedRegisterModel(
    this: unknown,
    modelType: string,
    handler: HandlerRegistration["handler"],
    provider: string,
    priority?: number,
  ): void {
    try {
      handlerRegistry.recordFromPrototype({
        modelType: String(modelType),
        provider: String(provider),
        priority: typeof priority === "number" ? priority : 0,
        registeredAt: new Date().toISOString(),
        handler,
      });
    } catch {
      // Never let registry bookkeeping break the registration path.
    }
    (original as RegisterModelMethod).call(
      this as AgentRuntime,
      modelType,
      handler,
      provider,
      priority,
    );
  } as typeof original & { [PATCH_MARK]?: true };
  patched[PATCH_MARK] = true;
  proto.registerModel = patched;
  prototypePatched = true;
}

// NOTE: no module-load patch. The prototype is patched lazily from the first
// runtime instance handed to `handlerRegistry.installOn(runtime)` during
// local-inference setup. This keeps `@elizaos/core` (and its ~2MB bundle) out
// of the eager first-paint graph for every app that never opens local inference.

export const handlerRegistry = new HandlerRegistry();

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

export function toPublicRegistration(
  reg: HandlerRegistration,
): PublicRegistration {
  return {
    modelType: reg.modelType,
    provider: reg.provider,
    priority: reg.priority,
    registeredAt: reg.registeredAt,
  };
}

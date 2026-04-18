/**
 * Side-registry of model handlers registered on an AgentRuntime.
 *
 * The elizaOS core exposes `runtime.registerModel(type, handler, provider,
 * priority)` but no way to list who registered what. This module patches
 * `AgentRuntime.prototype.registerModel` at import time so every call —
 * from every plugin, on every runtime instance — records into a
 * process-wide Map keyed by model type. The router-handler uses the raw
 * handler references to dispatch by policy without re-entering
 * `runtime.useModel`.
 */

import { AgentRuntime, type IAgentRuntime } from "@elizaos/core";

export interface HandlerRegistration {
  modelType: string;
  provider: string;
  priority: number;
  registeredAt: string;
  handler: (
    runtime: IAgentRuntime,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

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

type Listener = (registrations: HandlerRegistration[]) => void;

class HandlerRegistry {
  private readonly registrations = new Map<string, HandlerRegistration[]>();
  private readonly listeners = new Set<Listener>();
  private readonly installedOn: WeakSet<object> = new WeakSet();

  getAll(): HandlerRegistration[] {
    const out: HandlerRegistration[] = [];
    for (const list of this.registrations.values()) {
      out.push(...list);
    }
    return out;
  }

  getForType(modelType: string): HandlerRegistration[] {
    const list = this.registrations.get(modelType);
    return list ? [...list] : [];
  }

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

  record(reg: HandlerRegistration): void {
    const existing = this.registrations.get(reg.modelType) ?? [];
    // Last-write-wins per (type, provider) pair; matches core's semantics.
    const filtered = existing.filter((r) => r.provider !== reg.provider);
    filtered.push(reg);
    filtered.sort((a, b) => b.priority - a.priority);
    this.registrations.set(reg.modelType, filtered);
    this.emit();
  }

  installOn(runtime: AgentRuntime): void {
    installPrototypePatch();
    const rt = runtime as AgentRuntime & { registerModel?: unknown };
    if (typeof rt.registerModel !== "function") return;
    if (this.installedOn.has(rt)) return;
    this.installedOn.add(rt);

    // If the runtime inherited the prototype patch we're done.
    const proto = Object.getPrototypeOf(rt) as {
      registerModel?: { [PATCH_MARK]?: true };
    } | null;
    if (proto?.registerModel?.[PATCH_MARK]) return;

    // Per-instance wrap as a fallback for runtimes constructed before the
    // prototype was patched (shouldn't happen in practice but defensive).
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
}

export const handlerRegistry = new HandlerRegistry();

const PATCH_MARK = Symbol.for("milady.local-inference.registerModel.patched");
let prototypePatched = false;

function installPrototypePatch(): void {
  if (prototypePatched) return;
  const proto = AgentRuntime.prototype as unknown as {
    registerModel: (
      this: AgentRuntime,
      modelType: string,
      handler: HandlerRegistration["handler"],
      provider: string,
      priority?: number,
    ) => void;
  };
  const original = proto.registerModel;
  if (typeof original !== "function") return;
  if ((original as unknown as { [PATCH_MARK]?: true })[PATCH_MARK]) {
    prototypePatched = true;
    return;
  }
  const patched = function patchedRegisterModel(
    this: AgentRuntime,
    modelType: string,
    handler: HandlerRegistration["handler"],
    provider: string,
    priority?: number,
  ): void {
    try {
      handlerRegistry.record({
        modelType: String(modelType),
        provider: String(provider),
        priority: typeof priority === "number" ? priority : 0,
        registeredAt: new Date().toISOString(),
        handler,
      });
    } catch {
      // Registry bookkeeping must never break registration.
    }
    original.call(this, modelType, handler, provider, priority);
  } as typeof original & { [PATCH_MARK]?: true };
  patched[PATCH_MARK] = true;
  proto.registerModel = patched;
  prototypePatched = true;
}

// Install at module-import time. Idempotent and benign — forwards to the
// original `registerModel` so core semantics are unchanged.
installPrototypePatch();

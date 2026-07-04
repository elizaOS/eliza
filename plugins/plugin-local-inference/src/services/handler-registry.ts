/**
 * Side-registry that mirrors the model handlers registered on an AgentRuntime.
 *
 * elizaOS core owns the model registry; this module keeps a handler-free mirror
 * of it so the settings API/UI can render a live [ModelType × Provider] routing
 * table and so `providers.ts` can report which slots a provider serves. It
 * stays in sync through the public core API — {@link IAgentRuntime.getModelRegistrations}
 * for the initial snapshot and the `MODEL_REGISTERED` runtime event for
 * subsequent registrations — instead of monkey-patching the runtime's
 * `registerModel` method on `AgentRuntime.prototype`.
 *
 * The mirror holds registration metadata only (never handler functions).
 * Actual dispatch/failover is core's job; the router-handler picks a provider
 * from this metadata and invokes it through live runtime introspection, so this
 * module never captures or calls a handler.
 */

import type { ModelRegisteredEventPayload } from "@elizaos/core";
import { EventType, type IAgentRuntime } from "@elizaos/core";

export interface HandlerRegistration {
	modelType: string;
	provider: string;
	priority: number;
	registeredAt: string;
}

type Listener = (registrations: HandlerRegistration[]) => void;

class HandlerRegistry {
	private readonly registrations = new Map<string, HandlerRegistration[]>();
	private readonly listeners = new Set<Listener>();
	private readonly installedOn = new WeakSet<object>();

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
	 * Registrations excluding a specific provider. Used by the router-handler's
	 * diagnostics to describe "all providers except me".
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
	 * Mirror a runtime's model registry into this side-registry. Idempotent
	 * per runtime instance. Seeds from the current registrations, then stays
	 * live via the `MODEL_REGISTERED` event — no prototype patching, no
	 * handler capture.
	 */
	installOn(runtime: IAgentRuntime): void {
		if (this.installedOn.has(runtime)) return;
		this.installedOn.add(runtime);

		const now = new Date().toISOString();
		for (const reg of runtime.getModelRegistrations()) {
			this.record({
				modelType: reg.modelType,
				provider: reg.provider,
				priority: reg.priority,
				registeredAt: now,
			});
		}

		runtime.registerEvent(
			EventType.MODEL_REGISTERED,
			async (payload: ModelRegisteredEventPayload) => {
				this.record({
					modelType: payload.modelType,
					provider: payload.provider,
					priority: payload.priority,
					registeredAt: new Date().toISOString(),
				});
			},
		);
	}
}

export const handlerRegistry = new HandlerRegistry();

/**
 * Public type used by the API/UI — the serialisable registration shape.
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

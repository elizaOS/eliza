/**
 * Core-owned ambient-context registry.
 *
 * Several core singletons (the trajectory + action-routing context managers,
 * the trajectory-source registry, the curated-app and app-route-plugin
 * registries) must be shared by every consumer regardless of which bundled copy
 * of `@elizaos/core` they imported from. Historically each site hand-rolled its
 * own `Symbol.for(...)` read/write against `globalThis`, plus a module-local
 * cache. The module-local caches were the real hazard: under a duplicated core
 * bundle each copy could cache a *different* instance while a
 * `set…Manager(...)` override wrote only the shared global, so reads and writes
 * disagreed and contexts interleaved.
 *
 * This module centralizes the pattern into one guarded accessor. The global
 * slot is the single source of truth — there is no module-local cache — so all
 * copies always observe the same instance, and an override is immediately
 * visible everywhere.
 *
 * The correct end-state is to externalize `@elizaos/core` in downstream bundle
 * configs so a second copy cannot load at all; until then this module makes the
 * dual-copy path as safe as it can be.
 */

type AmbientSlot = Record<PropertyKey, unknown>;

function ambientSlot(): AmbientSlot {
	return globalThis as AmbientSlot;
}

/**
 * Return the process-global singleton stored at `key`, creating it with
 * `factory` (and storing it) on first access. All bundled core copies share the
 * value because the read/write goes through `globalThis` under the same
 * `Symbol.for` key.
 */
export function getAmbientSingleton<T>(key: symbol, factory: () => T): T {
	const slot = ambientSlot();
	const existing = slot[key];
	if (existing !== undefined) {
		return existing as T;
	}
	const created = factory();
	slot[key] = created;
	return created;
}

/**
 * Overwrite the process-global singleton at `key`. Used by the test-only
 * `set…Manager` overrides that need every copy to observe the replacement.
 */
export function setAmbientSingleton<T>(key: symbol, value: T): void {
	ambientSlot()[key] = value;
}

/**
 * Read the process-global singleton at `key` without creating one. Returns
 * `undefined` when nothing has been stored yet.
 */
export function peekAmbientSingleton<T>(key: symbol): T | undefined {
	return ambientSlot()[key] as T | undefined;
}

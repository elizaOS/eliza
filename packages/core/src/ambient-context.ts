/** Shares ambient registries across bundled copies of core through global symbol slots. Each registry retains its own runtime-scoped ownership. */

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

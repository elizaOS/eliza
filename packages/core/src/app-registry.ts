export interface ElizaCuratedAppDefinition {
	slug: string;
	canonicalName: string;
	aliases: string[];
}

interface CuratedAppRegistryStore {
	entries: ElizaCuratedAppDefinition[];
}

const ELIZA_CURATED_APP_REGISTRY_KEY = Symbol.for(
	"elizaos.curated-app-registry",
);

function getCuratedAppRegistryStore(): CuratedAppRegistryStore {
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[ELIZA_CURATED_APP_REGISTRY_KEY] as
		| CuratedAppRegistryStore
		| null
		| undefined;
	if (existing) return existing;

	const created: CuratedAppRegistryStore = { entries: [] };
	globalObject[ELIZA_CURATED_APP_REGISTRY_KEY] = created;
	return created;
}

/**
 * Register an additional curated app definition at runtime.
 *
 * This is plugin-facing runtime API surface, so plugins can depend only on
 * `@elizaos/core` while app/shared consumers read the same global registry.
 */
export function registerCuratedApp(def: ElizaCuratedAppDefinition): void {
	const store = getCuratedAppRegistryStore();
	const existing = store.entries.findIndex((d) => d.slug === def.slug);
	if (existing >= 0) {
		store.entries[existing] = def;
	} else {
		store.entries.push(def);
	}
}

export function getRegisteredCuratedApps(): ElizaCuratedAppDefinition[] {
	return [...getCuratedAppRegistryStore().entries];
}

/**
 * UI registry host — the pluggable store backing module-scope UI registries
 * (overlay apps, app-shell pages, settings sections). Registries call
 * `getUiRegistryStore(key, create)` to obtain a stable per-key store; hosts can
 * swap the backing implementation (SSR isolation, test reset) via
 * `provideUiRegistryHost`.
 *
 * Lives in `@elizaos/shared` so both the React `@elizaos/ui` package and Node
 * code (app registration surfaces) reference one canonical store singleton
 * without the Node side importing the React package.
 */
export interface UiRegistryHost {
  getStore<T>(key: string, create: () => T): T;
}

// The store map lives on globalThis, not module scope: production chunk
// graphs can evaluate more than one copy of this module (an app entry graph
// and a lazily-imported plugin register chunk each bundling @elizaos/shared),
// and a module-scope map would give each copy its own "singleton" — plugin
// registrations would land in a dead registry the shell never reads. Keying
// off globalThis makes every copy converge on one store set, which is the
// registries' intent (they are process-global).
const GLOBAL_STORES_KEY = "__ELIZA_UI_REGISTRY_STORES__";

function globalStores(): Map<string, unknown> {
  const host = globalThis as Record<string, unknown>;
  let stores = host[GLOBAL_STORES_KEY] as Map<string, unknown> | undefined;
  if (!stores) {
    stores = new Map<string, unknown>();
    host[GLOBAL_STORES_KEY] = stores;
  }
  return stores;
}

class DefaultUiRegistryHost implements UiRegistryHost {
  private readonly stores = globalStores();

  getStore<T>(key: string, create: () => T): T {
    const existing = this.stores.get(key);
    if (existing !== undefined) return existing as T;
    const created = create();
    this.stores.set(key, created);
    return created;
  }
}

let activeRegistryHost: UiRegistryHost = new DefaultUiRegistryHost();

export function provideUiRegistryHost(host: UiRegistryHost): void {
  activeRegistryHost = host;
}

export function getUiRegistryStore<T>(key: string, create: () => T): T {
  return activeRegistryHost.getStore(key, create);
}

export function resetUiRegistryHostForTests(): void {
  globalStores().clear();
  activeRegistryHost = new DefaultUiRegistryHost();
}

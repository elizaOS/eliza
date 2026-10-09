/** Shared registry storage with host-provided isolation. */
export interface UiRegistryHost {
  getStore<T>(key: string, create: () => T): T;
}

// Lazy chunks can evaluate multiple module copies; they must share registrations.
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

export interface UiRegistryHost {
  getStore<T>(key: string, create: () => T): T;
}

class DefaultUiRegistryHost implements UiRegistryHost {
  private readonly stores = new Map<string, unknown>();

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
  activeRegistryHost = new DefaultUiRegistryHost();
}

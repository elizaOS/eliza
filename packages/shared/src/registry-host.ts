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

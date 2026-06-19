import { describe, expect, it, vi } from "vitest";

import {
  type IosAdapterDeps,
  type PersistenceAdapter,
  resolveIosPersistenceAdapter,
} from "./persistence.ts";

function fakeSqliteAdapter(): PersistenceAdapter {
  const store = new Map<string, string>();
  return {
    kind: "ios-sqlite",
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

function fakePreferencesAdapter(): PersistenceAdapter {
  const store = new Map<string, string>();
  return {
    kind: "ios-preferences",
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

describe("resolveIosPersistenceAdapter", () => {
  it("returns the SQLite adapter when the plugin is available", async () => {
    const sqlite = fakeSqliteAdapter();
    const deps: IosAdapterDeps = {
      isSqliteAvailable: vi.fn().mockResolvedValue(true),
      openSqliteAdapter: vi.fn().mockResolvedValue(sqlite),
      resolvePreferencesAdapter: vi.fn(),
    };

    const adapter = await resolveIosPersistenceAdapter(deps);

    expect(adapter.kind).toBe("ios-sqlite");
    expect(deps.openSqliteAdapter).toHaveBeenCalledTimes(1);
    expect(deps.resolvePreferencesAdapter).not.toHaveBeenCalled();
  });

  it("falls back to Capacitor Preferences when SQLite is unavailable", async () => {
    const preferences = fakePreferencesAdapter();
    const deps: IosAdapterDeps = {
      isSqliteAvailable: vi.fn().mockResolvedValue(false),
      openSqliteAdapter: vi.fn(),
      resolvePreferencesAdapter: vi.fn().mockResolvedValue(preferences),
    };

    const adapter = await resolveIosPersistenceAdapter(deps);

    expect(adapter.kind).toBe("ios-preferences");
    expect(deps.openSqliteAdapter).not.toHaveBeenCalled();
    expect(deps.resolvePreferencesAdapter).toHaveBeenCalledTimes(1);
  });
});

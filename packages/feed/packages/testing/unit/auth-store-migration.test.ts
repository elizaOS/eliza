import { beforeEach, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();

const storageMock = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
  key(index: number) {
    return Array.from(storage.keys())[index] ?? null;
  },
  get length() {
    return storage.size;
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: storageMock,
  configurable: true,
});

const { migrateAuthStoreState } = await import("@/stores/authStore");

beforeEach(() => {
  storage.clear();
});

describe("migrateAuthStoreState", () => {
  test("migrates persisted auth data from legacy versions, strips ephemeral fields", () => {
    const migrated = migrateAuthStoreState(
      {
        user: {
          id: "did:privy:test-user",
          displayName: "Test User",
          username: "test-user",
        },
        loadedUserId: "did:privy:test-user",
        isLoadingProfile: true,
        needsOnboarding: true,
      },
      1,
    );

    // isLoadingProfile and needsOnboarding are ephemeral — not persisted
    expect(migrated).toEqual({
      user: {
        id: "did:privy:test-user",
        displayName: "Test User",
        username: "test-user",
      },
      loadedUserId: "did:privy:test-user",
    });
  });

  test("falls back to the default state for malformed persisted payloads", () => {
    expect(migrateAuthStoreState("invalid", 1)).toEqual({
      user: null,
      loadedUserId: null,
    });
  });

  test("migrates version 0 payloads (no version ever set)", () => {
    const migrated = migrateAuthStoreState(
      {
        user: {
          id: "did:privy:test-user",
          displayName: "Test User",
        },
        needsOnboarding: true,
      },
      0,
    );

    expect(migrated).toEqual({
      user: {
        id: "did:privy:test-user",
        displayName: "Test User",
      },
      loadedUserId: null,
    });
  });

  test("migrates version 2, 3, and 4 payloads and strips ephemeral fields", () => {
    for (const version of [2, 3, 4]) {
      const migrated = migrateAuthStoreState(
        {
          user: {
            id: "did:privy:test-user",
            displayName: "Test User",
            username: "test-user",
          },
          loadedUserId: "did:privy:test-user",
          isLoadingProfile: true,
          needsOnboarding: true,
        },
        version,
      );

      expect(migrated).toEqual({
        user: {
          id: "did:privy:test-user",
          displayName: "Test User",
          username: "test-user",
        },
        loadedUserId: "did:privy:test-user",
      });
    }
  });

  test("drops partial user objects that do not satisfy the persisted user guard", () => {
    const migrated = migrateAuthStoreState(
      {
        user: { id: "did:privy:test-user" },
      },
      1,
    );

    expect(migrated.user).toBeNull();
  });

  test("drops unsupported future-version payloads instead of hydrating unknown state", () => {
    const migrated = migrateAuthStoreState(
      {
        user: {
          id: "did:privy:test-user",
          displayName: "Test User",
        },
        needsOnboarding: true,
      },
      6,
    );

    expect(migrated).toEqual({
      user: null,
      loadedUserId: null,
    });
  });
});

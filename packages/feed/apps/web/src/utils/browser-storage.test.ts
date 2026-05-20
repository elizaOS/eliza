import { afterEach, describe, expect, it } from "bun:test";
import {
  createSafeStorage,
  listStorageKeys,
  readStorageItem,
  readStorageJson,
  removeStorageItem,
  writeStorageItem,
} from "./browser-storage";

interface MockStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  key: (index: number) => string | null;
  readonly length: number;
}

const originalWindow = globalThis.window;

function createMemoryStorage(
  initialEntries: Record<string, string> = {},
): MockStorage {
  const store = new Map(Object.entries(initialEntries));

  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function setWindow(windowValue: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("browser-storage", () => {
  it("reads, writes, removes, and lists keys when storage is available", () => {
    const localStorage = createMemoryStorage({ existing: "value" });
    const sessionStorage = createMemoryStorage();

    setWindow({ localStorage, sessionStorage });

    expect(readStorageItem("localStorage", "existing")).toBe("value");
    expect(writeStorageItem("localStorage", "new-key", "new-value")).toBe(true);
    expect(
      readStorageJson<{ ok: boolean }>("localStorage", "new-key"),
    ).toBeNull();

    expect(
      writeStorageItem("sessionStorage", "json", JSON.stringify({ ok: true })),
    ).toBe(true);
    expect(readStorageJson<{ ok: boolean }>("sessionStorage", "json")).toEqual({
      ok: true,
    });

    expect(listStorageKeys("localStorage").sort()).toEqual([
      "existing",
      "new-key",
    ]);

    expect(removeStorageItem("localStorage", "existing")).toBe(true);
    expect(readStorageItem("localStorage", "existing")).toBeNull();
  });

  it("returns neutral values when browser storage access throws", () => {
    const throwingWindow = {};

    Object.defineProperty(throwingWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    Object.defineProperty(throwingWindow, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    setWindow(throwingWindow);

    expect(readStorageItem("localStorage", "key")).toBeNull();
    expect(readStorageJson("sessionStorage", "key")).toBeNull();
    expect(writeStorageItem("localStorage", "key", "value")).toBe(false);
    expect(removeStorageItem("sessionStorage", "key")).toBe(false);
    expect(listStorageKeys("localStorage")).toEqual([]);
  });

  it("exposes a zustand-compatible storage adapter", () => {
    const localStorage = createMemoryStorage();
    setWindow({ localStorage, sessionStorage: createMemoryStorage() });

    const storage = createSafeStorage("localStorage");
    storage.setItem("feed-auth", '{"state":{}}');

    expect(storage.getItem("feed-auth")).toBe('{"state":{}}');

    storage.removeItem("feed-auth");
    expect(storage.getItem("feed-auth")).toBeNull();
  });
});

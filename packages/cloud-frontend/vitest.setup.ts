import "@testing-library/jest-dom/vitest";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  const current = window[name] as Partial<Storage> | undefined;
  if (
    typeof current?.clear === "function" &&
    typeof current.getItem === "function" &&
    typeof current.setItem === "function"
  ) {
    return;
  }
  Object.defineProperty(window, name, {
    configurable: true,
    value: createStorage(),
  });
}

if (typeof window !== "undefined") {
  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
}

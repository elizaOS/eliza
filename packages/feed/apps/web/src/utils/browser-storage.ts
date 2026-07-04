import { createJSONStorage, type StateStorage } from "zustand/middleware";

export type BrowserStorageType = "localStorage" | "sessionStorage";

function getStorage(type: BrowserStorageType): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window[type];
  } catch {
    // error-policy:J4 storage access throws in private-mode / blocked-cookie browsers; feature degrades to no-storage
    return null;
  }
}

export function readStorageItem(
  type: BrowserStorageType,
  key: string,
): string | null {
  const storage = getStorage(type);
  if (!storage) return null;

  try {
    return storage.getItem(key);
  } catch {
    // error-policy:J4 getItem can throw under storage pressure / privacy modes; feature degrades to absent value
    return null;
  }
}

export function readStorageJson<T>(
  type: BrowserStorageType,
  key: string,
): T | null {
  const stored = readStorageItem(type, key);
  if (!stored) return null;

  try {
    return JSON.parse(stored) as T;
  } catch {
    // error-policy:J3 stored value is untrusted (may be stale/corrupt); unparseable JSON is invalid, null is the explicit "no usable value" signal
    return null;
  }
}

export function writeStorageItem(
  type: BrowserStorageType,
  key: string,
  value: string,
): boolean {
  const storage = getStorage(type);
  if (!storage) return false;

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    // error-policy:J4 setItem throws on quota-exceeded / private mode; false lets the caller degrade without crashing the UI
    return false;
  }
}

export function removeStorageItem(
  type: BrowserStorageType,
  key: string,
): boolean {
  const storage = getStorage(type);
  if (!storage) return false;

  try {
    storage.removeItem(key);
    return true;
  } catch {
    // error-policy:J4 removeItem throws in private mode / blocked storage; false lets the caller degrade without crashing the UI
    return false;
  }
}

export function listStorageKeys(type: BrowserStorageType): string[] {
  const storage = getStorage(type);
  if (!storage) return [];

  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    // error-policy:J4 storage enumeration throws in private mode / blocked storage; empty list degrades the feature without crashing the UI
    return [];
  }
}

export function createSafeStorage(type: BrowserStorageType): StateStorage {
  return {
    getItem: (key) => readStorageItem(type, key),
    setItem: (key, value) => {
      writeStorageItem(type, key, value);
    },
    removeItem: (key) => {
      removeStorageItem(type, key);
    },
  };
}

export function createSafeJsonStorage<T>(type: BrowserStorageType) {
  return createJSONStorage<T>(() => createSafeStorage(type));
}

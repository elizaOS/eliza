// @vitest-environment jsdom
/**
 * `RuntimeSettingsSection`'s "Switch runtime" action must:
 *   1. clear the persisted mobile runtime mode + active server,
 *   2. set the URL's `?runtime=picker` flag (consumed by RuntimeGate's
 *      `hasPickerOverride()`),
 *   3. trigger a navigation so the splash unmounts and the picker tiles
 *      render.
 *
 * The section itself only renders on ElizaOS (the only platform where
 * the picker is bypassed by default). The visibility gate lives in
 * `SettingsView.tsx`; this file targets the action helper directly so we
 * don't have to mount the full Settings shell.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __TEST_ONLY__,
  reloadIntoRuntimePicker,
} from "../../../src/onboarding/reload-into-runtime-picker";

const { ACTIVE_SERVER_STORAGE_KEY, MOBILE_RUNTIME_MODE_STORAGE_KEY } =
  __TEST_ONLY__;

const ORIGINAL_LOCATION = window.location;

function setLocation(href: string): void {
  // jsdom's Location is read-only via assignment, but writable via property
  // override. We replace the whole object with a writable URL-like stand-in
  // so the helper's `window.location.href = ...` assignment lands somewhere
  // observable.
  const url = new URL(href);
  const stand: Partial<Location> & { href: string } = {
    href: url.href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    host: url.host,
    hostname: url.hostname,
    protocol: url.protocol,
    port: url.port,
    assign: (next: string) => {
      stand.href = next;
    },
    replace: (next: string) => {
      stand.href = next;
    },
    reload: () => {},
  };
  Object.defineProperty(window, "location", {
    value: stand,
    configurable: true,
    writable: true,
  });
}

function installMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

describe("RuntimeSettingsSection — reloadIntoRuntimePicker", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = installMemoryLocalStorage();
    storage.clear();
    setLocation("https://localhost/");
  });

  afterEach(() => {
    storage.clear();
    Object.defineProperty(window, "location", {
      value: ORIGINAL_LOCATION,
      configurable: true,
      writable: true,
    });
  });

  it("clears the persisted runtime mode and active server", () => {
    storage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");
    storage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify({ id: "local:android", kind: "remote" }),
    );

    reloadIntoRuntimePicker();

    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBeNull();
  });

  it("appends ?runtime=picker to the current URL", () => {
    reloadIntoRuntimePicker();
    expect(window.location.href).toContain("runtime=picker");
  });

  it("preserves existing query params alongside ?runtime=picker", () => {
    setLocation("https://localhost/some/path?foo=bar&baz=1");
    reloadIntoRuntimePicker();

    const result = new URL(window.location.href);
    expect(result.searchParams.get("foo")).toBe("bar");
    expect(result.searchParams.get("baz")).toBe("1");
    expect(result.searchParams.get("runtime")).toBe("picker");
  });

  it("overwrites a stale ?runtime= value rather than appending a duplicate", () => {
    setLocation("https://localhost/?runtime=stale");
    reloadIntoRuntimePicker();

    const result = new URL(window.location.href);
    expect(result.searchParams.get("runtime")).toBe("picker");
    // URLSearchParams.set replaces — there must be exactly one `runtime` key.
    const allRuntimeValues = result.searchParams.getAll("runtime");
    expect(allRuntimeValues).toEqual(["picker"]);
  });
});

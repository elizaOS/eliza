/**
 * Unit coverage for the store-only `boot-config` entry point: it must re-export
 * the boot-config-store runtime surface unchanged and stay loadable without the
 * react runtime, because Bun/Node API paths import this module directly.
 * Deterministic suite against the real modules; no behavior is mocked — the
 * single vi.mock below is a tripwire that fails the file if a runtime react
 * import ever appears in the entry's module graph.
 */
import { describe, expect, it, vi } from "vitest";

// Tripwire, not a stub: the factory only runs if something under test resolves
// react at runtime, and it throws so collection fails loudly. When the entry
// honours its react-free contract this factory is never invoked.
vi.mock("react", () => {
  throw new Error(
    "boot-config.ts must be loadable without react; a runtime react import appeared",
  );
});

import * as entry from "./boot-config.js";
import * as store from "./boot-config-store.js";

const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

type GlobalSlot = Record<PropertyKey, unknown>;

function resetGlobalStore(): void {
  const slot = globalThis as GlobalSlot;
  delete slot[STORE_KEY];
  delete slot[WINDOW_KEY];
}

describe("boot-config entry surface", () => {
  it("re-exports exactly the boot-config-store runtime surface", () => {
    expect(Object.keys(entry).sort()).toEqual(Object.keys(store).sort());
    // Guard against a vacuous parity pass over two empty namespaces: the four
    // documented value exports must each be reachable through the entry.
    expect(Object.keys(entry).sort()).toContain("DEFAULT_BOOT_CONFIG");
    expect(typeof entry.getBootConfig).toBe("function");
    expect(typeof entry.setBootConfig).toBe("function");
    expect(typeof entry.resolveCharacterCatalog).toBe("function");
  });

  it("re-exports DEFAULT_BOOT_CONFIG by identity, not a copy", () => {
    expect(entry.DEFAULT_BOOT_CONFIG).toBe(store.DEFAULT_BOOT_CONFIG);
  });

  it("loads without loading react (Bun/Node API-path contract)", async () => {
    // The hoisted tripwire above guards every import in this file; this case
    // makes that guarantee explicit and asserts the resolved namespace shape.
    const loaded = await import("./boot-config.js");
    expect(typeof loaded.getBootConfig).toBe("function");
    expect(typeof loaded.setBootConfig).toBe("function");
  });
});

describe("boot config store through the entry point", () => {
  it("getBootConfig serves DEFAULT_BOOT_CONFIG before any setBootConfig call", () => {
    resetGlobalStore();
    expect(entry.getBootConfig()).toBe(entry.DEFAULT_BOOT_CONFIG);
    resetGlobalStore();
  });

  it("setBootConfig replaces the live config and mirrors it to the window key", () => {
    resetGlobalStore();
    const next = {
      ...entry.DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://entry.example",
    };
    entry.setBootConfig(next);
    expect(entry.getBootConfig()).toBe(next);
    expect((globalThis as GlobalSlot)[WINDOW_KEY]).toBe(next);
    resetGlobalStore();
  });

  it("an established store wins over later writes to the window mirror", () => {
    resetGlobalStore();
    const seeded = {
      ...entry.DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://seeded.example",
    };
    (globalThis as GlobalSlot)[WINDOW_KEY] = seeded;
    expect(entry.getBootConfig()).toBe(seeded);
    // The window key is a pre-boot seed only; it must never replace a live store.
    (globalThis as GlobalSlot)[WINDOW_KEY] = {
      ...entry.DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://late.example",
    };
    expect(entry.getBootConfig()).toBe(seeded);
    resetGlobalStore();
  });
});

describe("resolveCharacterCatalog empty-catalog edges through the entry point", () => {
  it("resolves an empty catalog to zero assets and a null default without throwing", () => {
    const resolved = entry.resolveCharacterCatalog({
      assets: [],
      injectedCharacters: [],
    });
    expect(resolved.assetCount).toBe(0);
    expect(resolved.defaultAsset).toBeNull();
    expect(resolved.assets).toEqual([]);
    expect(resolved.injectedCharacters).toEqual([]);
    expect(resolved.injectedCharacterCount).toBe(0);
  });

  it("getAsset returns null for any id when the catalog has no default fallback", () => {
    const resolved = entry.resolveCharacterCatalog({
      assets: [],
      injectedCharacters: [],
    });
    expect(resolved.getAsset(1)).toBeNull();
  });

  it("getInjectedCharacter misses return null instead of throwing on an empty catalog", () => {
    const resolved = entry.resolveCharacterCatalog({
      assets: [],
      injectedCharacters: [],
    });
    expect(resolved.getInjectedCharacter("anything")).toBeNull();
  });
});

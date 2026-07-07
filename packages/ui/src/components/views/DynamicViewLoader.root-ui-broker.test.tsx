// @vitest-environment jsdom
//
// The root `@elizaos/ui` host-external must not be a broker escape hatch
// (#14237). The barrel re-exports the RAW navigation/storage helpers, so a view
// importing them from `@elizaos/ui` — instead of the wrapped `@elizaos/ui/*`
// subpaths — could reach host `window.history` / `window.localStorage` outside
// the surface-realm scope. These tests drive the real `hostImport` seam a served
// view-bundle factory receives and prove the root barrel now hands back the SAME
// scope-brokered wrappers as the subpaths. Unit/element level only (no <App/>).

import { resolveSurfaceManifest } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";
import { hostImport } from "./DynamicViewLoader";

// In-memory Storage so the scope's façade runs against a real Storage-shaped
// backing that is NOT the jsdom global localStorage — a wrapped write lands
// here, a raw (escape-hatch) write would land in window.localStorage instead.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  [name: string]: unknown;
}

const VIEW_ID = "root.import.view";

describe("root @elizaos/ui import is broker-scoped, not an escape hatch (#14237)", () => {
  let backing: MemoryStorage;

  beforeEach(() => {
    backing = new MemoryStorage();
    // A no-grants scope: storage is confined to the view namespace, navigation
    // is denied. The raw navigate must never be reached — if the wrapper falls
    // through to it, this throws a distinct error and fails the assertion.
    const scope = new SurfaceRealmScope(
      resolveSurfaceManifest({ surface: { capabilities: [] } }),
      VIEW_ID,
      backing,
      () => {
        throw new Error("raw shell navigate reached — broker was bypassed");
      },
    );
    setActiveSurfaceRealmScope(scope);
  });

  afterEach(() => {
    setActiveSurfaceRealmScope(null);
    window.localStorage.clear();
  });

  it("root navigateBrowserPath is the scope-brokered wrapper (denied without the grant), like the subpath", async () => {
    const rootMod = await hostImport("@elizaos/ui");
    const navigate = rootMod.navigateBrowserPath as (path: string) => void;
    expect(typeof navigate).toBe("function");

    // Brokered: a no-navigate-grant scope raises an observable denial instead of
    // driving host history. The RAW barrel export would pushState and not throw.
    expect(() => navigate("/hijack")).toThrow(SurfaceRealmDeniedError);

    // Parity with the wrapped subpath specifier: same brokered behavior.
    const subMod = await hostImport("@elizaos/ui/app-navigate-view");
    const subNavigate = subMod.navigateBrowserPath as (path: string) => void;
    expect(() => subNavigate("/hijack")).toThrow(SurfaceRealmDeniedError);
    // Resolving the whole `@elizaos/ui` barrel graph in jsdom is slow (~25s).
  }, 120_000);

  it("root storage helpers write through the scoped namespace, never the host keyspace", async () => {
    const rootMod = await hostImport("@elizaos/ui");
    const setStorageValue = rootMod.setStorageValue as (
      key: string,
      value: string,
    ) => Promise<void>;
    const getStorageValue = rootMod.getStorageValue as (
      key: string,
    ) => Promise<string | null>;

    await setStorageValue("probe-key", "probe-value");

    // Scoped away from the host keyspace...
    expect(backing.getItem("probe-key")).toBeNull();
    expect(window.localStorage.getItem("probe-key")).toBeNull();
    // ...and confined to the view-prefixed namespace instead.
    expect(backing.getItem(`surface:view:${VIEW_ID}:probe-key`)).toBe(
      "probe-value",
    );
    // The view reads back its own scoped value transparently.
    expect(await getStorageValue("probe-key")).toBe("probe-value");
  }, 120_000);

  it("cached broker helpers cannot borrow the next active view's scope", async () => {
    const firstNavigateMod = await hostImport("@elizaos/ui/app-navigate-view");
    const firstBridgeMod = await hostImport("@elizaos/ui/bridge");
    const firstNavigate = firstNavigateMod.navigateBrowserPath as (
      path: string,
    ) => void;
    const firstSetStorageValue = firstBridgeMod.setStorageValue as (
      key: string,
      value: string,
    ) => Promise<void>;
    const secondBacking = new MemoryStorage();
    const secondScope = new SurfaceRealmScope(
      resolveSurfaceManifest({
        surface: { capabilities: ["navigate", "storage"] },
      }),
      "second.view",
      secondBacking,
      () => {
        throw new Error("stale helper borrowed the second view navigate scope");
      },
    );

    setActiveSurfaceRealmScope(secondScope);

    expect(() => firstNavigate("/stale")).toThrow(SurfaceRealmDeniedError);
    await expect(firstSetStorageValue("probe-key", "stale")).rejects.toThrow(
      SurfaceRealmDeniedError,
    );
    expect(secondBacking.getItem("probe-key")).toBeNull();
  }, 120_000);

  it("the raw app-navigate-view helper (the pre-fix barrel export) bypasses the scope — proving the fix closes a real hole", async () => {
    const raw = await import("../../app-navigate-view");
    const rawNavigate = raw.navigateBrowserPath;
    // The raw helper reaches window.history directly and never consults the
    // scope, so it does NOT throw under the no-grant scope. This is exactly the
    // escape hatch the root barrel used to re-export; the root import above no
    // longer resolves to it.
    expect(() => rawNavigate("/raw-path")).not.toThrow();
  });

  it("neither the root nor the bridge barrel hands a view the shell-privileged raw-global channel", async () => {
    // `shellLocalStorage` / `shellHistory` / `runAsPrivilegedShell` disarm the
    // raw-global guards; handing them to a view bundle lets it write reserved
    // shell keys and drive shell navigation unscoped. The bridge barrel
    // re-exports them (for shell code outside packages/ui) and the ROOT barrel
    // re-exports the bridge barrel — so both compat surfaces must strip them.
    // Object spread cannot delete a key the source already carries, so the fix
    // destructures the channel out of `root` too (not just `bridge`); this is
    // the regression guard for that.
    const rootMod = await hostImport("@elizaos/ui");
    const bridgeMod = await hostImport("@elizaos/ui/bridge");
    for (const mod of [rootMod, bridgeMod]) {
      expect(mod.shellLocalStorage).toBeUndefined();
      expect(mod.shellHistory).toBeUndefined();
      expect(mod.runAsPrivilegedShell).toBeUndefined();
    }
  }, 120_000);
});

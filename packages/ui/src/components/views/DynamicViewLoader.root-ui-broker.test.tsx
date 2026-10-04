/** Verifies root @elizaos/ui import is broker-scoped, not an escape hatch (#14237) through the package's configured test harness. */
// @vitest-environment jsdom
//
// View bundles receive navigation and storage wrappers bound to the importing
// view's scope. Host bootstrap and raw privileged channels remain private.
import "./view-public-api";

import { resolveSurfaceManifest } from "@elizaos/core/protocol";
import { createMemoryStorage } from "@elizaos/testing/browser-mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";
import { hostImport } from "./DynamicViewLoader";

const VIEW_ID = "root.import.view";

describe("root @elizaos/ui import is broker-scoped, not an escape hatch (#14237)", () => {
  let backing: Storage;

  beforeEach(() => {
    backing = createMemoryStorage();
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

  it("does not adopt a replacement scope while an external import is awaiting", async () => {
    const pending = hostImport("@elizaos/ui");
    setActiveSurfaceRealmScope(
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: ["navigate"] } }),
        "replacement",
        backing,
        () => {
          throw new Error("Replacement owner was borrowed");
        },
      ),
    );
    const external = await pending;
    const navigate = external.navigateBrowserPath as (path: string) => void;
    expect(() => navigate("/borrowed")).toThrow(SurfaceRealmDeniedError);
  });

  it("root navigation requires the view navigation grant", async () => {
    const rootMod = await hostImport("@elizaos/ui");
    const navigate = rootMod.navigateBrowserPath as (path: string) => void;
    expect(typeof navigate).toBe("function");

    // Brokered: a no-navigate-grant scope raises an observable denial instead of
    // driving host history. The RAW barrel export would pushState and not throw.
    expect(() => navigate("/hijack")).toThrow(SurfaceRealmDeniedError);

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
    const firstNavigateMod = await hostImport("@elizaos/ui");
    const firstBridgeMod = await hostImport("@elizaos/ui");
    const firstNavigate = firstNavigateMod.navigateBrowserPath as (
      path: string,
    ) => void;
    const firstSetStorageValue = firstBridgeMod.setStorageValue as (
      key: string,
      value: string,
    ) => Promise<void>;
    const secondBacking = createMemoryStorage();
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

  it("does not hand a view host-only configuration or realm ownership", async () => {
    // `shellLocalStorage` / `shellHistory` / `runAsPrivilegedShell` disarm the
    // raw-global guards; handing them to a view bundle lets it write reserved
    // shell keys and drive shell navigation unscoped. The bridge barrel
    // re-exports them (for shell code outside packages/ui) and the ROOT barrel
    // re-exports the bridge barrel — so both compat surfaces must strip them.
    // Object spread cannot delete a key the source already carries, so the fix
    // destructures the channel out of `root` too (not just `bridge`); this is
    // the regression guard for that.
    const rootMod = await hostImport("@elizaos/ui");
    for (const mod of [rootMod]) {
      expect(mod.shellLocalStorage).toBeUndefined();
      expect(mod.shellHistory).toBeUndefined();
      expect(mod.runAsPrivilegedShell).toBeUndefined();
      expect(mod.configureHostTransport).toBeUndefined();
      expect(mod.configureHostAgentCapabilities).toBeUndefined();
      expect(mod.configureRuntimeManagement).toBeUndefined();
      expect(mod.setActiveSurfaceRealmScope).toBeUndefined();
      expect(mod.SurfaceRealmScope).toBeUndefined();
      expect(mod.registerHostExternalImporter).toBeUndefined();
    }
  }, 120_000);

  it("provides shared chrome and settings composites through the root", async () => {
    const shared = await hostImport("@elizaos/ui");
    expect(shared.ViewHeader).toEqual(expect.any(Function));
    expect(shared.ViewBackButton).toEqual(expect.any(Function));
    expect(shared.SectionNav).toEqual(expect.any(Function));
    expect(shared.ActionListRow).toEqual(expect.any(Function));
    expect(shared.AppPageSidebar).toBeDefined();

    const settings = await hostImport("@elizaos/ui");
    expect(settings.SettingsStack).toEqual(expect.any(Function));
    expect(settings.SettingsGroup).toEqual(expect.any(Function));
    expect(settings.SettingsRow).toBeDefined();
  });
});

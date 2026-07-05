// @vitest-environment jsdom
//
// In-process host-realm broker (#14179): each of the four remaining mutation
// vectors — storage, navigation, root/body classes, `:root` CSS vars — is gated
// on the resolved surface manifest. Every vector has a negative (no grant →
// scoped/denied) and positive (grant → allowed) case, mirroring the read-only
// vs agent-surface split in `view-capability-broker.test.tsx`. Pure logic +
// real jsdom DOM; no `<App/>` harness (the shell wiring is proven in
// `App.surface-mutation-fuzz.test.tsx`).

import { resolveSurfaceManifest, type SurfaceCapability } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brokerSurfaceNavigate,
  brokerSurfaceStorage,
  isShellReservedStorageKey,
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  surfaceViewStoragePrefix,
} from "./surface-realm-broker";

const withGrants = (...caps: SurfaceCapability[]) =>
  resolveSurfaceManifest({ surface: { capabilities: caps } });

const NO_GRANTS = resolveSurfaceManifest({ surface: { capabilities: [] } });

// A throwaway in-memory Storage so the broker's façades run against a real
// Storage-shaped backing without touching the jsdom global localStorage.
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

describe("isShellReservedStorageKey", () => {
  it("recognizes the shell's own persistence namespaces", () => {
    for (const key of [
      "eliza:ui-theme",
      "elizaos:active-server",
      "eliza_avatar_index",
    ]) {
      expect(isShellReservedStorageKey(key)).toBe(true);
    }
  });
  it("does not claim view keys as shell-reserved", () => {
    for (const key of ["my-key", "plugin.state", "surface:view:x:eliza:foo"]) {
      expect(isShellReservedStorageKey(key)).toBe(false);
    }
  });
});

describe("brokerSurfaceStorage — storage vector", () => {
  let backing: MemoryStorage;
  beforeEach(() => {
    backing = new MemoryStorage();
    // The shell owns this key before any view runs.
    backing.setItem("eliza:ui-theme", "dark");
  });

  it("WITHOUT the storage grant, a view write to a shell key lands in the view namespace, never the shell key", () => {
    const store = brokerSurfaceStorage(NO_GRANTS, backing, "rogue.view");
    store.setItem("eliza:ui-theme", "light");
    // The shell key is untouched — the rogue write was scoped away.
    expect(backing.getItem("eliza:ui-theme")).toBe("dark");
    // It landed under the view-prefixed keyspace instead.
    expect(
      backing.getItem(
        `${surfaceViewStoragePrefix("rogue.view")}eliza:ui-theme`,
      ),
    ).toBe("light");
    // The view reads back its OWN namespaced value transparently.
    expect(store.getItem("eliza:ui-theme")).toBe("light");
  });

  it("WITHOUT the grant, the view's keyspace is fully isolated (length/key/clear stay within the namespace)", () => {
    const store = brokerSurfaceStorage(NO_GRANTS, backing, "v1");
    store.setItem("a", "1");
    store.setItem("b", "2");
    expect(store.length).toBe(2);
    expect([store.key(0), store.key(1)].sort()).toEqual(["a", "b"]);
    store.clear();
    expect(store.length).toBe(0);
    // clear() only removed the view's keys — the shell key survives.
    expect(backing.getItem("eliza:ui-theme")).toBe("dark");
  });

  it("WITH the storage grant, a view uses the host keyspace but still cannot write a reserved shell key", () => {
    const store = brokerSurfaceStorage(
      withGrants("storage"),
      backing,
      "trusted",
    );
    store.setItem("plugin.pref", "on");
    // A host-keyspace (non-reserved) write lands un-prefixed.
    expect(backing.getItem("plugin.pref")).toBe("on");
    // A shell key is still off-limits — observable denial, not a silent no-op.
    expect(() => store.setItem("eliza:ui-theme", "light")).toThrow(
      SurfaceRealmDeniedError,
    );
    expect(() => store.removeItem("eliza:ui-theme")).toThrow(
      SurfaceRealmDeniedError,
    );
    expect(backing.getItem("eliza:ui-theme")).toBe("dark");
  });
});

describe("brokerSurfaceNavigate — navigation vector", () => {
  it("WITHOUT the navigate grant, throws and never calls the shell navigate", () => {
    let called: string | null = null;
    const navigate = brokerSurfaceNavigate(NO_GRANTS, "rogue.view", (p) => {
      called = p;
    });
    expect(() => navigate("/somewhere")).toThrow(SurfaceRealmDeniedError);
    expect(called).toBeNull();
  });

  it("WITH the navigate grant, delegates to the shell navigate", () => {
    let called: string | null = null;
    const navigate = brokerSurfaceNavigate(
      withGrants("navigate"),
      "trusted",
      (p) => {
        called = p;
      },
    );
    navigate("/settings");
    expect(called).toBe("/settings");
  });

  it("an unrelated grant does not unlock navigation (fails closed)", () => {
    const navigate = brokerSurfaceNavigate(
      withGrants("storage", "wallpaper"),
      "v",
      () => undefined,
    );
    expect(() => navigate("/x")).toThrow(SurfaceRealmDeniedError);
  });
});

describe("SurfaceRealmScope.resetHostRealm — root/body class + :root var vector", () => {
  beforeEach(() => {
    // Shell-owned baseline the reset must preserve.
    document.documentElement.className = "dark";
    document.body.className = "platform-web native";
    document.documentElement.style.setProperty("--accent", "#f60");
    document.documentElement.style.setProperty("--bg", "#000");
  });
  afterEach(() => {
    document.documentElement.className = "";
    document.body.className = "";
    document.documentElement.removeAttribute("style");
  });

  function makeScope(): SurfaceRealmScope {
    return new SurfaceRealmScope(
      NO_GRANTS,
      "view.a",
      new MemoryStorage(),
      () => undefined,
    );
  }

  it("removes a view-injected root class and :root var, preserving shell-owned tokens", () => {
    // Scope captures the baseline at activation, BEFORE the view injects.
    const scope = makeScope();
    // The view reaches the host realm directly (bypassing its host node).
    document.documentElement.classList.add("rogue-root-class");
    document.body.classList.add("rogue-body-class");
    document.documentElement.style.setProperty("--rogue-var", "red");

    const removed = scope.resetHostRealm();

    // View injections are gone.
    expect(
      document.documentElement.classList.contains("rogue-root-class"),
    ).toBe(false);
    expect(document.body.classList.contains("rogue-body-class")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--rogue-var")).toBe(
      "",
    );
    expect(removed.rootClasses).toContain("rogue-root-class");
    expect(removed.bodyClasses).toContain("rogue-body-class");
    expect(removed.rootVars).toContain("--rogue-var");

    // Shell-owned tokens survive.
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.body.classList.contains("platform-web")).toBe(true);
    expect(document.body.classList.contains("native")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "#f60",
    );
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(
      "#000",
    );
  });

  it("does not strip a token that was already present when the view activated (only what the view added)", () => {
    // A plugin-provided token present at activation (e.g. a content-pack var).
    document.documentElement.style.setProperty("--pack-custom-token", "blue");
    document.documentElement.classList.add("pack-preset-a");
    const scope = makeScope();
    // The view injects on top.
    document.documentElement.style.setProperty("--rogue-var", "red");

    scope.resetHostRealm();

    // Pre-activation tokens preserved; view injection removed.
    expect(
      document.documentElement.style.getPropertyValue("--pack-custom-token"),
    ).toBe("blue");
    expect(document.documentElement.classList.contains("pack-preset-a")).toBe(
      true,
    );
    expect(document.documentElement.style.getPropertyValue("--rogue-var")).toBe(
      "",
    );
  });

  it("preserves a theme class toggled ON while the view was active (shell writers stay allowed)", () => {
    document.documentElement.className = "light";
    const scope = makeScope();
    // Shell toggles theme mid-view (light -> dark).
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
    // View injects its own class.
    document.documentElement.classList.add("rogue-root-class");

    scope.resetHostRealm();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      document.documentElement.classList.contains("rogue-root-class"),
    ).toBe(false);
  });
});

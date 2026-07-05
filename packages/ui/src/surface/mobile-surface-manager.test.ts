/**
 * Proves the mobile surface manager (#14182) is driven by the resolved manifest,
 * not by hard-coded policy, and — the load-bearing test — that state written into
 * an isolated native surface CANNOT be read from the host web surface or a
 * sibling surface. The shell double is faithful, not a stub: it models each
 * `WKWebView`/`WebView` surface's own storage + process partition exactly the way
 * the native side does, so "isolated ⇒ own empty partition, shared ⇒ the host
 * partition" is a real property the manager's policy choice produces. Deleting
 * the manager's manifest read (hard-coding placement) turns the manifest-driven
 * assertions red; making the isolated surface share the host partition turns the
 * leak assertions red — neither is vacuous.
 */

import type { SurfaceManifest } from "@elizaos/core";
import { resolveSurfaceManifest } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileSurfaceManager,
  type SurfaceView,
} from "./mobile-surface-manager";
import {
  deriveSurfacePlacement,
  type NativeSurfaceCreateRequest,
  type NativeSurfacePolicy,
  type NativeSurfaceShell,
} from "./native-surface-shell";

/**
 * A faithful in-memory native shell. Each surface owns a storage partition and a
 * process token: an `isolated` surface gets a fresh, unique one; a `shared`
 * surface is handed the single host partition/process token. That is exactly the
 * `WKWebsiteDataStore` / `WKProcessPool` sharing the native side realises, so a
 * cross-surface read here is the same read a real leak would be.
 */
class FakeNativeShell implements NativeSurfaceShell {
  readonly hostStorage = new Map<string, string>();
  readonly hostProcess = Symbol("host-process");

  readonly commands: string[] = [];
  private readonly storages = new Map<string, Map<string, string>>();
  private readonly processes = new Map<string, symbol>();
  private readonly policies = new Map<string, NativeSurfacePolicy>();
  private readonly live = new Set<string>();
  private currentForeground: string | "host" = "host";

  createSurface(req: NativeSurfaceCreateRequest): void {
    this.commands.push(`create:${req.id}`);
    this.live.add(req.id);
    this.policies.set(req.id, req.policy);
    this.storages.set(
      req.id,
      req.policy.storage === "shared" ? this.hostStorage : new Map(),
    );
    this.processes.set(
      req.id,
      req.policy.process === "shared" ? this.hostProcess : Symbol(req.id),
    );
  }

  foregroundSurface(id: string): void {
    this.commands.push(`foreground:${id}`);
    this.currentForeground = id;
  }

  backgroundSurface(id: string): void {
    this.commands.push(`background:${id}`);
  }

  destroySurface(id: string): void {
    this.commands.push(`destroy:${id}`);
    this.live.delete(id);
    this.storages.delete(id);
    this.processes.delete(id);
    this.policies.delete(id);
  }

  foregroundHost(): void {
    this.commands.push("foreground:host");
    this.currentForeground = "host";
  }

  hasSurface(id: string): boolean {
    return this.live.has(id);
  }

  // ── Test observation helpers ────────────────────────────────────────────
  writeStorage(id: string, key: string, value: string): void {
    const store = this.storages.get(id);
    if (!store) throw new Error(`no surface ${id}`);
    store.set(key, value);
  }

  readStorage(id: string, key: string): string | undefined {
    return this.storages.get(id)?.get(key);
  }

  processToken(id: string): symbol | undefined {
    return this.processes.get(id);
  }

  foreground(): string {
    return this.currentForeground;
  }
}

function view(id: string, surface: SurfaceManifest | undefined): SurfaceView {
  return { id, manifest: surface ? { surface } : undefined };
}

const BROWSER: SurfaceManifest = { isolation: "native-webview" };
const CHAT: SurfaceManifest = { isolation: "in-process" };

describe("deriveSurfacePlacement", () => {
  it("places in-process/immersive/sandboxed views in the host web surface", () => {
    for (const isolation of [
      "in-process",
      "immersive",
      "sandboxed-iframe",
    ] as const) {
      const placement = deriveSurfacePlacement(
        resolveSurfaceManifest({ surface: { isolation } }),
      );
      expect(placement.target).toBe("host-web");
    }
  });

  it("gives a native-webview view its own isolated native surface", () => {
    const placement = deriveSurfacePlacement(
      resolveSurfaceManifest({ surface: BROWSER }),
    );
    expect(placement).toEqual({
      target: "native-surface",
      policy: { process: "isolated", storage: "isolated" },
    });
  });

  it("shares storage only when the manifest grants the `storage` capability", () => {
    const placement = deriveSurfacePlacement(
      resolveSurfaceManifest({
        surface: { isolation: "native-webview", capabilities: ["storage"] },
      }),
    );
    expect(placement).toMatchObject({
      target: "native-surface",
      policy: { process: "isolated", storage: "shared" },
    });
  });
});

describe("MobileSurfaceManager — manifest-driven placement", () => {
  let shell: FakeNativeShell;
  let mgr: MobileSurfaceManager;

  beforeEach(() => {
    shell = new FakeNativeShell();
    mgr = new MobileSurfaceManager(shell);
  });

  it("routes a native-webview view to a created native surface", () => {
    const r = mgr.activate(view("browser", BROWSER));
    expect(r.placement.target).toBe("native-surface");
    expect(r.created).toBe(true);
    expect(shell.hasSurface("browser")).toBe(true);
    expect(shell.foreground()).toBe("browser");
  });

  it("routes an in-process view to the host web surface, no native surface", () => {
    const r = mgr.activate(view("chat", CHAT));
    expect(r.placement.target).toBe("host-web");
    expect(shell.hasSurface("chat")).toBe(false);
    expect(shell.foreground()).toBe("host");
  });

  it("flips placement when the manifest isolation changes (no code change)", () => {
    // Same view id, different declared isolation → opposite placement. This is
    // the assertion that would go red if the manager hard-coded placement
    // instead of reading resolveSurfaceManifest.
    expect(mgr.activate(view("x", CHAT)).placement.target).toBe("host-web");
    expect(mgr.activate(view("x", BROWSER)).placement.target).toBe(
      "native-surface",
    );
  });

  it("sets an explicit process AND storage policy on every native surface", () => {
    mgr.activate(view("browser", BROWSER));
    const policy = mgr.getSurfacePolicy("browser");
    expect(policy).toEqual({ process: "isolated", storage: "isolated" });
    // The explicit policy is what the shell was told to create with.
    expect(shell.commands[0]).toBe("create:browser");
  });
});

describe("MobileSurfaceManager — isolation: state cannot leak across surfaces", () => {
  it("an isolated surface's storage is invisible to the host and to a sibling", () => {
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell);

    mgr.activate(view("browser-a", BROWSER));
    mgr.activate(view("browser-b", BROWSER));

    // Content in surface A writes to its own partition.
    shell.writeStorage("browser-a", "session", "secret-A");

    // It must not be readable from the host web surface…
    expect(shell.hostStorage.get("session")).toBeUndefined();
    // …nor from sibling surface B.
    expect(shell.readStorage("browser-b", "session")).toBeUndefined();
    // …and only A itself sees it.
    expect(shell.readStorage("browser-a", "session")).toBe("secret-A");
  });

  it("isolated surfaces run in distinct processes from each other and the host", () => {
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell);
    mgr.activate(view("browser-a", BROWSER));
    mgr.activate(view("browser-b", BROWSER));

    const a = shell.processToken("browser-a");
    const b = shell.processToken("browser-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a).not.toBe(shell.hostProcess);
    expect(b).not.toBe(shell.hostProcess);
  });

  it("a view that explicitly grants `storage` shares the host partition (non-vacuity control)", () => {
    // This is the contrast that proves the leak test above is a real property
    // of the isolated policy, not a tautology: flip the manifest to grant
    // storage and the write DOES reach the host partition.
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell);
    mgr.activate(
      view("trusted", {
        isolation: "native-webview",
        capabilities: ["storage"],
      }),
    );
    shell.writeStorage("trusted", "session", "shared-value");
    expect(shell.hostStorage.get("session")).toBe("shared-value");
  });
});

describe("MobileSurfaceManager — lifecycle from the manifest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const RETAINED: SurfaceManifest = {
    isolation: "native-webview",
    lifecycle: "retained",
  };
  const EPHEMERAL: SurfaceManifest = {
    isolation: "native-webview",
    lifecycle: "ephemeral",
  };

  it("keeps a `retained` surface warm on navigate-away and restores it without a reload", () => {
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell, { idleGraceMs: 1000 });

    mgr.activate(view("workbench", RETAINED));
    mgr.activate(view("chat", CHAT)); // navigate away
    expect(shell.commands).toContain("background:workbench");
    expect(mgr.getSurfaceStatus("workbench")).toBe("background");

    // Past the grace window — a retained surface is NOT torn down.
    vi.advanceTimersByTime(5000);
    expect(shell.hasSurface("workbench")).toBe(true);
    expect(shell.commands).not.toContain("destroy:workbench");

    // Returning restores warm: no second create, no reload.
    const back = mgr.activate(view("workbench", RETAINED));
    expect(back.restoredWarm).toBe(true);
    expect(back.created).toBe(false);
    expect(shell.commands.filter((c) => c === "create:workbench")).toHaveLength(
      1,
    );
    expect(shell.foreground()).toBe("workbench");
  });

  it("tears down an `ephemeral` surface after the idle grace window", () => {
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell, { idleGraceMs: 1000 });

    mgr.activate(view("preview", EPHEMERAL));
    mgr.activate(view("chat", CHAT)); // navigate away → schedule teardown
    expect(shell.hasSurface("preview")).toBe(true);

    vi.advanceTimersByTime(999);
    expect(shell.hasSurface("preview")).toBe(true); // still within grace

    vi.advanceTimersByTime(1);
    expect(shell.hasSurface("preview")).toBe(false); // grace elapsed → gone
    expect(shell.commands).toContain("destroy:preview");
  });

  it("cancels ephemeral teardown when the view is returned to within the grace window", () => {
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell, { idleGraceMs: 1000 });

    mgr.activate(view("preview", EPHEMERAL));
    mgr.activate(view("chat", CHAT));
    vi.advanceTimersByTime(500);
    const back = mgr.activate(view("preview", EPHEMERAL)); // return within grace
    expect(back.restoredWarm).toBe(true);

    vi.advanceTimersByTime(2000); // original timer would have fired by now
    expect(shell.hasSurface("preview")).toBe(true);
    expect(shell.commands.filter((c) => c === "create:preview")).toHaveLength(
      1,
    );
  });

  it("changing lifecycle retained→ephemeral changes the navigate-away behavior", () => {
    // Manifest-driven: the SAME view id torn down vs kept warm purely by its
    // declared lifecycle. Red if the manager ignored the manifest lifecycle.
    const shell = new FakeNativeShell();
    const mgr = new MobileSurfaceManager(shell, { idleGraceMs: 1000 });

    mgr.activate(view("v", RETAINED));
    mgr.activate(view("chat", CHAT));
    vi.advanceTimersByTime(2000);
    expect(shell.hasSurface("v")).toBe(true); // retained survives

    const shell2 = new FakeNativeShell();
    const mgr2 = new MobileSurfaceManager(shell2, { idleGraceMs: 1000 });
    mgr2.activate(view("v", EPHEMERAL));
    mgr2.activate(view("chat", CHAT));
    vi.advanceTimersByTime(2000);
    expect(shell2.hasSurface("v")).toBe(false); // ephemeral torn down
  });
});

describe("MobileSurfaceManager — memory pressure evicts all backgrounded surfaces", () => {
  it("evicts retained AND ephemeral backgrounded surfaces, keeps the foreground", () => {
    vi.useFakeTimers();
    try {
      const shell = new FakeNativeShell();
      const mgr = new MobileSurfaceManager(shell, { idleGraceMs: 100_000 });

      mgr.activate(
        view("retained-bg", {
          isolation: "native-webview",
          lifecycle: "retained",
        }),
      );
      mgr.activate(
        view("ephemeral-bg", {
          isolation: "native-webview",
          lifecycle: "ephemeral",
        }),
      );
      mgr.activate(view("foreground", BROWSER)); // now foreground

      // Two surfaces are backgrounded, one is foreground.
      expect(mgr.getSurfaceStatus("retained-bg")).toBe("background");
      expect(mgr.getSurfaceStatus("ephemeral-bg")).toBe("background");
      expect(mgr.getSurfaceStatus("foreground")).toBe("foreground");

      mgr.onMemoryPressure();

      // Both backgrounded surfaces are gone regardless of lifecycle; the
      // foreground survives.
      expect(shell.hasSurface("retained-bg")).toBe(false);
      expect(shell.hasSurface("ephemeral-bg")).toBe(false);
      expect(shell.hasSurface("foreground")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

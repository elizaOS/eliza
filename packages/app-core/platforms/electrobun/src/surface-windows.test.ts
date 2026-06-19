import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoundsStore,
  buildAppWindowRendererUrl,
  type CreateManagedWindowOptions,
  type ManagedWindowFrame,
  type ManagedWindowLike,
  SurfaceWindowManager,
} from "./surface-windows";

class FakeManagedWindow implements ManagedWindowLike {
  readonly handlers = new Map<string, Array<() => void>>();
  readonly webview = {
    handlers: new Map<string, Array<() => void>>(),
    loadURL: vi.fn(),
    on: (event: "dom-ready", handler: () => void) => {
      const handlers = this.webview.handlers.get(event) ?? [];
      handlers.push(handler);
      this.webview.handlers.set(event, handlers);
    },
  };
  readonly focus = vi.fn(() => {
    this.emit("focus");
  });
  readonly setAlwaysOnTop = vi.fn((flag: boolean) => {
    this.alwaysOnTop = flag;
  });
  frame: ManagedWindowFrame;
  alwaysOnTop = false;

  constructor(readonly options: CreateManagedWindowOptions) {
    this.frame = options.frame;
  }

  on(event: "close" | "focus" | "resize" | "move", handler: () => void) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  getFrame() {
    return this.frame;
  }

  emit(event: "close" | "focus" | "resize" | "move" | "dom-ready") {
    if (event === "dom-ready") {
      for (const handler of this.webview.handlers.get(event) ?? []) {
        handler();
      }
      return;
    }
    for (const handler of this.handlers.get(event) ?? []) {
      handler();
    }
  }
}

class MemoryBoundsStore implements BoundsStore {
  readonly frames = new Map<string, ManagedWindowFrame>();
  readonly saved: Array<{ slug: string; frame: ManagedWindowFrame }> = [];

  load(slug: string): ManagedWindowFrame | null {
    return this.frames.get(slug) ?? null;
  }

  save(slug: string, frame: ManagedWindowFrame): void {
    this.saved.push({ slug, frame });
    this.frames.set(slug, frame);
  }
}

function createFixture(
  options: {
    boundsStore?: BoundsStore;
    resolveRendererUrl?: () => Promise<string>;
  } = {},
) {
  const created: FakeManagedWindow[] = [];
  const registryChanged = vi.fn();
  const focused = vi.fn();
  const wired = vi.fn();
  const injected = vi.fn();
  const manager = new SurfaceWindowManager({
    createWindow: (windowOptions) => {
      const window = new FakeManagedWindow(windowOptions);
      created.push(window);
      return window;
    },
    resolveRendererUrl:
      options.resolveRendererUrl ??
      (async () => "http://127.0.0.1:5173/?boot=1#old"),
    readPreload: () => "// preload",
    wireRpc: wired,
    injectApiBase: injected,
    onWindowFocused: focused,
    onRegistryChanged: registryChanged,
    boundsStore: options.boundsStore,
  });
  return { created, focused, injected, manager, registryChanged, wired };
}

describe("SurfaceWindowManager app windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds app-window renderer URLs from local routes without preserving stale renderer hashes", () => {
    expect(
      buildAppWindowRendererUrl(
        "http://127.0.0.1:5173/?boot=1#old",
        "/apps/remote-ledger?mode=edit#row-7",
      ),
    ).toBe(
      "http://127.0.0.1:5173/?boot=1&appWindow=1#/apps/remote-ledger?mode=edit#row-7",
    );
  });

  it("opens settings as a singleton, focuses the existing window, and encodes tab hints", async () => {
    const fixture = createFixture();

    const first = await fixture.manager.openSettingsWindow(
      "open-settings-voice",
    );
    const second = await fixture.manager.openSettingsWindow("wallet");

    expect(second).toEqual(first);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.options).toMatchObject({
      title: "elizaOS Settings",
      url: "http://127.0.0.1:5173/?shell=settings&tab=voice",
    });
    expect(fixture.created[0]?.focus).toHaveBeenCalledTimes(1);
    expect(fixture.manager.listWindows("settings")).toEqual([first]);
  });

  it("opens browser surfaces with browse query encoding and ignores browse for non-browser surfaces", async () => {
    const fixture = createFixture();

    const browser = await fixture.manager.openSurfaceWindow(
      "browser",
      "https://example.com/a path?q=one two",
      true,
    );
    const chat = await fixture.manager.openSurfaceWindow(
      "chat",
      "https://ignored.example",
    );

    expect(browser).toMatchObject({
      id: "browser_1",
      surface: "browser",
      alwaysOnTop: true,
    });
    expect(chat).toMatchObject({
      id: "chat_2",
      surface: "chat",
      alwaysOnTop: false,
    });
    expect(fixture.created[0]?.options.url).toBe(
      "http://127.0.0.1:5173/?shell=surface&tab=browser&browse=https%3A%2F%2Fexample.com%2Fa%20path%3Fq%3Done%20two",
    );
    expect(fixture.created[0]?.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(fixture.created[1]?.options.url).toBe(
      "http://127.0.0.1:5173/?shell=surface&tab=chat",
    );
  });

  it("dedupes pending browser opens with the same browse target", async () => {
    let resolveRendererUrl!: (value: string) => void;
    const fixture = createFixture({
      resolveRendererUrl: () =>
        new Promise((resolve) => {
          resolveRendererUrl = resolve;
        }),
    });

    const first = fixture.manager.openSurfaceWindow(
      "browser",
      "https://example.com",
    );
    const second = fixture.manager.openSurfaceWindow(
      "browser",
      "https://example.com",
    );

    expect(fixture.created).toHaveLength(0);
    resolveRendererUrl("http://127.0.0.1:5173/?boot=1#old");
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ id: "browser_1" }),
      expect.objectContaining({ id: "browser_1" }),
    ]);
    expect(fixture.created).toHaveLength(1);
  });

  it("focuses existing detached surfaces and promotes them to always-on-top", async () => {
    const fixture = createFixture();

    const first = await fixture.manager.openSurfaceWindow("plugins");
    const second = await fixture.manager.openSurfaceWindow(
      "plugins",
      undefined,
      true,
    );

    expect(second).toEqual({ ...first, alwaysOnTop: true });
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.focus).toHaveBeenCalledTimes(1);
    expect(fixture.created[0]?.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(fixture.manager.listWindows("plugins")).toEqual([second]);
  });

  it("creates a remote app window, wires RPC, injects API base on dom-ready, and removes it on close", async () => {
    const fixture = createFixture();

    const opened = await fixture.manager.openAppWindow({
      slug: "remote-ledger",
      title: "Remote Ledger",
      path: "/apps/remote-ledger",
      alwaysOnTop: true,
    });

    expect(opened).toEqual({
      id: "app_remote-ledger",
      surface: "app",
      title: "Remote Ledger",
      singleton: false,
      alwaysOnTop: true,
    });
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.options).toMatchObject({
      title: "Remote Ledger",
      preload: "// preload",
      url: "http://127.0.0.1:5173/?boot=1&appWindow=1#/apps/remote-ledger",
    });
    expect(fixture.created[0]?.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(fixture.wired).toHaveBeenCalledWith(fixture.created[0]);
    expect(fixture.focused).toHaveBeenCalledWith(fixture.created[0]);

    fixture.created[0]?.emit("dom-ready");
    expect(fixture.injected).toHaveBeenCalledWith(fixture.created[0]);

    fixture.created[0]?.emit("close");
    expect(fixture.manager.listWindows()).toEqual([]);
    expect(fixture.registryChanged).toHaveBeenCalled();
  });

  it("reopens the same slug by focusing the existing app window and promoting always-on-top", async () => {
    const fixture = createFixture();

    const first = await fixture.manager.openAppWindow({
      slug: "local-notes",
      title: "Local Notes",
      path: "/apps/local-notes",
    });
    const second = await fixture.manager.openAppWindow({
      slug: "local-notes",
      title: "Ignored Duplicate Title",
      path: "/apps/local-notes-v2",
      alwaysOnTop: true,
    });

    expect(second).toEqual({ ...first, alwaysOnTop: true });
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.focus).toHaveBeenCalledTimes(1);
    expect(fixture.created[0]?.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(fixture.manager.listWindows()).toEqual([second]);
  });

  it("focuses, mutates always-on-top, lists, traverses, and loads existing app windows", async () => {
    const fixture = createFixture();

    const notes = await fixture.manager.openAppWindow({
      slug: "local-notes",
      title: "Local Notes",
      path: "/apps/local-notes",
    });
    const ledger = await fixture.manager.openAppWindow({
      slug: "remote-ledger",
      title: "Remote Ledger",
      path: "/apps/remote-ledger",
    });

    expect(fixture.manager.findWindowBySlug("remote-ledger")).toEqual(ledger);
    expect(fixture.manager.focusWindow("app_remote-ledger")).toBe(true);
    expect(fixture.created[1]?.focus).toHaveBeenCalledTimes(1);
    expect(fixture.manager.focusWindow("missing-window")).toBe(false);

    expect(
      fixture.manager.setWindowAlwaysOnTop("app_remote-ledger", true),
    ).toBe(true);
    expect(fixture.created[1]?.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(fixture.manager.setWindowAlwaysOnTop("missing-window", true)).toBe(
      false,
    );
    expect(fixture.manager.listWindows("app")).toEqual([
      notes,
      { ...ledger, alwaysOnTop: true },
    ]);

    const traversed: FakeManagedWindow[] = [];
    fixture.manager.forEachWindow((window) => {
      traversed.push(window as FakeManagedWindow);
      fixture.injected(window);
    });
    expect(traversed).toEqual(fixture.created);
    expect(fixture.injected).toHaveBeenCalledWith(fixture.created[0]);
    expect(fixture.injected).toHaveBeenCalledWith(fixture.created[1]);

    await vi.runOnlyPendingTimersAsync();
    expect(fixture.created[0]?.webview.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/?boot=1&appWindow=1#/apps/local-notes",
    );
    expect(fixture.created[1]?.webview.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/?boot=1&appWindow=1#/apps/remote-ledger",
    );
    expect(fixture.registryChanged).toHaveBeenCalled();
  });

  it("persists per-app bounds after resize and restores them on the next slug launch", async () => {
    const boundsStore = new MemoryBoundsStore();
    const fixture = createFixture({ boundsStore });

    const first = await fixture.manager.openAppWindow({
      slug: "remote-ledger",
      title: "Remote Ledger",
      path: "/apps/remote-ledger",
    });
    expect(first.id).toBe("app_remote-ledger");

    const movedFrame = { x: 40, y: 50, width: 900, height: 700 };
    const firstWindow = fixture.created[0];
    if (!firstWindow) throw new Error("expected created app window");
    firstWindow.frame = movedFrame;
    firstWindow.emit("resize");

    await vi.advanceTimersByTimeAsync(500);
    expect(boundsStore.saved).toEqual([
      { slug: "remote-ledger", frame: movedFrame },
    ]);

    firstWindow.emit("close");
    await fixture.manager.openAppWindow({
      slug: "remote-ledger",
      title: "Remote Ledger",
      path: "/apps/remote-ledger",
    });

    expect(fixture.created[1]?.options.frame).toEqual(movedFrame);
  });
});

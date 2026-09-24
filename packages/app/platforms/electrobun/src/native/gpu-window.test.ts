/**
 * Exercises GpuWindowManager window and WGPUView lifecycle against
 * deterministic Electrobun GPU collaborators. Drives the real manager;
 * GpuWindow and WGPUView are native constructors and are replaced with
 * stateful fakes that record construction and method calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrandConfig } from "../brand-config";
import { GpuWindowManager, getGpuWindowManager } from "./gpu-window";

type Frame = { x: number; y: number; width: number; height: number };

type GpuWindowCreateOptions = {
  title?: string;
  frame?: Frame;
  transparent?: boolean;
  titleBarStyle?: "hidden" | "hiddenInset" | "default";
};

type GpuViewCreateOptions = {
  frame?: Frame;
  windowId: number;
  autoResize?: boolean;
  startTransparent?: boolean;
  startPassthrough?: boolean;
};

const harness = vi.hoisted(() => {
  class FakeEmbeddedWgpuView {
    frame: Frame = { x: 0, y: 0, width: 0, height: 0 };

    setFrame(x: number, y: number, width: number, height: number): void {
      this.frame = { x, y, width, height };
    }
  }

  class FakeGpuWindow {
    readonly handlers = new Map<string, Array<() => void>>();
    readonly options: GpuWindowCreateOptions;
    frame: Frame;
    wgpuViewId: number;
    readonly wgpuView = new FakeEmbeddedWgpuView();
    alwaysOnTop = false;
    shown = false;
    hidden = false;
    minimized = false;
    closed = false;
    closeError: Error | null = null;
    hide: (() => void) | undefined;

    constructor(options: GpuWindowCreateOptions) {
      this.options = options;
      this.frame = options.frame ?? { x: 0, y: 0, width: 0, height: 0 };
      this.wgpuViewId = state.nextWgpuViewId++;
      this.wgpuView.frame = {
        x: 0,
        y: 0,
        width: this.frame.width,
        height: this.frame.height,
      };
      this.hide = () => {
        this.hidden = true;
      };
    }

    on(event: string, handler: () => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler();
      }
    }

    close(): void {
      if (this.closeError) {
        throw this.closeError;
      }
      this.closed = true;
      this.emit("close");
    }

    show(): void {
      this.shown = true;
    }

    minimize(): void {
      this.minimized = true;
    }

    setAlwaysOnTop(flag: boolean): void {
      this.alwaysOnTop = flag;
    }

    setFrame(x: number, y: number, width: number, height: number): void {
      this.frame = { x, y, width, height };
    }
  }

  class FakeWGPUView {
    readonly options: GpuViewCreateOptions;
    frame: Frame;
    id: number;
    transparent: boolean | undefined;
    hidden: boolean | undefined;
    nativeHandle: unknown;
    removed = false;
    removeError: Error | null = null;

    constructor(options: GpuViewCreateOptions) {
      this.options = options;
      this.frame = options.frame ?? { x: 0, y: 0, width: 0, height: 0 };
      this.id = state.nextViewId++;
      this.nativeHandle = { kind: "metal", id: this.id };
    }

    setFrame(x: number, y: number, width: number, height: number): void {
      this.frame = { x, y, width, height };
    }

    setTransparent(transparent: boolean): void {
      this.transparent = transparent;
    }

    setHidden(hidden: boolean): void {
      this.hidden = hidden;
    }

    getNativeHandle(): unknown {
      return this.nativeHandle;
    }

    remove(): void {
      if (this.removeError) {
        throw this.removeError;
      }
      this.removed = true;
    }
  }

  const windows: FakeGpuWindow[] = [];
  const views: FakeWGPUView[] = [];
  const state = {
    nextWgpuViewId: 1,
    nextViewId: 1,
  };

  return {
    windows,
    views,
    state,
    FakeGpuWindow,
    FakeWGPUView,
    createWindow(options: GpuWindowCreateOptions) {
      const win = new FakeGpuWindow(options);
      windows.push(win);
      return win;
    },
    createView(options: GpuViewCreateOptions) {
      const view = new FakeWGPUView(options);
      views.push(view);
      return view;
    },
    reset() {
      windows.length = 0;
      views.length = 0;
      state.nextWgpuViewId = 1;
      state.nextViewId = 1;
    },
  };
});

vi.mock("electrobun/bun", () => ({
  GpuWindow: function GpuWindow(
    this: InstanceType<typeof harness.FakeGpuWindow>,
    options: GpuWindowCreateOptions,
  ) {
    return harness.createWindow(options);
  },
  WGPUView: function WGPUView(
    this: InstanceType<typeof harness.FakeWGPUView>,
    options: GpuViewCreateOptions,
  ) {
    return harness.createView(options);
  },
}));

function lastWindow() {
  const win = harness.windows.at(-1);
  if (!win) {
    throw new Error("expected a GpuWindow to be constructed");
  }
  return win;
}

function lastView() {
  const view = harness.views.at(-1);
  if (!view) {
    throw new Error("expected a WGPUView to be constructed");
  }
  return view;
}

describe("GpuWindowManager windows", () => {
  let manager: GpuWindowManager;

  beforeEach(() => {
    harness.reset();
    manager = new GpuWindowManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.restoreAllMocks();
  });

  it("lists no windows for an empty manager", async () => {
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("creates a window with empty-option defaults and a timestamped id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_123);
    const created = await manager.createWindow({});
    const win = lastWindow();

    expect(created).toEqual({
      id: "gpu_win_1700000000123",
      frame: { x: 100, y: 100, width: 400, height: 600 },
      wgpuViewId: 1,
    });
    expect(win.options).toEqual({
      title: `${getBrandConfig().appName} Companion`,
      frame: { x: 100, y: 100, width: 400, height: 600 },
      transparent: true,
      titleBarStyle: "hidden",
    });
    expect(win.alwaysOnTop).toBe(true);
  });

  it("reuses the same generated id when Date.now does not advance between creates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const first = await manager.createWindow({});
    const second = await manager.createWindow({ title: "ignored" });

    expect(second).toEqual(first);
    expect(harness.windows).toHaveLength(1);
    expect(lastWindow().options.title).toBe(
      `${getBrandConfig().appName} Companion`,
    );
  });

  it("allocates distinct generated ids when Date.now advances", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(10).mockReturnValueOnce(11);
    const first = await manager.createWindow({});
    const second = await manager.createWindow({});

    expect(first.id).toBe("gpu_win_10");
    expect(second.id).toBe("gpu_win_11");
    expect(harness.windows).toHaveLength(2);
  });

  it("creates a window with caller-supplied id, title, bounds, and titleBarStyle", async () => {
    const created = await manager.createWindow({
      id: "companion",
      title: "Trace",
      x: 12,
      y: 34,
      width: 1280,
      height: 720,
      transparent: false,
      titleBarStyle: "hiddenInset",
    });
    const win = lastWindow();

    expect(created).toEqual({
      id: "companion",
      frame: { x: 12, y: 34, width: 1280, height: 720 },
      wgpuViewId: 1,
    });
    expect(win.options).toEqual({
      title: "Trace",
      frame: { x: 12, y: 34, width: 1280, height: 720 },
      transparent: false,
      titleBarStyle: "hiddenInset",
    });
    expect(win.alwaysOnTop).toBe(true);
  });

  it("treats an empty-string id as a real key rather than generating one", async () => {
    const created = await manager.createWindow({ id: "" });
    expect(created.id).toBe("");
    expect(harness.windows).toHaveLength(1);
    await expect(manager.getInfo({ id: "" })).resolves.toEqual({
      id: "",
      frame: { x: 100, y: 100, width: 400, height: 600 },
      wgpuViewId: 1,
    });
  });

  it("returns the existing window without constructing another when the id already exists", async () => {
    const first = await manager.createWindow({
      id: "dup",
      title: "First",
      width: 100,
      height: 200,
    });
    const second = await manager.createWindow({
      id: "dup",
      title: "Second",
      width: 9,
      height: 9,
    });

    expect(second).toEqual(first);
    expect(harness.windows).toHaveLength(1);
    expect(lastWindow().options.title).toBe("First");
  });

  it("does not raise alwaysOnTop when the flag is strictly false", async () => {
    await manager.createWindow({ id: "no-top", alwaysOnTop: false });
    expect(lastWindow().alwaysOnTop).toBe(false);
  });

  it("raises alwaysOnTop for both omitted and strictly true flags", async () => {
    await manager.createWindow({ id: "default-top" });
    expect(harness.windows[0]?.alwaysOnTop).toBe(true);

    await manager.createWindow({ id: "forced-top", alwaysOnTop: true });
    expect(harness.windows[1]?.alwaysOnTop).toBe(true);
  });

  it("lists a single window and preserves insertion order across two windows", async () => {
    const first = await manager.createWindow({ id: "a" });
    const second = await manager.createWindow({ id: "b" });
    const listed = await manager.listWindows();

    expect(listed.windows.map((window) => window.id)).toEqual(["a", "b"]);
    expect(listed.windows[0]).toEqual({
      id: first.id,
      frame: { x: 100, y: 100, width: 400, height: 600 },
      wgpuViewId: 1,
    });
    expect(listed.windows[1]).toEqual({
      id: second.id,
      frame: { x: 100, y: 100, width: 400, height: 600 },
      wgpuViewId: 2,
    });
  });

  it("destroying a missing id is a no-op and leaves other windows in place", async () => {
    const kept = await manager.createWindow({ id: "keep" });
    await manager.destroyWindow({ id: "missing" });
    await expect(manager.listWindows()).resolves.toEqual({
      windows: [
        {
          id: kept.id,
          frame: { x: 100, y: 100, width: 400, height: 600 },
          wgpuViewId: 1,
        },
      ],
    });
    expect(lastWindow().closed).toBe(false);
  });

  it("destroying a known window closes it and removes it from the list without notifying the webview", async () => {
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    const created = await manager.createWindow({ id: "gone" });
    const win = lastWindow();

    await manager.destroyWindow({ id: created.id });

    expect(win.closed).toBe(true);
    expect(sendToWebview).not.toHaveBeenCalled();
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("emits gpuWindowClosed and drops the window when the native close event fires", async () => {
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    const created = await manager.createWindow({ id: "user-close" });
    lastWindow().emit("close");

    expect(sendToWebview).toHaveBeenCalledTimes(1);
    expect(sendToWebview).toHaveBeenCalledWith("gpuWindowClosed", {
      id: created.id,
    });
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("does not throw on a native close when no webview sender is registered", async () => {
    const created = await manager.createWindow({ id: "orphan-close" });
    expect(() => lastWindow().emit("close")).not.toThrow();
    await expect(manager.getInfo({ id: created.id })).resolves.toBeNull();
  });

  it("showWindow and hideWindow are no-ops for a missing id", async () => {
    await expect(
      manager.showWindow({ id: "missing" }),
    ).resolves.toBeUndefined();
    await expect(
      manager.hideWindow({ id: "missing" }),
    ).resolves.toBeUndefined();
    expect(harness.windows).toHaveLength(0);
  });

  it("showWindow focuses a known window", async () => {
    const created = await manager.createWindow({ id: "shown" });
    await manager.showWindow({ id: created.id });
    expect(lastWindow().shown).toBe(true);
  });

  it("hideWindow uses hide when the native window exposes it", async () => {
    const created = await manager.createWindow({ id: "hidable" });
    await manager.hideWindow({ id: created.id });
    expect(lastWindow().hidden).toBe(true);
    expect(lastWindow().minimized).toBe(false);
  });

  it("hideWindow falls back to minimize when hide is not a function", async () => {
    const created = await manager.createWindow({ id: "legacy-hide" });
    const win = lastWindow();
    win.hide = undefined;
    await manager.hideWindow({ id: created.id });
    expect(win.hidden).toBe(false);
    expect(win.minimized).toBe(true);
  });

  it("setBounds is a no-op for a missing id", async () => {
    await expect(
      manager.setBounds({ id: "missing", x: 1, y: 2, width: 3, height: 4 }),
    ).resolves.toBeUndefined();
  });

  it("setBounds repositions the window and keeps the embedded WGPUView origin at 0,0", async () => {
    const created = await manager.createWindow({ id: "moved" });
    const win = lastWindow();
    await manager.setBounds({
      id: created.id,
      x: 8,
      y: 16,
      width: 320,
      height: 240,
    });

    expect(win.frame).toEqual({ x: 8, y: 16, width: 320, height: 240 });
    expect(win.wgpuView.frame).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    });
    await expect(manager.getInfo({ id: created.id })).resolves.toEqual({
      id: created.id,
      frame: { x: 8, y: 16, width: 320, height: 240 },
      wgpuViewId: 1,
    });
  });

  it("getInfo returns null for a missing id", async () => {
    await expect(manager.getInfo({ id: "missing" })).resolves.toBeNull();
  });

  it("relists remaining windows in insertion order after a middle removal", async () => {
    await manager.createWindow({ id: "a" });
    await manager.createWindow({ id: "b" });
    await manager.createWindow({ id: "c" });
    await manager.destroyWindow({ id: "b" });
    const listed = await manager.listWindows();
    expect(listed.windows.map((window) => window.id)).toEqual(["a", "c"]);
  });
});

describe("GpuWindowManager views", () => {
  let manager: GpuWindowManager;

  beforeEach(() => {
    harness.reset();
    manager = new GpuWindowManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.restoreAllMocks();
  });

  it("lists no views for an empty manager", async () => {
    await expect(manager.listViews()).resolves.toEqual({ views: [] });
  });

  it("creates a view with empty-option defaults and a timestamped id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(99);
    const created = await manager.createView({ windowId: 7 });
    const view = lastView();

    expect(created).toEqual({
      id: "gpu_view_99",
      frame: { x: 0, y: 0, width: 400, height: 400 },
      viewId: 1,
    });
    expect(view.options).toEqual({
      frame: { x: 0, y: 0, width: 400, height: 400 },
      windowId: 7,
      autoResize: false,
      startTransparent: false,
      startPassthrough: false,
    });
  });

  it("creates a view with caller-supplied id, frame, and flags", async () => {
    const created = await manager.createView({
      id: "overlay",
      windowId: 3,
      x: 10,
      y: 20,
      width: 64,
      height: 48,
      autoResize: true,
      transparent: true,
      passthrough: true,
    });
    const view = lastView();

    expect(created).toEqual({
      id: "overlay",
      frame: { x: 10, y: 20, width: 64, height: 48 },
      viewId: 1,
    });
    expect(view.options).toEqual({
      frame: { x: 10, y: 20, width: 64, height: 48 },
      windowId: 3,
      autoResize: true,
      startTransparent: true,
      startPassthrough: true,
    });
  });

  it("returns the existing view without constructing another when the id already exists", async () => {
    const first = await manager.createView({ id: "dup", windowId: 1 });
    const second = await manager.createView({
      id: "dup",
      windowId: 99,
      width: 1,
      height: 1,
    });

    expect(second).toEqual(first);
    expect(harness.views).toHaveLength(1);
    expect(lastView().options.windowId).toBe(1);
  });

  it("lists a single view and preserves insertion order across two views", async () => {
    const first = await manager.createView({ id: "v1", windowId: 1 });
    const second = await manager.createView({ id: "v2", windowId: 2 });
    const listed = await manager.listViews();

    expect(listed.views.map((view) => view.id)).toEqual(["v1", "v2"]);
    expect(listed.views[0]).toEqual({
      id: first.id,
      frame: { x: 0, y: 0, width: 400, height: 400 },
      viewId: 1,
    });
    expect(listed.views[1]).toEqual({
      id: second.id,
      frame: { x: 0, y: 0, width: 400, height: 400 },
      viewId: 2,
    });
  });

  it("view mutators are no-ops for a missing id", async () => {
    await expect(
      manager.setViewFrame({
        id: "missing",
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      }),
    ).resolves.toBeUndefined();
    await expect(
      manager.setViewTransparent({ id: "missing", transparent: true }),
    ).resolves.toBeUndefined();
    await expect(
      manager.setViewHidden({ id: "missing", hidden: true }),
    ).resolves.toBeUndefined();
    await expect(
      manager.getViewNativeHandle({ id: "missing" }),
    ).resolves.toBeNull();
    await expect(
      manager.destroyView({ id: "missing" }),
    ).resolves.toBeUndefined();
  });

  it("setViewFrame, setViewTransparent, and setViewHidden update a known view", async () => {
    await manager.createView({ id: "surface", windowId: 1 });
    const view = lastView();

    await manager.setViewFrame({
      id: "surface",
      x: 5,
      y: 6,
      width: 7,
      height: 8,
    });
    await manager.setViewTransparent({ id: "surface", transparent: true });
    await manager.setViewHidden({ id: "surface", hidden: true });

    expect(view.frame).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(view.transparent).toBe(true);
    expect(view.hidden).toBe(true);

    await manager.setViewTransparent({ id: "surface", transparent: false });
    await manager.setViewHidden({ id: "surface", hidden: false });
    expect(view.transparent).toBe(false);
    expect(view.hidden).toBe(false);
  });

  it("getViewNativeHandle returns the native handle wrapper for a known view", async () => {
    await manager.createView({ id: "surface", windowId: 1 });
    await expect(
      manager.getViewNativeHandle({ id: "surface" }),
    ).resolves.toEqual({
      handle: { kind: "metal", id: 1 },
    });
  });

  it("destroying a known view removes it and leaves sibling views in place", async () => {
    await manager.createView({ id: "keep", windowId: 1 });
    await manager.createView({ id: "drop", windowId: 2 });
    const dropped = harness.views[1];
    if (!dropped) {
      throw new Error("expected a second WGPUView");
    }

    await manager.destroyView({ id: "drop" });

    expect(dropped.removed).toBe(true);
    const listed = await manager.listViews();
    expect(listed.views.map((view) => view.id)).toEqual(["keep"]);
    expect(harness.views[0]?.removed).toBe(false);
  });
});

describe("GpuWindowManager dispose", () => {
  beforeEach(() => {
    harness.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes every window without notifying the webview and removes every view", async () => {
    const manager = new GpuWindowManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    await manager.createWindow({ id: "w1" });
    await manager.createWindow({ id: "w2" });
    await manager.createView({ id: "v1", windowId: 1 });
    await manager.createView({ id: "v2", windowId: 2 });

    manager.dispose();

    expect(harness.windows.map((win) => win.closed)).toEqual([true, true]);
    expect(harness.views.map((view) => view.removed)).toEqual([true, true]);
    expect(sendToWebview).not.toHaveBeenCalled();
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
    await expect(manager.listViews()).resolves.toEqual({ views: [] });
  });

  it("still clears windows when a native close throws", async () => {
    const manager = new GpuWindowManager();
    await manager.createWindow({ id: "boom" });
    lastWindow().closeError = new Error("already closed");

    expect(() => manager.dispose()).not.toThrow();
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("still clears views when a native remove throws", async () => {
    const manager = new GpuWindowManager();
    await manager.createView({ id: "boom", windowId: 1 });
    lastView().removeError = new Error("already removed");

    expect(() => manager.dispose()).not.toThrow();
    await expect(manager.listViews()).resolves.toEqual({ views: [] });
  });
});

describe("getGpuWindowManager", () => {
  afterEach(() => {
    getGpuWindowManager().dispose();
    harness.reset();
    vi.restoreAllMocks();
  });

  it("returns one process-wide GpuWindowManager instance", async () => {
    harness.reset();
    const first = getGpuWindowManager();
    const second = getGpuWindowManager();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(GpuWindowManager);

    const created = await first.createWindow({ id: "singleton" });
    const listed = await second.listWindows();
    expect(listed.windows).toEqual([
      expect.objectContaining({ id: created.id }),
    ]);
  });

  it("does not alias a directly constructed manager onto the singleton", async () => {
    harness.reset();
    const constructed = new GpuWindowManager();
    const singleton = getGpuWindowManager();
    expect(constructed).not.toBe(singleton);

    await constructed.createWindow({ id: "constructed" });
    await singleton.createWindow({ id: "singleton" });
    await expect(constructed.listWindows()).resolves.toEqual({
      windows: [expect.objectContaining({ id: "constructed" })],
    });
    await expect(singleton.listWindows()).resolves.toEqual({
      windows: [expect.objectContaining({ id: "singleton" })],
    });
    constructed.dispose();
  });
});

/** Exercises Electrobun canvas window management against a deterministic BrowserWindow collaborator. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasManager, getCanvasManager } from "./canvas";

type WindowFrame = { x: number; y: number; width: number; height: number };

type WindowCreateOptions = {
  title?: string;
  url?: string | null;
  frame?: WindowFrame;
  transparent?: boolean;
  sandbox?: boolean;
  partition?: string;
  renderer?: "native";
};

type EvalParams = { script: string };

const harness = vi.hoisted(() => {
  class FakeBrowserWindow {
    readonly handlers = new Map<string, Array<() => void>>();
    position: { x: number; y: number };
    size: { width: number; height: number };
    alwaysOnTop = false;
    shown = false;
    focused = false;
    closed = false;
    closeError: Error | null = null;
    getPositionError: Error | null = null;
    scripts: string[] = [];
    evalResult: unknown = "ok";
    evalImpl: ((script: string) => Promise<unknown> | unknown) | null = null;
    readonly options: WindowCreateOptions;
    readonly webview: {
      url: string;
      loadURL: (url: string) => void;
      rpc: {
        requestProxy?: {
          evaluateJavascriptWithResponse?: (
            params: EvalParams,
          ) => Promise<unknown>;
        };
      };
    };

    constructor(options: WindowCreateOptions) {
      this.options = options;
      const frame = options.frame ?? { x: 0, y: 0, width: 0, height: 0 };
      this.position = { x: frame.x, y: frame.y };
      this.size = { width: frame.width, height: frame.height };
      const initialUrl = typeof options.url === "string" ? options.url : "";
      this.webview = {
        url: initialUrl,
        loadURL: (url: string) => {
          this.webview.url = url;
        },
        rpc: {
          requestProxy: {
            evaluateJavascriptWithResponse: async (params: EvalParams) => {
              this.scripts.push(params.script);
              if (this.evalImpl) {
                return this.evalImpl(params.script);
              }
              return this.evalResult;
            },
          },
        },
      };
    }

    on(event: string, handler: () => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler();
      }
    }

    close() {
      if (this.closeError) {
        throw this.closeError;
      }
      this.closed = true;
      this.emit("close");
    }

    show() {
      this.shown = true;
    }

    focus() {
      this.focused = true;
    }

    setAlwaysOnTop(flag: boolean) {
      this.alwaysOnTop = flag;
    }

    isAlwaysOnTop() {
      return this.alwaysOnTop;
    }

    getPosition() {
      if (this.getPositionError) {
        throw this.getPositionError;
      }
      return { x: this.position.x, y: this.position.y };
    }

    getSize() {
      return { width: this.size.width, height: this.size.height };
    }

    setPosition(x: number, y: number) {
      this.position = { x, y };
    }

    setSize(width: number, height: number) {
      this.size = { width, height };
    }
  }

  const created: FakeBrowserWindow[] = [];

  return {
    created,
    create(options: WindowCreateOptions) {
      const win = new FakeBrowserWindow(options);
      created.push(win);
      return win;
    },
    reset() {
      created.length = 0;
    },
  };
});

vi.mock("../electrobun-window-options", () => ({
  createElectrobunBrowserWindow: (options: WindowCreateOptions) =>
    harness.create(options),
}));

const originalPlatform = process.platform;
const tmpFiles: string[] = [];

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
}

function lastWindow() {
  const win = harness.created.at(-1);
  if (!win) {
    throw new Error("expected a canvas BrowserWindow to be constructed");
  }
  return win;
}

function mockSnapshotSpawn(bytes: number | "missing" | "throw") {
  const now = 1_700_000_000_123;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const tmpPath = path.join(os.tmpdir(), `eliza-canvas-snapshot-${now}.png`);
  tmpFiles.push(tmpPath);
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation((_cmd) => {
    if (bytes === "throw") {
      throw new Error("spawn failed");
    }
    if (bytes !== "missing") {
      fs.writeFileSync(tmpPath, Buffer.alloc(bytes, 0x41));
    }
    return { exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
  });
  return { spawn, tmpPath };
}

describe("CanvasManager", () => {
  let manager: CanvasManager;

  beforeEach(() => {
    harness.reset();
    manager = new CanvasManager();
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restorePlatform();
    for (const file of tmpFiles.splice(0)) {
      fs.rmSync(file, { force: true });
    }
  });

  it("creates a window with empty-option defaults and a sequential canvas id", async () => {
    const first = await manager.createWindow({});
    const second = await manager.createWindow({});

    expect(first.id).toMatch(/^canvas_\d+$/);
    expect(second.id).toMatch(/^canvas_\d+$/);
    expect(second.id).not.toBe(first.id);

    const win = lastWindow();
    expect(win.options).toMatchObject({
      title: "Canvas",
      url: null,
      transparent: false,
      sandbox: true,
      partition: "canvas-isolated",
      frame: { x: 100, y: 100, width: 800, height: 600 },
    });
    expect(win.options.renderer).toBeUndefined();
    expect(win.alwaysOnTop).toBe(false);
  });

  it("creates a window with caller-supplied bounds, title, url, and alwaysOnTop", async () => {
    const created = await manager.createWindow({
      url: "http://127.0.0.1:3000/view",
      title: "Trace",
      x: 12,
      y: 34,
      width: 1280,
      height: 720,
      transparent: true,
      alwaysOnTop: true,
    });

    const win = lastWindow();
    expect(created.id).toMatch(/^canvas_\d+$/);
    expect(win.options).toMatchObject({
      title: "Trace",
      url: "http://127.0.0.1:3000/view",
      transparent: true,
      sandbox: true,
      partition: "canvas-isolated",
      frame: { x: 12, y: 34, width: 1280, height: 720 },
    });
    expect(win.alwaysOnTop).toBe(true);
  });

  it("does not raise alwaysOnTop unless the flag is strictly true", async () => {
    await manager.createWindow({ alwaysOnTop: false });
    expect(lastWindow().alwaysOnTop).toBe(false);
  });

  it("lists no windows for an empty manager", async () => {
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("lists a single window and preserves insertion order across two windows", async () => {
    const first = await manager.createWindow({ title: "A" });
    const second = await manager.createWindow({
      title: "B",
      url: "http://localhost/",
    });
    const listed = await manager.listWindows();

    expect(listed.windows.map((window) => window.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(listed.windows[0]).toMatchObject({
      id: first.id,
      url: "",
      title: "A",
      alwaysOnTop: false,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
    });
    expect(listed.windows[1]).toMatchObject({
      id: second.id,
      url: "http://localhost/",
      title: "B",
    });
  });

  it("destroying a missing id is a no-op and leaves other windows in place", async () => {
    const kept = await manager.createWindow({ title: "Keep" });
    await manager.destroyWindow({ id: "canvas_missing" });
    await expect(manager.listWindows()).resolves.toMatchObject({
      windows: [{ id: kept.id, title: "Keep" }],
    });
    expect(lastWindow().closed).toBe(false);
  });

  it("destroying a known window closes it and removes it from the list", async () => {
    const created = await manager.createWindow({});
    const win = lastWindow();
    await manager.destroyWindow({ id: created.id });
    expect(win.closed).toBe(true);
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("emits closed to the webview and drops the window when the native close event fires", async () => {
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    const created = await manager.createWindow({});
    lastWindow().emit("close");

    expect(sendToWebview).toHaveBeenCalledWith("canvasWindowEvent", {
      windowId: created.id,
      event: "closed",
    });
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });
  });

  it("emits focus to the webview and is a no-op when no sender is registered", async () => {
    const created = await manager.createWindow({});
    expect(() => lastWindow().emit("focus")).not.toThrow();

    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    lastWindow().emit("focus");
    expect(sendToWebview).toHaveBeenCalledWith("canvasWindowEvent", {
      windowId: created.id,
      event: "focus",
    });
  });

  it("rejects navigation when the window is missing or the URL cannot be parsed", async () => {
    await expect(
      manager.navigate({ id: "missing", url: "http://localhost/" }),
    ).resolves.toEqual({ available: false, reason: "window_not_found" });

    const created = await manager.createWindow({});
    await expect(
      manager.navigate({ id: created.id, url: "not a url" }),
    ).resolves.toEqual({ available: false, reason: "url_not_allowed" });
    await expect(
      manager.navigate({ id: created.id, url: "" }),
    ).resolves.toEqual({ available: false, reason: "url_not_allowed" });
    expect(console.warn).toHaveBeenCalled();
  });

  it("blocks navigation to non-local origins, data URLs, and localhost lookalikes", async () => {
    const created = await manager.createWindow({});
    const blocked = [
      "https://example.com/",
      "http://localhost.evil.com/",
      "http://localhost@evil.com/",
      "http://[::1]/",
      "data:text/html,hello",
      "javascript:alert(1)",
    ];

    for (const url of blocked) {
      await expect(manager.navigate({ id: created.id, url })).resolves.toEqual({
        available: false,
        reason: "url_not_allowed",
      });
    }
    expect(lastWindow().webview.url).toBe("");
  });

  it("allows localhost, loopback, and file navigation and records the loaded URL", async () => {
    const created = await manager.createWindow({});
    const win = lastWindow();

    await expect(
      manager.navigate({ id: created.id, url: "http://localhost:5173/app" }),
    ).resolves.toEqual({ available: true });
    expect(win.webview.url).toBe("http://localhost:5173/app");

    await expect(
      manager.navigate({ id: created.id, url: "https://127.0.0.1/view" }),
    ).resolves.toEqual({ available: true });

    await expect(
      manager.navigate({ id: created.id, url: "file:///tmp/canvas.html" }),
    ).resolves.toEqual({ available: true });
    expect(win.webview.url).toBe("file:///tmp/canvas.html");

    const listed = await manager.listWindows();
    expect(listed.windows[0]?.url).toBe("file:///tmp/canvas.html");
  });

  it("returns null from eval when the window is missing", async () => {
    await expect(
      manager.eval({ id: "missing", script: "1+1" }),
    ).resolves.toBeNull();
  });

  it("allows eval on blank, empty, and local canvas URLs", async () => {
    const blank = await manager.createWindow({});
    lastWindow().evalResult = 2;
    await expect(manager.eval({ id: blank.id, script: "1+1" })).resolves.toBe(
      2,
    );

    lastWindow().webview.url = "about:blank";
    lastWindow().evalResult = "blank";
    await expect(
      manager.eval({ id: blank.id, script: "void 0" }),
    ).resolves.toBe("blank");

    lastWindow().webview.url = "http://localhost/app";
    lastWindow().evalResult = { local: true };
    await expect(
      manager.eval({ id: blank.id, script: "window.location.href" }),
    ).resolves.toEqual({ local: true });
  });

  it("blocks eval on file and external URLs and returns null when evaluation throws", async () => {
    const created = await manager.createWindow({});
    lastWindow().webview.url = "file:///tmp/canvas.html";
    await expect(manager.eval({ id: created.id, script: "1" })).rejects.toThrow(
      `canvas:eval blocked — canvas ${created.id} has external URL: file:///tmp/canvas.html`,
    );

    lastWindow().webview.url = "https://example.com/";
    await expect(manager.eval({ id: created.id, script: "1" })).rejects.toThrow(
      /external URL: https:\/\/example.com\//,
    );

    lastWindow().webview.url = "http://127.0.0.1/";
    lastWindow().evalImpl = () => {
      throw new Error("rpc down");
    };
    await expect(
      manager.eval({ id: created.id, script: "1" }),
    ).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("returns undefined from eval when the webview RPC proxy is absent", async () => {
    const created = await manager.createWindow({});
    lastWindow().webview.rpc = {};
    await expect(
      manager.eval({ id: created.id, script: "1" }),
    ).resolves.toBeUndefined();
  });

  it("returns null from snapshot when the window is missing or parked off-screen", async () => {
    await expect(manager.snapshot({ id: "missing" })).resolves.toBeNull();

    const created = await manager.createWindow({ x: 40, y: 50 });
    const spawn = vi.spyOn(Bun, "spawn");
    await manager.hide({ id: created.id });
    await expect(manager.snapshot({ id: created.id })).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns null from snapshot when capture writes nothing or too little data", async () => {
    const created = await manager.createWindow({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    const missing = mockSnapshotSpawn("missing");
    await expect(manager.snapshot({ id: created.id })).resolves.toBeNull();
    expect(fs.existsSync(missing.tmpPath)).toBe(false);

    vi.restoreAllMocks();
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tiny = mockSnapshotSpawn(50);
    await expect(manager.snapshot({ id: created.id })).resolves.toBeNull();
    expect(fs.existsSync(tiny.tmpPath)).toBe(false);
  });

  it("returns null from snapshot when spawn or position lookup fails", async () => {
    const created = await manager.createWindow({});
    mockSnapshotSpawn("throw");
    await expect(manager.snapshot({ id: created.id })).resolves.toBeNull();

    lastWindow().getPositionError = new Error("native bounds unavailable");
    await expect(manager.snapshot({ id: created.id })).resolves.toBeNull();
  });

  it("captures a darwin region and returns the PNG as base64", async () => {
    setPlatform("darwin");
    const created = await manager.createWindow({
      x: 11,
      y: 22,
      width: 33,
      height: 44,
    });
    const { spawn, tmpPath } = mockSnapshotSpawn(128);

    await expect(manager.snapshot({ id: created.id })).resolves.toEqual({
      data: Buffer.alloc(128, 0x41).toString("base64"),
    });
    expect(spawn).toHaveBeenCalledWith(
      ["screencapture", "-x", "-R", "11,22,33,44", "-t", "png", tmpPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("uses PowerShell on win32 and ImageMagick import elsewhere", async () => {
    const created = await manager.createWindow({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });

    setPlatform("win32");
    const windows = mockSnapshotSpawn(128);
    await expect(manager.snapshot({ id: created.id })).resolves.toEqual({
      data: Buffer.alloc(128, 0x41).toString("base64"),
    });
    const winArgs = windows.spawn.mock.calls[0]?.[0] as string[];
    expect(winArgs[0]).toBe("powershell");
    expect(winArgs[1]).toBe("-NoProfile");
    expect(winArgs[2]).toBe("-Command");
    expect(winArgs[3]).toContain("CopyFromScreen(1, 2, 0, 0");
    expect(winArgs[3]).toContain(windows.tmpPath.replace(/\\/g, "\\\\"));

    vi.restoreAllMocks();
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setPlatform("linux");
    const linux = mockSnapshotSpawn(128);
    await expect(manager.snapshot({ id: created.id })).resolves.toEqual({
      data: Buffer.alloc(128, 0x41).toString("base64"),
    });
    expect(linux.spawn).toHaveBeenCalledWith(
      ["import", "-window", "root", "-crop", "3x4+1+2", linux.tmpPath],
      { stdout: "pipe", stderr: "pipe" },
    );
  });

  it("pushes and resets A2UI through the canvas eval RPC and swallows destroyed-window failures", async () => {
    await manager.a2uiPush({ id: "missing", payload: { n: 1 } });
    await manager.a2uiReset({ id: "missing" });

    const created = await manager.createWindow({});
    const win = lastWindow();
    await manager.a2uiPush({
      id: created.id,
      payload: { type: "card", text: 'say "hi"' },
    });
    expect(win.scripts[0]).toContain(
      `window.elizaDesktopUI.push(${JSON.stringify({ type: "card", text: 'say "hi"' })})`,
    );

    await manager.a2uiReset({ id: created.id });
    expect(win.scripts[1]).toContain("window.elizaDesktopUI.reset()");

    win.evalImpl = () => {
      throw new Error("window destroyed");
    };
    await expect(
      manager.a2uiPush({ id: created.id, payload: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      manager.a2uiReset({ id: created.id }),
    ).resolves.toBeUndefined();
  });

  it("hides by parking the window off-screen and show restores the saved position", async () => {
    const created = await manager.createWindow({ x: 80, y: 90 });
    const win = lastWindow();

    await manager.hide({ id: "missing" });
    await manager.show({ id: "missing" });
    expect(win.position).toEqual({ x: 80, y: 90 });

    await manager.hide({ id: created.id });
    expect(win.position).toEqual({ x: -99999, y: -99999 });
    expect(win.shown).toBe(false);

    await manager.show({ id: created.id });
    expect(win.position).toEqual({ x: 80, y: 90 });
    expect(win.shown).toBe(true);

    await manager.show({ id: created.id });
    expect(win.position).toEqual({ x: 80, y: 90 });
  });

  it("saves the already-hidden coordinates when hide is called twice", async () => {
    const created = await manager.createWindow({ x: 5, y: 6 });
    const win = lastWindow();
    await manager.hide({ id: created.id });
    await manager.hide({ id: created.id });
    await manager.show({ id: created.id });
    expect(win.position).toEqual({ x: -99999, y: -99999 });
  });

  it("resizes, focuses, and round-trips bounds; missing ids are no-ops or zeros", async () => {
    await manager.resize({ id: "missing", width: 1, height: 2 });
    await manager.focus({ id: "missing" });
    await manager.setBounds({
      id: "missing",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    await expect(manager.getBounds({ id: "missing" })).resolves.toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    await expect(
      manager.setAlwaysOnTop({ id: "missing", flag: true }),
    ).resolves.toEqual({ success: false });

    const created = await manager.createWindow({});
    const win = lastWindow();
    await manager.resize({ id: created.id, width: 640, height: 480 });
    expect(win.size).toEqual({ width: 640, height: 480 });

    await manager.focus({ id: created.id });
    expect(win.focused).toBe(true);

    await manager.setBounds({
      id: created.id,
      x: 7,
      y: 8,
      width: 9,
      height: 10,
    });
    await expect(manager.getBounds({ id: created.id })).resolves.toEqual({
      x: 7,
      y: 8,
      width: 9,
      height: 10,
    });

    await expect(
      manager.setAlwaysOnTop({ id: created.id, flag: true }),
    ).resolves.toEqual({ success: true });
    expect(win.alwaysOnTop).toBe(true);
    await expect(
      manager.setAlwaysOnTop({ id: created.id, flag: false }),
    ).resolves.toEqual({ success: true });
    expect(win.alwaysOnTop).toBe(false);
  });

  it("opens http(s) game windows into an isolated partition and rejects other schemes", async () => {
    setPlatform("darwin");
    const httpWin = await manager.openGameWindow({
      url: "http://games.example/play",
      title: "Quest",
      alwaysOnTop: true,
    });
    expect(httpWin.id).toMatch(/^game_\d+$/);
    expect(lastWindow().options).toMatchObject({
      title: "Quest",
      url: "http://games.example/play",
      transparent: false,
      sandbox: true,
      partition: "game-isolated",
      renderer: "native",
      frame: { x: 100, y: 100, width: 1024, height: 768 },
    });
    expect(lastWindow().alwaysOnTop).toBe(true);

    await expect(
      manager.openGameWindow({ url: "https://itch.io/game" }),
    ).resolves.toMatchObject({ id: expect.stringMatching(/^game_\d+$/) });

    await expect(
      manager.openGameWindow({ url: "file:///tmp/game.html" }),
    ).rejects.toThrow(
      "openGameWindow blocked — only http/https URLs are permitted, got: file:",
    );
    await expect(
      manager.openGameWindow({ url: "javascript:alert(1)" }),
    ).rejects.toThrow(/got: javascript:/);
    await expect(
      manager.openGameWindow({ url: "data:text/html,hi" }),
    ).rejects.toThrow(/got: data:/);
    await expect(manager.openGameWindow({ url: "not a url" })).rejects.toThrow(
      "openGameWindow blocked — invalid URL: not a url",
    );
  });

  it("omits the native renderer and warns when opening a game window off macOS", async () => {
    setPlatform("linux");
    const created = await manager.openGameWindow({
      url: "https://games.example/",
    });
    expect(created.id).toMatch(/^game_\d+$/);
    expect(lastWindow().options.renderer).toBeUndefined();
    expect(lastWindow().options.partition).toBe("game-isolated");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Game window using CEF renderer"),
    );
  });

  it("blocks privileged eval on an external game window URL", async () => {
    const game = await manager.openGameWindow({
      url: "https://games.example/play",
    });
    await expect(
      manager.eval({ id: game.id, script: "document.body.innerHTML" }),
    ).rejects.toThrow(/external URL: https:\/\/games.example\/play/);
  });

  it("lists canvas and game windows together and drops both on dispose", async () => {
    const canvas = await manager.createWindow({ title: "Canvas" });
    const game = await manager.openGameWindow({
      url: "https://games.example/",
      title: "Game",
    });
    const listed = await manager.listWindows();
    expect(listed.windows.map((window) => window.id)).toEqual([
      canvas.id,
      game.id,
    ]);

    const first = harness.created[0];
    const second = harness.created[1];
    if (!first || !second) {
      throw new Error("expected two constructed windows");
    }
    second.closeError = new Error("already destroyed");
    expect(() => manager.dispose()).not.toThrow();
    expect(first.closed).toBe(true);
    await expect(manager.listWindows()).resolves.toEqual({ windows: [] });

    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    manager.dispose();
    const after = await manager.createWindow({});
    lastWindow().emit("close");
    expect(sendToWebview).not.toHaveBeenCalled();
    await manager.destroyWindow({ id: after.id });
  });
});

describe("getCanvasManager", () => {
  afterEach(() => {
    getCanvasManager().dispose();
  });

  it("returns one process-wide CanvasManager instance", async () => {
    const first = getCanvasManager();
    const second = getCanvasManager();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(CanvasManager);

    const created = await first.createWindow({ title: "Singleton" });
    const listed = await second.listWindows();
    expect(listed.windows).toEqual([
      expect.objectContaining({ id: created.id, title: "Singleton" }),
    ]);
  });
});

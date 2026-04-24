import { beforeEach, describe, expect, it, vi } from "vitest";

const { MockBrowserWindow, browserWindowInstances } = vi.hoisted(() => {
  type BrowserWindowOptions = {
    title?: string;
    url?: string | null;
    frame?: { x?: number; y?: number; width?: number; height?: number };
  };
  const instances: MockBrowserWindow[] = [];

  class MockBrowserWindow {
    readonly webview: {
      url: string;
      loadURL: (url: string) => void;
      rpc: Record<string, never>;
    };
    readonly handlers = new Map<string, Array<() => void>>();
    readonly options: BrowserWindowOptions;
    private position: { x: number; y: number };
    private size: { width: number; height: number };
    private alwaysOnTop = false;

    constructor(options: BrowserWindowOptions) {
      this.options = options;
      this.position = {
        x: options.frame?.x ?? 0,
        y: options.frame?.y ?? 0,
      };
      this.size = {
        width: options.frame?.width ?? 0,
        height: options.frame?.height ?? 0,
      };
      this.webview = {
        url: options.url ?? "",
        loadURL: (url: string) => {
          this.webview.url = url;
        },
        rpc: {},
      };
      instances.push(this);
    }

    on(event: string, handler: () => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    close(): void {
      for (const handler of this.handlers.get("close") ?? []) handler();
    }

    focus(): void {
      for (const handler of this.handlers.get("focus") ?? []) handler();
    }

    show(): void {}

    getPosition(): { x: number; y: number } {
      return this.position;
    }

    getSize(): { width: number; height: number } {
      return this.size;
    }

    setPosition(x: number, y: number): void {
      this.position = { x, y };
    }

    setSize(width: number, height: number): void {
      this.size = { width, height };
    }

    setAlwaysOnTop(flag: boolean): void {
      this.alwaysOnTop = flag;
    }

    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop;
    }
  }

  return {
    MockBrowserWindow,
    browserWindowInstances: instances,
  };
});

vi.mock("electrobun/bun", () => ({
  BrowserWindow: MockBrowserWindow,
}));

import { CanvasManager } from "./canvas";

describe("CanvasManager app windows", () => {
  beforeEach(() => {
    browserWindowInstances.length = 0;
  });

  it("opens game windows pinned when requested", async () => {
    const manager = new CanvasManager();

    const created = await manager.openGameWindow({
      url: "https://example.com/app",
      title: "Example App",
      alwaysOnTop: true,
    });

    expect(browserWindowInstances).toHaveLength(1);
    expect(browserWindowInstances[0].isAlwaysOnTop()).toBe(true);
    await expect(manager.listWindows()).resolves.toEqual({
      windows: [
        {
          id: created.id,
          url: "https://example.com/app",
          bounds: { x: 100, y: 100, width: 1024, height: 768 },
          title: "Example App",
          alwaysOnTop: true,
        },
      ],
    });
  });

  it("toggles always-on-top for an existing game window", async () => {
    const manager = new CanvasManager();
    const created = await manager.openGameWindow({
      url: "https://example.com/app",
      alwaysOnTop: true,
    });

    await manager.setAlwaysOnTop({ id: created.id, flag: false });

    expect(browserWindowInstances[0].isAlwaysOnTop()).toBe(false);
    await expect(manager.listWindows()).resolves.toMatchObject({
      windows: [{ id: created.id, alwaysOnTop: false }],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildAppWindowRendererUrl,
  buildSurfaceShellQuery,
  buildSurfaceWindowRendererUrl,
  SurfaceWindowManager,
} from "./surface-windows";

describe("surface window routing", () => {
  it("keeps detached surface windows on the renderer root", () => {
    expect(buildSurfaceShellQuery("plugins")).toBe(
      "?shell=surface&tab=plugins",
    );
    expect(
      buildSurfaceWindowRendererUrl("http://127.0.0.1:5174", "plugins"),
    ).toBe("http://127.0.0.1:5174/?shell=surface&tab=plugins");
  });

  it("opens app windows at the renderer root and stores the app route in the hash", () => {
    expect(
      buildAppWindowRendererUrl(
        "http://127.0.0.1:5174",
        "/apps/plugin-viewer?section=installed",
      ),
    ).toBe(
      "http://127.0.0.1:5174/?appWindow=1#/apps/plugin-viewer?section=installed",
    );
  });

  it("explicitly loads detached secondary windows after creating the webview", async () => {
    const loadURL = vi.fn();
    const createdUrls: string[] = [];
    const manager = new SurfaceWindowManager({
      createWindow: (options) => {
        createdUrls.push(options.url);
        return {
          focus: vi.fn(),
          setAlwaysOnTop: vi.fn(),
          on: vi.fn(),
          webview: {
            on: vi.fn(),
            loadURL,
          },
        };
      },
      resolveRendererUrl: async () => "http://127.0.0.1:5174",
      readPreload: () => "",
      wireRpc: vi.fn(),
      injectApiBase: vi.fn(),
    });

    await manager.openSurfaceWindow("plugins");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createdUrls).toEqual([
      "http://127.0.0.1:5174/?shell=surface&tab=plugins",
    ]);
    expect(loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5174/?shell=surface&tab=plugins",
    );
  });

  it("focuses an existing detached surface instead of opening a duplicate", async () => {
    const focus = vi.fn();
    const setAlwaysOnTop = vi.fn();
    const createWindow = vi.fn(() => ({
      focus,
      setAlwaysOnTop,
      on: vi.fn(),
      webview: {
        on: vi.fn(),
        loadURL: vi.fn(),
      },
    }));
    const manager = new SurfaceWindowManager({
      createWindow,
      resolveRendererUrl: async () => "http://127.0.0.1:5174",
      readPreload: () => "",
      wireRpc: vi.fn(),
      injectApiBase: vi.fn(),
    });

    const first = await manager.openSurfaceWindow("plugins");
    const second = await manager.openSurfaceWindow("plugins", undefined, true);

    expect(second.id).toBe(first.id);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(second.alwaysOnTop).toBe(true);
  });

  it("coalesces concurrent opens for the same detached surface", async () => {
    const createWindow = vi.fn(() => ({
      focus: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      on: vi.fn(),
      webview: {
        on: vi.fn(),
        loadURL: vi.fn(),
      },
    }));
    let resolveRendererUrl: (value: string) => void = () => {
      throw new Error("renderer resolver was not initialized");
    };
    const rendererUrl = new Promise<string>((resolve) => {
      resolveRendererUrl = resolve;
    });
    const manager = new SurfaceWindowManager({
      createWindow,
      resolveRendererUrl: () => rendererUrl,
      readPreload: () => "",
      wireRpc: vi.fn(),
      injectApiBase: vi.fn(),
    });

    const first = manager.openSurfaceWindow("plugins");
    const second = manager.openSurfaceWindow("plugins");
    resolveRendererUrl("http://127.0.0.1:5174");

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ id: "plugins_1" }),
      expect.objectContaining({ id: "plugins_1" }),
    ]);
    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});

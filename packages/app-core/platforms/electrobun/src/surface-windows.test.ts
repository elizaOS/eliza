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
});

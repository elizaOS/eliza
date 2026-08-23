import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
}));

vi.mock("electrobun/bun", () => ({
  BrowserWindow: (...args: unknown[]) => mocks.BrowserWindow(...args),
}));

import { createElectrobunBrowserWindow } from "./electrobun-window-options.ts";

describe("createElectrobunBrowserWindow", () => {
  it("constructs a BrowserWindow with the given options", () => {
    const opts = { width: 800, height: 600, icon: "app.png" };
    mocks.BrowserWindow.mockReturnValue({ id: 1 });
    const win = createElectrobunBrowserWindow(opts);
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(opts);
    expect(win).toEqual({ id: 1 });
  });

  it("passes extended fields through", () => {
    const opts = { width: 100, partition: "persist:x", icon: "i.png" };
    mocks.BrowserWindow.mockReturnValue({});
    createElectrobunBrowserWindow(opts);
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(opts);
  });
});

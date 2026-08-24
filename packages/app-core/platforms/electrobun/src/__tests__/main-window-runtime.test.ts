import { describe, expect, it } from "vitest";
import {
  clearCurrentMainWindow,
  evaluateInCurrentMainWindow,
  getCurrentMainWindowSnapshot,
  setCurrentMainWindow,
  updateCurrentMainWindowEffectsState,
} from "./main-window-runtime.ts";

function fakeWindow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    webviewId: 7,
    webview: { url: "https://app.example.com/home", rpc: undefined },
    getPosition: () => ({ x: 10, y: 20 }),
    getSize: () => ({ width: 800, height: 600 }),
    ...overrides,
  } as never;
}

describe("getCurrentMainWindowSnapshot", () => {
  it("reports not present before any window is set", () => {
    const snap = getCurrentMainWindowSnapshot();
    expect(snap.present).toBe(false);
    expect(snap.windowId).toBeNull();
  });

  it("snapshots the active window with meta", () => {
    setCurrentMainWindow(fakeWindow(), {
      titleBarStyle: "hidden",
      transparent: true,
    });
    const snap = getCurrentMainWindowSnapshot();
    expect(snap.present).toBe(true);
    expect(snap.windowId).toBe(42);
    expect(snap.webviewId).toBe(7);
    expect(snap.url).toBe("https://app.example.com/home");
    expect(snap.titleBarStyle).toBe("hidden");
    expect(snap.transparent).toBe(true);
    expect(snap.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    clearCurrentMainWindow();
  });

  it("clears the window", () => {
    setCurrentMainWindow(fakeWindow(), {
      titleBarStyle: "default",
      transparent: false,
    });
    clearCurrentMainWindow();
    expect(getCurrentMainWindowSnapshot().present).toBe(false);
  });

  it("does not clear when clearing a different window id", () => {
    setCurrentMainWindow(fakeWindow(), {
      titleBarStyle: "default",
      transparent: false,
    });
    clearCurrentMainWindow(fakeWindow({ id: 99 }));
    expect(getCurrentMainWindowSnapshot().present).toBe(true);
    clearCurrentMainWindow();
  });
});

describe("updateCurrentMainWindowEffectsState", () => {
  it("updates effects and keeps other meta", () => {
    setCurrentMainWindow(fakeWindow(), {
      titleBarStyle: "hiddenInset",
      transparent: false,
    });
    updateCurrentMainWindowEffectsState({ vibrancyEnabled: true });
    const snap = getCurrentMainWindowSnapshot();
    expect(snap.vibrancyEnabled).toBe(true);
    expect(snap.titleBarStyle).toBe("hiddenInset");
    clearCurrentMainWindow();
  });
});

describe("evaluateInCurrentMainWindow", () => {
  it("throws when no window is present", async () => {
    await expect(evaluateInCurrentMainWindow("1+1")).rejects.toThrow(
      "main window is not available",
    );
  });

  it("throws when the webview lacks an evaluator", async () => {
    setCurrentMainWindow(fakeWindow(), {
      titleBarStyle: "default",
      transparent: false,
    });
    await expect(evaluateInCurrentMainWindow("1+1")).rejects.toThrow(
      "does not support JS evaluation",
    );
    clearCurrentMainWindow();
  });

  it("evaluates via the rpc proxy", async () => {
    const evaluateJavascriptWithResponse = async (arg: { script: string }) =>
      `result:${arg.script}`;
    setCurrentMainWindow(
      fakeWindow({
        webview: {
          url: "https://app.example.com",
          rpc: { requestProxy: { evaluateJavascriptWithResponse } },
        },
      }),
      { titleBarStyle: "default", transparent: false },
    );
    await expect(evaluateInCurrentMainWindow("1+1")).resolves.toBe(
      "result:1+1",
    );
    clearCurrentMainWindow();
  });
});

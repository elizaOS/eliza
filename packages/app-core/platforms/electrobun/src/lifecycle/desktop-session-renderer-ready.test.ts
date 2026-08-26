/** Verifies the deterministic renderer recovery boundary after desktop session priming. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerState = {
  info: vi.fn(() => {}),
  warn: vi.fn(() => {}),
};

vi.mock("../logger", () => ({
  logger: loggerState,
}));

const { reloadRendererAfterDesktopSessionPrime } = await import(
  "./desktop-session-renderer-ready"
);

function createWindow() {
  return {
    webview: {
      loadURL: vi.fn((_url: string) => {}),
    },
  };
}

describe("desktop session renderer readiness", () => {
  beforeEach(() => {
    loggerState.info.mockClear();
    loggerState.warn.mockClear();
  });

  it("reloads the existing renderer exactly once after a successful prime", async () => {
    const window = createWindow();
    const resolveRendererUrl = vi.fn(
      async () => "http://127.0.0.1:5174/chat?shellMode=chat-overlay",
    );

    await expect(
      reloadRendererAfterDesktopSessionPrime({
        sessionPrimed: true,
        backendGeneration: "31337:1",
        window,
        resolveRendererUrl,
      }),
    ).resolves.toBe(true);

    expect(resolveRendererUrl).toHaveBeenCalledTimes(1);
    expect(window.webview.loadURL).toHaveBeenCalledTimes(1);
    expect(window.webview.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:5174/chat?shellMode=chat-overlay",
    );
  });

  it("does not reload when the session prime failed or no window exists", async () => {
    const window = createWindow();
    const resolveRendererUrl = vi.fn(async () => "http://127.0.0.1:5174/chat");

    await expect(
      reloadRendererAfterDesktopSessionPrime({
        sessionPrimed: false,
        backendGeneration: "31337:1",
        window,
        resolveRendererUrl,
      }),
    ).resolves.toBe(false);
    await expect(
      reloadRendererAfterDesktopSessionPrime({
        sessionPrimed: true,
        backendGeneration: "31337:1",
        window: null,
        resolveRendererUrl,
      }),
    ).resolves.toBe(false);

    expect(resolveRendererUrl).not.toHaveBeenCalled();
    expect(window.webview.loadURL).not.toHaveBeenCalled();
  });

  it("keeps reload failure at the visible renderer boundary", async () => {
    const window = createWindow();
    window.webview.loadURL.mockImplementationOnce(() => {
      throw new Error("webview gone");
    });

    await expect(
      reloadRendererAfterDesktopSessionPrime({
        sessionPrimed: true,
        backendGeneration: "31337:1",
        window,
        resolveRendererUrl: async () => "http://127.0.0.1:5174/chat",
      }),
    ).resolves.toBe(false);

    expect(loggerState.warn).toHaveBeenCalledWith(
      "[Main] Desktop renderer reload after session prime failed: webview gone",
    );
  });

  it("coalesces concurrent callers for one backend generation", async () => {
    const window = createWindow();
    let releaseUrl: (() => void) | undefined;
    const resolveRendererUrl = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseUrl = () => resolve("http://127.0.0.1:5174/chat");
        }),
    );

    const first = reloadRendererAfterDesktopSessionPrime({
      sessionPrimed: true,
      backendGeneration: "31337:2",
      window,
      resolveRendererUrl,
    });
    const duplicate = reloadRendererAfterDesktopSessionPrime({
      sessionPrimed: true,
      backendGeneration: "31337:2",
      window,
      resolveRendererUrl,
    });
    releaseUrl?.();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      true,
      false,
    ]);
    expect(resolveRendererUrl).toHaveBeenCalledTimes(1);
    expect(window.webview.loadURL).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending reload after a newer backend generation wins", async () => {
    const window = createWindow();
    const rendererUrl = "http://127.0.0.1:5174/chat";
    let resolveOlderUrl!: (url: string) => void;
    const olderUrl = new Promise<string>((resolve) => {
      resolveOlderUrl = resolve;
    });

    const olderReload = reloadRendererAfterDesktopSessionPrime({
      sessionPrimed: true,
      backendGeneration: "31337:old",
      window,
      resolveRendererUrl: () => olderUrl,
    });
    const newerReload = reloadRendererAfterDesktopSessionPrime({
      sessionPrimed: true,
      backendGeneration: "31337:new",
      window,
      resolveRendererUrl: async () => rendererUrl,
    });

    await expect(newerReload).resolves.toBe(true);
    expect(window.webview.loadURL).toHaveBeenCalledTimes(1);
    expect(window.webview.loadURL).toHaveBeenLastCalledWith(rendererUrl);

    resolveOlderUrl(rendererUrl);
    await expect(olderReload).resolves.toBe(false);

    expect(window.webview.loadURL).toHaveBeenCalledTimes(1);
    expect(window.webview.loadURL).toHaveBeenLastCalledWith(rendererUrl);
    expect(loggerState.info).toHaveBeenCalledTimes(1);
    expect(loggerState.warn).not.toHaveBeenCalled();
  });

  it("reloads the same window once for each backend generation", async () => {
    const window = createWindow();
    const resolveRendererUrl = vi.fn(async () => "http://127.0.0.1:5174/chat");

    for (const backendGeneration of ["31337:3", "31337:4"]) {
      await expect(
        reloadRendererAfterDesktopSessionPrime({
          sessionPrimed: true,
          backendGeneration,
          window,
          resolveRendererUrl,
        }),
      ).resolves.toBe(true);
    }

    expect(window.webview.loadURL).toHaveBeenCalledTimes(2);
  });
});

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
        window,
        resolveRendererUrl,
      }),
    ).resolves.toBe(false);
    await expect(
      reloadRendererAfterDesktopSessionPrime({
        sessionPrimed: true,
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
        window,
        resolveRendererUrl: async () => "http://127.0.0.1:5174/chat",
      }),
    ).resolves.toBe(false);

    expect(loggerState.warn).toHaveBeenCalledWith(
      "[Main] Desktop renderer reload after session prime failed: webview gone",
    );
  });
});

/**
 * Verifies the iOS chat accessory controller's visibility mapping and ordered
 * WebView-global writes with a deterministic fake native bridge.
 */

import { describe, expect, it, vi } from "vitest";

import { createChatAccessoryBarController } from "./ios-chat-accessory-bar";

describe("iOS chat accessory controller", () => {
  it("serializes chat hide then non-chat restore in request order", async () => {
    let releaseHide: (() => void) | undefined;
    const setAccessoryBarVisible = vi.fn(
      ({ isVisible }: { isVisible: boolean }) => {
        if (isVisible) return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseHide = resolve;
        });
      },
    );
    const reportError = vi.fn();
    const controller = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => ({ setAccessoryBarVisible }),
      reportError,
    });

    void controller.setChatComposerHidden(true);
    void controller.setChatComposerHidden(false);
    await vi.waitFor(() =>
      expect(setAccessoryBarVisible).toHaveBeenCalledOnce(),
    );
    expect(setAccessoryBarVisible).toHaveBeenLastCalledWith({
      isVisible: false,
    });

    releaseHide?.();
    await vi.waitFor(() =>
      expect(setAccessoryBarVisible).toHaveBeenLastCalledWith({
        isVisible: true,
      }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps a focused composer hidden when delayed boot settles, then restores on blur", async () => {
    let releaseFocus: (() => void) | undefined;
    const setAccessoryBarVisible = vi.fn(
      ({ isVisible }: { isVisible: boolean }) => {
        if (!isVisible && setAccessoryBarVisible.mock.calls.length === 1) {
          return new Promise<void>((resolve) => {
            releaseFocus = resolve;
          });
        }
        return Promise.resolve();
      },
    );
    const reportError = vi.fn();
    const controller = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => ({ setAccessoryBarVisible }),
      reportError,
    });

    const focus = controller.setChatComposerHidden(true);
    await vi.waitFor(() =>
      expect(setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false }),
    );
    const boot = controller.initializeBaseline();

    releaseFocus?.();
    await Promise.all([boot, focus]);
    expect(setAccessoryBarVisible).toHaveBeenLastCalledWith({
      isVisible: false,
    });

    await controller.setChatComposerHidden(false);
    expect(setAccessoryBarVisible).toHaveBeenLastCalledWith({
      isVisible: true,
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});

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
    const setHidden = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => ({ setAccessoryBarVisible }),
      reportError,
    });

    setHidden(true);
    setHidden(false);
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
});

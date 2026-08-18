/**
 * Verifies the iOS chat accessory controller's visibility mapping and ordered
 * WebView-global writes with a deterministic fake native bridge.
 */

import { describe, expect, it, vi } from "vitest";

import { createChatAccessoryBarController } from "./ios-chat-accessory-bar";

describe("iOS chat accessory controller", () => {
  it("drops a stale hide when focus leaves before the bridge loads", async () => {
    let releaseBridge: (() => void) | undefined;
    const bridgeReady = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    const setAccessoryBarVisible = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const controller = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => {
        await bridgeReady;
        return { setAccessoryBarVisible };
      },
      reportError,
    });

    void controller.setChatComposerHidden(true);
    void controller.setChatComposerHidden(false);
    releaseBridge?.();
    await vi.waitFor(() =>
      expect(setAccessoryBarVisible).toHaveBeenCalledOnce(),
    );
    expect(setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: true });
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

  it("deduplicates repeated focus state without losing the boot baseline", async () => {
    const setAccessoryBarVisible = vi.fn(async () => undefined);
    const controller = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => ({ setAccessoryBarVisible }),
      reportError: vi.fn(),
    });

    await controller.initializeBaseline();
    await controller.initializeBaseline();
    await controller.setChatComposerHidden(true);
    await controller.setChatComposerHidden(true);

    expect(setAccessoryBarVisible.mock.calls).toEqual([
      [{ isVisible: true }],
      [{ isVisible: false }],
    ]);
  });

  it("retries the latest state after a bridge failure", async () => {
    const setAccessoryBarVisible = vi
      .fn<({ isVisible }: { isVisible: boolean }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValue(undefined);
    const reportError = vi.fn();
    const controller = createChatAccessoryBarController({
      enabled: true,
      loadKeyboard: async () => ({ setAccessoryBarVisible }),
      reportError,
    });

    await controller.setChatComposerHidden(true);
    await controller.setChatComposerHidden(true);

    expect(reportError).toHaveBeenCalledOnce();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(2);
    expect(setAccessoryBarVisible).toHaveBeenLastCalledWith({
      isVisible: false,
    });
  });

  it("does not load or mutate the native bridge off supported iPhone builds", async () => {
    const loadKeyboard = vi.fn();
    const controller = createChatAccessoryBarController({
      enabled: false,
      loadKeyboard,
      reportError: vi.fn(),
    });

    await controller.initializeBaseline();
    await controller.setChatComposerHidden(true);
    await controller.setChatComposerHidden(false);

    expect(loadKeyboard).not.toHaveBeenCalled();
  });
});

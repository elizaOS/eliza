// @vitest-environment jsdom

import {
  alertDesktopMessage,
  confirmDesktopAction,
  copyTextToClipboard,
} from "@elizaos/app-core/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
    onMessage: (
      messageName: string,
      listener: (payload: unknown) => void,
    ) => void;
    offMessage: (
      messageName: string,
      listener: (payload: unknown) => void,
    ) => void;
  };
};

describe("desktop dialog and clipboard helpers", () => {
  beforeEach(() => {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
        configurable: true,
      });
      return;
    }

    if (!navigator.clipboard.writeText) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: vi.fn().mockResolvedValue(undefined),
        configurable: true,
      });
    }
  });

  afterEach(() => {
    delete (window as TestWindow).__ELIZA_ELECTROBUN_RPC__;
    vi.restoreAllMocks();
  });

  it("uses the Electrobun message-box RPC for confirm dialogs", async () => {
    const request = vi.fn().mockResolvedValue({ response: 0 });
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopShowMessageBox: request },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    const confirmSpy = vi.spyOn(window, "confirm");

    await expect(
      confirmDesktopAction({
        title: "Delete Item",
        message: "Delete this item?",
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      type: "question",
      title: "Delete Item",
      message: "Delete this item?",
      detail: undefined,
      buttons: ["Confirm", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("falls back to window.confirm on web", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await expect(
      confirmDesktopAction({
        title: "Disconnect",
        message: "Disconnect now?",
      }),
    ).resolves.toBe(true);

    expect(confirmSpy).toHaveBeenCalledWith("Disconnect\n\nDisconnect now?");
  });

  it("uses the Electrobun message-box RPC for alerts", async () => {
    const request = vi.fn().mockResolvedValue({ response: 0 });
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopShowMessageBox: request },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    const alertSpy = vi.spyOn(window, "alert");

    await expect(
      alertDesktopMessage({
        title: "Reset Failed",
        message: "Check the logs.",
        type: "error",
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith({
      type: "error",
      title: "Reset Failed",
      message: "Check the logs.",
      detail: undefined,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("uses the Electrobun clipboard RPC when available", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopWriteToClipboard: request },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    const clipboardSpy = vi.spyOn(navigator.clipboard, "writeText");

    await copyTextToClipboard("eliza");

    expect(request).toHaveBeenCalledWith({
      text: "eliza",
    });
    expect(clipboardSpy).not.toHaveBeenCalled();
  });

  it("falls back to navigator.clipboard on web", async () => {
    const clipboardSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    await copyTextToClipboard("desktopless");

    expect(clipboardSpy).toHaveBeenCalledWith("desktopless");
  });
});

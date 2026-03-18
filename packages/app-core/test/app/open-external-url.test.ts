// @vitest-environment jsdom

import { openExternalUrl } from "@elizaos/app-core/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("openExternalUrl", () => {
  afterEach(() => {
    delete (window as TestWindow).__ELIZA_ELECTROBUN_RPC__;
    vi.restoreAllMocks();
  });

  it("uses the Electrobun desktop bridge when available", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenExternal: request },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };
    const openSpy = vi.spyOn(window, "open");

    await openExternalUrl("https://claude.ai");

    expect(request).toHaveBeenCalledWith({
      url: "https://claude.ai",
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("falls back to window.open on web", async () => {
    const popup = {} as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);

    await expect(openExternalUrl("https://platform.openai.com")).resolves.toBe(
      undefined,
    );

    expect(openSpy).toHaveBeenCalledWith(
      "https://platform.openai.com",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("throws when the browser blocks the fallback popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("https://claude.ai")).rejects.toThrow(
      "Popup blocked. Allow popups and try again.",
    );
  });
});

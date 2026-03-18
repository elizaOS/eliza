// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { toggleAlwaysOnTop } from "../../src/components/stream/helpers";

type TestWindow = Window & {
  __MILADY_ELECTROBUN_RPC__?: {
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

describe("toggleAlwaysOnTop", () => {
  afterEach(() => {
    delete (window as typeof window & { Capacitor?: unknown }).Capacitor;
    delete (window as TestWindow).__MILADY_ELECTROBUN_RPC__;
    vi.restoreAllMocks();
  });

  it("uses the direct Electrobun RPC bridge", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    (window as TestWindow).__MILADY_ELECTROBUN_RPC__ = {
      request: { desktopSetAlwaysOnTop: request },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };

    await expect(toggleAlwaysOnTop(true)).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      flag: true,
    });
  });
});

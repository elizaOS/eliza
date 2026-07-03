import { afterEach, describe, expect, it, vi } from "vitest";

import { WebsiteBlockerWeb } from "./web";

function setWindow(overrides: Partial<Window> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "https:" },
      sessionStorage: {
        getItem: vi.fn(() => "stored-token"),
      },
      ...overrides,
    },
  });
}

describe("WebsiteBlockerWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes valid website inputs before sending them to the runtime API", async () => {
    setWindow({
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "https://agent.example" },
    } as Partial<Window>);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        endsAt: null,
        request: { websites: ["example.com"], durationMinutes: 30 },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new WebsiteBlockerWeb().startBlock({
      websites: ["HTTPS://Example.COM/path", "*.news.example.org."],
      text: "example.com javascript:alert(1)",
      durationMinutes: "30.8",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/website-blocker",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          websites: ["example.com", "news.example.org"],
          durationMinutes: 30,
        }),
      }),
    );
  });

  it.each([
    {},
    { websites: [] },
    { websites: ["javascript:alert(1)"] },
    { websites: ["localhost"] },
    { websites: ["../etc/passwd"] },
    { websites: [{ host: "example.com" } as unknown as string] },
  ])("rejects malformed website inputs %# before fetch", async (options) => {
    setWindow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new WebsiteBlockerWeb().startBlock(options)).rejects.toThrow(
      "Provide at least one public website hostname.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    0,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    "nope",
  ])("rejects malformed duration %s before fetch", async (durationMinutes) => {
    setWindow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new WebsiteBlockerWeb().startBlock({
        websites: ["example.com"],
        durationMinutes,
      }),
    ).rejects.toThrow("durationMinutes must be a positive finite number");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an unavailable open-settings result when the runtime API is unreachable", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "file:" },
        sessionStorage: { getItem: vi.fn() },
      },
    });

    await expect(new WebsiteBlockerWeb().openSettings()).resolves.toEqual({
      opened: false,
      target: "runtime",
      actualTarget: "runtime",
      reason: "Eliza API not available.",
    });
  });
});

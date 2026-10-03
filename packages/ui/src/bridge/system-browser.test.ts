/** A failed Chromium handoff must not replay navigation in a different browser. */
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  external: vi.fn(),
  desktop: true,
}));
vi.mock("./electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: boundary.request,
}));
vi.mock("./electrobun-runtime", () => ({
  isElectrobunRuntime: () => boundary.desktop,
}));
vi.mock("../utils", () => ({ openExternalUrl: boundary.external }));

import { openBrowserWebsite } from "./system-browser";

beforeEach(() => {
  vi.clearAllMocks();
  boundary.desktop = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
});
afterEach(() => vi.restoreAllMocks());
it.each([null, { engine: "webview", surface: "window" }])(
  "rejects missing or wrong native receipts without another dispatch",
  async (receipt) => {
    boundary.request.mockResolvedValue(receipt);
    await expect(openBrowserWebsite("https://example.com/")).rejects.toThrow(
      "Chromium could not be opened",
    );
    expect(boundary.external).not.toHaveBeenCalled();
  },
);
it("preserves an uncertain native dispatch failure without replay", async () => {
  boundary.request.mockRejectedValue(
    new Error("connection lost after dispatch"),
  );
  await expect(openBrowserWebsite("https://example.com/")).rejects.toThrow(
    "connection lost after dispatch",
  );
  expect(boundary.external).not.toHaveBeenCalled();
});
it("keeps ordinary browser handoff available outside the desktop runtime", async () => {
  boundary.desktop = false;
  await openBrowserWebsite("https://example.com/");
  expect(boundary.external).toHaveBeenCalledWith("https://example.com/");
  expect(boundary.request).not.toHaveBeenCalled();
});

it.each([
  [true, "Linux x86_64", true],
  [false, "Linux x86_64", false],
  [true, "MacIntel", false],
  [true, "Win32", false],
])(
  "shares the precise platform guard for entry and handoff (%s, %s)",
  async (desktop, platform, expected) => {
    boundary.desktop = desktop;
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const { usesOwnedChromiumBrowser } = await import("./system-browser");
    expect(usesOwnedChromiumBrowser()).toBe(expected);
  },
);

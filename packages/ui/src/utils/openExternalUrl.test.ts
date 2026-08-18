/**
 * Unit coverage for the central navigation enforcement in `openExternalUrl` /
 * `navigatePreOpenedWindow`: wire-supplied URLs that fail the
 * `isSafeNavigationUrl` scheme allowlist must never reach `window.open`, the
 * desktop bridge, or a same-origin pre-opened popup — the helpers return
 * `false` so callers surface their visible error state. The Capacitor and
 * Electrobun bridges are mocked to the plain-web environment; jsdom.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigatePreOpenedWindow, openExternalUrl } from "./openExternalUrl";

const invokeDesktopBridgeRequestWithTimeout = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<null>>(async () => null),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: vi.fn(),
}));

vi.mock("../bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: () => undefined,
  invokeDesktopBridgeRequestWithTimeout,
}));

type FakePopup = {
  closed: boolean;
  opener: unknown;
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
};

const makePopup = (): FakePopup => ({
  closed: false,
  opener: {},
  location: { href: "about:blank" },
  close: vi.fn(function (this: FakePopup) {
    this.closed = true;
  }),
});

describe("openExternalUrl navigation guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invokeDesktopBridgeRequestWithTimeout.mockClear();
  });

  it("opens an http(s) URL in a new tab with the opener severed", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);
    await expect(
      openExternalUrl("https://checkout.stripe.com/c/pay_123"),
    ).resolves.toBe(true);
    expect(openSpy).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay_123",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("fails closed on script-capable and custom-scheme wire URLs", async () => {
    const openSpy = vi.spyOn(window, "open");
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "customapp://do-thing",
      "//attacker.example/x",
      "not a url",
      "",
    ]) {
      await expect(openExternalUrl(url)).resolves.toBe(false);
    }
    // A rejected target never reaches any open channel.
    expect(openSpy).not.toHaveBeenCalled();
    expect(invokeDesktopBridgeRequestWithTimeout).not.toHaveBeenCalled();
  });

  it("permits only an explicitly opted-in OS deep-link scheme", async () => {
    const settingsUrl =
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);

    await expect(openExternalUrl(settingsUrl)).resolves.toBe(false);
    await expect(
      openExternalUrl(settingsUrl, {
        extraSchemes: ["x-apple.systempreferences:"],
      }),
    ).resolves.toBe(true);
    expect(openSpy).toHaveBeenCalledOnce();
    expect(openSpy).toHaveBeenCalledWith(
      settingsUrl,
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("navigatePreOpenedWindow navigation guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invokeDesktopBridgeRequestWithTimeout.mockClear();
  });

  it("navigates an open popup to an http(s) URL and severs the opener", () => {
    const popup = makePopup();
    const result = navigatePreOpenedWindow(
      popup as unknown as Window,
      "https://auth.example/oauth",
    );
    expect(result).toBe(true);
    expect(popup.location.href).toBe("https://auth.example/oauth");
    expect(popup.opener).toBeNull();
  });

  it("keeps the opener when preserveOpener is set", () => {
    const popup = makePopup();
    const opener = popup.opener;
    navigatePreOpenedWindow(popup as unknown as Window, "https://x.example", {
      preserveOpener: true,
    });
    expect(popup.opener).toBe(opener);
  });

  it("closes the popup and refuses a javascript: target", () => {
    const popup = makePopup();
    const result = navigatePreOpenedWindow(
      popup as unknown as Window,
      "javascript:alert(document.cookie)",
    );
    expect(result).toBe(false);
    expect(popup.close).toHaveBeenCalled();
    // The popup stays on about:blank — the script URL is never assigned to
    // the same-origin popup's location.
    expect(popup.location.href).toBe("about:blank");
  });

  it("refuses a rejected target even without a popup (no fallback open)", () => {
    const openSpy = vi.spyOn(window, "open");
    expect(navigatePreOpenedWindow(null, "javascript:alert(1)")).toBe(false);
    expect(navigatePreOpenedWindow(null, "data:text/html,x")).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(invokeDesktopBridgeRequestWithTimeout).not.toHaveBeenCalled();
  });

  it("falls back to openExternalUrl when the popup was blocked", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);
    expect(navigatePreOpenedWindow(null, "https://auth.example/oauth")).toBe(
      true,
    );
    // The fallback awaits the (absent) desktop bridge before window.open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openSpy).toHaveBeenCalledWith(
      "https://auth.example/oauth",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("treats an already-closed popup as blocked and falls back", async () => {
    const popup = makePopup();
    popup.closed = true;
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);
    expect(
      navigatePreOpenedWindow(
        popup as unknown as Window,
        "https://auth.example/oauth",
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openSpy).toHaveBeenCalled();
  });
});

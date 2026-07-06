// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const isElectrobunRuntime = vi.hoisted(() => vi.fn(() => false));
vi.mock("../bridge/electrobun-runtime", () => ({ isElectrobunRuntime }));

import {
  getActiveViewModality,
  getFrontendPlatform,
  isMobileWebBrowser,
} from "./platform-guards";

const w = window as unknown as Record<string, unknown>;

describe("getActiveViewModality", () => {
  afterEach(() => {
    delete w.__elizaXRContext;
  });

  it("returns gui by default on a non-XR surface", () => {
    delete w.__elizaXRContext;
    expect(getActiveViewModality()).toBe("gui");
  });

  it("returns xr when the WebXR view host context is present", () => {
    w.__elizaXRContext = { viewId: "wallet" };
    expect(getActiveViewModality()).toBe("xr");
  });
});

describe("getFrontendPlatform", () => {
  afterEach(() => {
    isElectrobunRuntime.mockReturnValue(false);
  });

  it("reports desktop when the Electrobun runtime is detected (not the dead __ELECTROBUN__ flag)", () => {
    // Regression: the old check read window.__ELECTROBUN__, which the shell
    // sets nowhere, so desktop was mis-reported as "web". It must use the
    // real isElectrobunRuntime() signal instead.
    isElectrobunRuntime.mockReturnValue(true);
    expect(getFrontendPlatform()).toBe("desktop");
  });

  it("does not report desktop when not in the Electrobun runtime", () => {
    isElectrobunRuntime.mockReturnValue(false);
    // jsdom + no Capacitor native platform → web.
    expect(getFrontendPlatform()).toBe("web");
  });
});

describe("isMobileWebBrowser", () => {
  const setMatchMedia = (coarse: boolean) => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(pointer: coarse)" ? coarse : false,
      }),
    });
  };
  const setUserAgent = (ua: string) => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: ua,
    });
  };

  afterEach(() => {
    isElectrobunRuntime.mockReturnValue(false);
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("is true for a coarse primary pointer on the web platform (phones, and iPadOS Safari's macOS-masquerading UA)", () => {
    setMatchMedia(true);
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    );
    expect(isMobileWebBrowser()).toBe(true);
  });

  it("is false for a fine pointer + desktop UA", () => {
    setMatchMedia(false);
    setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    );
    expect(isMobileWebBrowser()).toBe(false);
  });

  it("falls back to the UA when matchMedia misreports: a mobile UA alone is enough", () => {
    setMatchMedia(false);
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    );
    expect(isMobileWebBrowser()).toBe(true);
  });

  it("is false inside the Electrobun desktop shell even with a coarse pointer (touch-screen laptops)", () => {
    isElectrobunRuntime.mockReturnValue(true);
    setMatchMedia(true);
    expect(isMobileWebBrowser()).toBe(false);
  });
});

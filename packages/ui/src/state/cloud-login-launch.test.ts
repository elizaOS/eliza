// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.elizacloud.ai/" }
//
// Popup-vs-same-tab decision logic for the cloud sign-in (#15143). Exercises
// the browser-agnostic runtime popup-blocked signal (null/closed handle), the
// touch-primary capability hint, the platform exclusions (Capacitor native /
// Electrobun desktop), the hosted-host gate, the returnTo path builder, and
// the sign-in card URL resolution (never the raw API/www base). jsdom pinned
// to a hosted elizacloud origin; platform globals stubbed per test.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSameTabCloudLoginPath,
  canNavigateSameTabForBlockedPopup,
  CLOUD_LOGIN_POPUP_NAME,
  hasSameOriginStewardLogin,
  isTouchPrimaryWebBrowser,
  preOpenCloudLoginWindow,
  resolveCloudSignInPageUrl,
  shouldUseSameTabCloudLogin,
} from "./cloud-login-launch";

const globalWithPlatform = globalThis as typeof globalThis & {
  Capacitor?: { isNativePlatform?: () => boolean };
};
const windowWithElectrobun = window as Window & {
  __electrobunWindowId?: number;
};

// jsdom defines both as own window properties; capture the real descriptors so
// per-test stubs can be fully undone.
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);

function restoreDescriptor(
  name: "location" | "matchMedia",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor);
  } else {
    Reflect.deleteProperty(window, name);
  }
}

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      ({ matches, media: query }) as unknown as MediaQueryList,
  });
}

function stubHostname(hostname: string, protocol = "https:"): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      hostname,
      protocol,
      origin: `${protocol}//${hostname}`,
    },
  });
}

function makePopup(closed: boolean): Window {
  return { closed } as Window;
}

afterEach(() => {
  delete globalWithPlatform.Capacitor;
  delete windowWithElectrobun.__electrobunWindowId;
  vi.restoreAllMocks();
  restoreDescriptor("location", originalLocationDescriptor);
  restoreDescriptor("matchMedia", originalMatchMediaDescriptor);
});

describe("shouldUseSameTabCloudLogin", () => {
  it("chooses the same-tab redirect when the popup handle is null (popup blocked)", () => {
    expect(shouldUseSameTabCloudLogin(null)).toBe(true);
  });

  it("chooses the same-tab redirect when the popup was immediately closed", () => {
    expect(shouldUseSameTabCloudLogin(makePopup(true))).toBe(true);
  });

  it("keeps the popup path while a live popup handle exists (desktop web)", () => {
    expect(shouldUseSameTabCloudLogin(makePopup(false))).toBe(false);
  });

  it("prefers same-tab outright on touch-primary browsers even with a live popup", () => {
    stubMatchMedia(true);
    expect(shouldUseSameTabCloudLogin(makePopup(false))).toBe(true);
  });

  it("never redirects on Capacitor native (external Browser plugin owns the open)", () => {
    globalWithPlatform.Capacitor = { isNativePlatform: () => true };
    expect(shouldUseSameTabCloudLogin(null)).toBe(false);
  });

  it("never redirects inside Electrobun (desktop RPC owns the external open)", () => {
    windowWithElectrobun.__electrobunWindowId = 1;
    expect(shouldUseSameTabCloudLogin(null)).toBe(false);
  });

  it("stays on the device-code flow when the origin has no Steward login", () => {
    stubHostname("self-hosted.example.test");
    expect(shouldUseSameTabCloudLogin(null)).toBe(false);
  });
});

describe("hasSameOriginStewardLogin", () => {
  it("is true on hosted elizacloud web hosts", () => {
    expect(hasSameOriginStewardLogin()).toBe(true);
  });

  it("is false on unknown origins with no Steward API override", () => {
    stubHostname("localhost");
    expect(hasSameOriginStewardLogin()).toBe(false);
  });
});

describe("isTouchPrimaryWebBrowser", () => {
  it("is false when the capability queries do not match (jsdom default)", () => {
    expect(isTouchPrimaryWebBrowser()).toBe(false);
  });

  it("is true for coarse-pointer no-hover browsers", () => {
    stubMatchMedia(true);
    expect(isTouchPrimaryWebBrowser()).toBe(true);
  });

  it("is false for fine-pointer hover browsers", () => {
    stubMatchMedia(false);
    expect(isTouchPrimaryWebBrowser()).toBe(false);
  });
});

describe("buildSameTabCloudLoginPath", () => {
  it("carries the caller's location as returnTo", () => {
    expect(
      buildSameTabCloudLoginPath({ pathname: "/settings", search: "?t=c" }),
    ).toBe(`/login?returnTo=${encodeURIComponent("/settings?t=c")}`);
  });

  it("falls back to /chat when already on the login page", () => {
    expect(buildSameTabCloudLoginPath({ pathname: "/login", search: "" })).toBe(
      "/login?returnTo=%2Fchat",
    );
  });

  it("rejects protocol-relative paths", () => {
    expect(
      buildSameTabCloudLoginPath({ pathname: "//evil.test", search: "" }),
    ).toBe("/login?returnTo=%2Fchat");
  });

  it("reads window.location when no location is given", () => {
    expect(buildSameTabCloudLoginPath()).toBe("/login?returnTo=%2F");
  });
});

describe("preOpenCloudLoginWindow", () => {
  it("skips the popup attempt on touch-primary hosted web (redirect-first)", () => {
    stubMatchMedia(true);
    const openSpy = vi.spyOn(window, "open");
    expect(preOpenCloudLoginWindow()).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("pre-opens the popup on non-touch web (desktop keeps the popup path)", () => {
    const popup = makePopup(false);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);
    expect(preOpenCloudLoginWindow()).toBe(popup);
    expect(openSpy).toHaveBeenCalledWith("about:blank", CLOUD_LOGIN_POPUP_NAME);
  });
});

describe("resolveCloudSignInPageUrl", () => {
  it("uses the same-origin login page with returnTo on hosted https web", () => {
    expect(resolveCloudSignInPageUrl("https://www.elizacloud.ai")).toBe(
      "https://app.elizacloud.ai/login?returnTo=%2F",
    );
  });

  it("maps API and www bases to the apex login page elsewhere", () => {
    stubHostname("localhost", "http:");
    expect(resolveCloudSignInPageUrl("https://api.elizacloud.ai")).toBe(
      "https://elizacloud.ai/login",
    );
    expect(resolveCloudSignInPageUrl("https://www.elizacloud.ai")).toBe(
      "https://elizacloud.ai/login",
    );
  });

  it("appends /login to unknown custom bases", () => {
    stubHostname("localhost", "http:");
    expect(resolveCloudSignInPageUrl("https://cloud.example.test")).toBe(
      "https://cloud.example.test/login",
    );
  });
});

describe("canNavigateSameTabForBlockedPopup", () => {
  it("is true on plain web", () => {
    expect(canNavigateSameTabForBlockedPopup()).toBe(true);
  });

  it("is false on Capacitor native and Electrobun", () => {
    globalWithPlatform.Capacitor = { isNativePlatform: () => true };
    expect(canNavigateSameTabForBlockedPopup()).toBe(false);
    delete globalWithPlatform.Capacitor;
    windowWithElectrobun.__electrobunWindowId = 1;
    expect(canNavigateSameTabForBlockedPopup()).toBe(false);
  });
});

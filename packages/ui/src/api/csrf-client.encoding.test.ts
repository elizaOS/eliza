/** Malformed CSRF cookie percent-encoding must not throw. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/boot-config", () => ({ getBootConfig: vi.fn() }));
vi.mock("../utils/asset-url", () => ({ resolveApiUrl: (url: string) => url }));
vi.mock("../utils/cloud-agent-base", () => ({
  isDedicatedCloudAgentBase: () => false,
}));
vi.mock("./auth/sessions", () => ({
  CSRF_COOKIE_NAME: "eliza_csrf",
  CSRF_HEADER_NAME: "x-eliza-csrf",
}));
vi.mock("./request-timeout", () => ({ defaultFetchTimeoutMs: () => 5_000 }));
vi.mock("../first-run/local-agent-token", () => ({
  hydrateAndroidLocalAgentTokenForUrl: vi.fn(),
}));
vi.mock("./android-native-agent-transport", () => ({
  androidNativeAgentTransportForUrl: vi.fn(),
}));
vi.mock("./ios-local-agent-transport", () => ({
  iosInProcessAgentTransportForUrl: vi.fn(),
}));
vi.mock("./desktop-local-agent-transport", () => ({
  desktopLocalAgentTransportForUrl: vi.fn(),
}));
vi.mock("./desktop-http-transport", () => ({
  desktopHttpTransportForUrl: vi.fn(),
}));
vi.mock("./native-cloud-http-transport", () => ({
  nativeCloudHttpTransportForUrl: vi.fn(),
}));
vi.mock("./transport", () => ({
  fetchAgentTransport: { request: vi.fn() },
}));

import { readCsrfTokenFromCookie } from "./csrf-client";

function setCookie(pair: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: seed the sync jar the helper reads
  document.cookie = pair;
}

function clearCookie(name: string) {
  setCookie(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`);
}

describe("readCsrfTokenFromCookie encoding", () => {
  afterEach(() => {
    clearCookie("eliza_csrf");
  });

  it("returns null for a lone % CSRF cookie before decode throws", () => {
    setCookie("eliza_csrf=%");
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("returns null for %ZZ", () => {
    setCookie("eliza_csrf=%ZZ");
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("returns null for truncated UTF-8 %E0%A4%A", () => {
    setCookie("eliza_csrf=%E0%A4%A");
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it("still decodes a valid %20 value", () => {
    setCookie("eliza_csrf=launch%20pad");
    expect(readCsrfTokenFromCookie()).toBe("launch pad");
  });
});

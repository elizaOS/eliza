import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerUrl } from "../server-url";

declare global {
  interface Window {
    __ELIZA_SERVER_URL__?: string;
  }
}

afterEach(() => {
  if (typeof window !== "undefined") {
    delete window.__ELIZA_SERVER_URL__;
  }
  vi.unstubAllEnvs();
});

describe("getServerUrl", () => {
  it("returns the window-injected URL when present (highest precedence)", () => {
    window.__ELIZA_SERVER_URL__ = "http://127.0.0.1:9999";
    expect(getServerUrl()).toBe("http://127.0.0.1:9999");
  });

  it("strips a trailing slash from the injected URL", () => {
    window.__ELIZA_SERVER_URL__ = "http://127.0.0.1:9999/";
    expect(getServerUrl()).toBe("http://127.0.0.1:9999");
  });

  it("ignores an empty-string window injection", () => {
    window.__ELIZA_SERVER_URL__ = "";
    expect(getServerUrl()).toBe("http://127.0.0.1:3743");
  });

  it("returns the Vite env URL when window is unset", () => {
    vi.stubEnv("VITE_ELIZA_SETUP_SERVER_URL", "http://127.0.0.1:8123");
    expect(getServerUrl()).toBe("http://127.0.0.1:8123");
  });

  it("Vite env loses to window-injected URL", () => {
    window.__ELIZA_SERVER_URL__ = "http://127.0.0.1:9999";
    vi.stubEnv("VITE_ELIZA_SETUP_SERVER_URL", "http://127.0.0.1:8123");
    expect(getServerUrl()).toBe("http://127.0.0.1:9999");
  });

  it("falls back to the dev default in dev mode when nothing else set", () => {
    // jsdom + vitest defaults: not PROD
    expect(getServerUrl()).toBe("http://127.0.0.1:3743");
  });

  it("throws in production when no source provides a URL", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);
    expect(() => getServerUrl()).toThrow(/No server URL configured/);
  });

  it("does not throw in production when window is injected", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);
    window.__ELIZA_SERVER_URL__ = "http://127.0.0.1:4242";
    expect(getServerUrl()).toBe("http://127.0.0.1:4242");
  });
});

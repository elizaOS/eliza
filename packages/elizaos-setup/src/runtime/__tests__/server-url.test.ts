import { afterEach, describe, expect, it } from "vitest";
import { getServerUrl } from "../server-url";

declare global {
  interface Window {
    __ELIZA_SERVER_URL__?: string;
  }
}

afterEach(() => {
  // Reset globals between tests
  if (typeof window !== "undefined") {
    delete window.__ELIZA_SERVER_URL__;
  }
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

  it("falls back to the dev default in dev mode when nothing else set", () => {
    // jsdom + vitest defaults: not PROD
    expect(getServerUrl()).toBe("http://127.0.0.1:3743");
  });

  it("ignores an empty-string window injection", () => {
    window.__ELIZA_SERVER_URL__ = "";
    expect(getServerUrl()).toBe("http://127.0.0.1:3743");
  });
});

// @vitest-environment jsdom

/**
 * Unit coverage for reading and validating the desktop-injected external API
 * base origin from the window global. Window global stubbed, no real shell.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopExternalApiBaseOrigin,
  isDesktopExternalApiBaseUrl,
  isDesktopExternalHttpApiBaseUrl,
} from "./desktop-external-api-base";

function setExternalBase(value: unknown): void {
  (
    window as { __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: unknown }
  ).__ELIZA_DESKTOP_EXTERNAL_API_BASE__ = value;
}

afterEach(() => {
  delete (window as { __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: unknown })
    .__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
});

describe("desktop-external-api-base", () => {
  it("returns null origin when no external base is configured", () => {
    expect(getDesktopExternalApiBaseOrigin()).toBeNull();
    expect(isDesktopExternalApiBaseUrl("https://app.elizacloud.ai")).toBe(
      false,
    );
    expect(isDesktopExternalHttpApiBaseUrl("http://127.0.0.1:8080")).toBe(
      false,
    );
  });

  it("normalizes trailing slash, case, and path to an origin", () => {
    setExternalBase("https://App.ElizaCloud.ai:443/dashboard/");
    expect(getDesktopExternalApiBaseOrigin()).toBe("https://app.elizacloud.ai");
  });

  it("ignores non-http(s) and empty/whitespace values", () => {
    setExternalBase("");
    expect(getDesktopExternalApiBaseOrigin()).toBeNull();
    setExternalBase("   ");
    expect(getDesktopExternalApiBaseOrigin()).toBeNull();
    setExternalBase("file:///etc/passwd");
    expect(getDesktopExternalApiBaseOrigin()).toBeNull();
    setExternalBase(42);
    expect(getDesktopExternalApiBaseOrigin()).toBeNull();
  });

  it("matches a URL by origin regardless of path/case/trailing slash", () => {
    setExternalBase("https://app.elizacloud.ai");
    expect(
      isDesktopExternalApiBaseUrl("https://app.elizacloud.ai/api/agents"),
    ).toBe(true);
    expect(isDesktopExternalApiBaseUrl("https://APP.elizacloud.ai/")).toBe(
      true,
    );
    expect(isDesktopExternalApiBaseUrl("https://other.elizacloud.ai")).toBe(
      false,
    );
    expect(isDesktopExternalApiBaseUrl("not a url")).toBe(false);
  });

  it("isDesktopExternalHttpApiBaseUrl accepts http but rejects the https base", () => {
    // https external base (hosted cloud): matched by the general predicate, NOT the http one.
    setExternalBase("https://app.elizacloud.ai");
    expect(isDesktopExternalApiBaseUrl("https://app.elizacloud.ai")).toBe(true);
    expect(isDesktopExternalHttpApiBaseUrl("https://app.elizacloud.ai")).toBe(
      false,
    );

    // loopback http external base: matched by the http variant (which
    // isExternalPlainHttpUrl deliberately excludes for loopback).
    setExternalBase("http://127.0.0.1:8080");
    expect(isDesktopExternalHttpApiBaseUrl("http://127.0.0.1:8080/api")).toBe(
      true,
    );
    expect(isDesktopExternalHttpApiBaseUrl("https://127.0.0.1:8080")).toBe(
      false,
    );
  });
});

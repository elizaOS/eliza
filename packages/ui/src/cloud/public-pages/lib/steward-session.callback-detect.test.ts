// @vitest-environment jsdom

/**
 * Non-destructive OAuth/token callback detection for the login surface.
 *
 * `hasStewardOAuthCallbackInUrl()` peeks the URL (`?code`, `?token`, `#code`,
 * `#token`, and a snapshotted `__stewardOAuthHash`) WITHOUT stripping anything,
 * so the login section can hold a terminal "completing sign-in" state during the
 * in-flight token exchange instead of re-rendering the provider options (the
 * flash-back-to-sign-in-options bug, #13519). These tests pin that it detects
 * every callback form and stays false for a plain /login load, and prove it does
 * not mutate history the way the destructive `consume*` helpers do.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { hasStewardOAuthCallbackInUrl } from "./steward-session";

const realLocation = window.location;

function setUrl({
  search = "",
  hash = "",
}: {
  search?: string;
  hash?: string;
}): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, pathname: "/login", search, hash },
  });
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  delete (window as Window & { __stewardOAuthHash?: string })
    .__stewardOAuthHash;
  vi.restoreAllMocks();
});

describe("hasStewardOAuthCallbackInUrl", () => {
  it("is false on a plain /login load (no callback params)", () => {
    setUrl({ search: "", hash: "" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(false);
  });

  it("is false when only an unrelated query param is present", () => {
    setUrl({ search: "?returnTo=%2Fdashboard", hash: "" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(false);
  });

  it("detects an OAuth nonce code in the query string", () => {
    setUrl({ search: "?code=abc123", hash: "" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
  });

  it("detects a legacy token in the query string", () => {
    setUrl({ search: "?token=jwt.value.here", hash: "" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
  });

  it("detects an OAuth code in the URL hash fragment", () => {
    setUrl({ search: "", hash: "#code=abc123" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
  });

  it("detects a legacy token in the URL hash fragment", () => {
    setUrl({ search: "", hash: "#token=jwt.value.here&refreshToken=r" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
  });

  it("detects a snapshotted __stewardOAuthHash code even when window.location.hash is empty", () => {
    setUrl({ search: "", hash: "" });
    (window as Window & { __stewardOAuthHash?: string }).__stewardOAuthHash =
      "#code=snapshotted";
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
  });

  it("is false for an empty hash fragment ('#')", () => {
    setUrl({ search: "", hash: "#" });
    expect(hasStewardOAuthCallbackInUrl()).toBe(false);
  });

  it("does not mutate history/search when peeking (unlike the consume* helpers)", () => {
    setUrl({ search: "?code=abc123", hash: "" });
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
    // Second call still detects the callback — nothing was consumed/stripped.
    expect(hasStewardOAuthCallbackInUrl()).toBe(true);
    expect(window.location.search).toBe("?code=abc123");
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

/**
 * Coverage for `routeOAuthReturnDeepLink` in `../deep-link-handler.ts` — the
 * native (Capacitor iOS / Android) OAuth return parser.
 *
 * Native OAuth runs in the system browser and returns to the app via the
 * custom URL scheme (`elizaos://login?code=…` / `elizaos://login#token=…`).
 * This parser rewrites the in-app `/login` location so the existing Steward
 * login `useEffect` consumes the code/token exactly as it does on web, then
 * drives the SPA router via a `popstate` event.
 *
 * Pure URL routing is exercised here — no Capacitor imports — so the suite is
 * isolated from the `@capacitor/app` mock used by `deep-link-entry.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeOAuthReturnDeepLink } from "../deep-link-handler";

const URL_SCHEME = "elizaos";

function resetLocation(): void {
  window.history.replaceState(null, "", "http://localhost/");
}

beforeEach(() => {
  resetLocation();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routeOAuthReturnDeepLink", () => {
  it("matches elizaos://login?code=…&state=… and writes the params onto /login", () => {
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);

    const handled = routeOAuthReturnDeepLink(
      "elizaos://login?code=abc&state=x",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(window.location.pathname).toBe("/login");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("code")).toBe("abc");
    expect(params.get("state")).toBe("x");
    // The SPA router (react-router BrowserRouter) listens for popstate.
    expect(popstate).toHaveBeenCalledTimes(1);

    window.removeEventListener("popstate", popstate);
  });

  it("matches elizaos://login#token=… and writes the hash onto /login", () => {
    const handled = routeOAuthReturnDeepLink(
      "elizaos://login#token=t",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(window.location.pathname).toBe("/login");
    expect(window.location.hash).toBe("#token=t");
  });

  it("matches the #access_token= hash form", () => {
    const handled = routeOAuthReturnDeepLink(
      "elizaos://login#access_token=t&token_type=bearer",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(window.location.pathname).toBe("/login");
    expect(window.location.hash).toContain("access_token=t");
  });

  it("matches the elizaos://oauth-callback alias", () => {
    const handled = routeOAuthReturnDeepLink(
      "elizaos://oauth-callback?code=abc&state=x",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("code")).toBe("abc");
  });

  it("ignores the wrong scheme (no mutation)", () => {
    const before = window.location.href;
    const handled = routeOAuthReturnDeepLink(
      "https://example.com/login?code=abc",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
  });

  it("ignores a first-run deep link (no mutation)", () => {
    const before = window.location.href;
    const handled = routeOAuthReturnDeepLink(
      "elizaos://first-run/runtime/local",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
  });

  it("ignores a non-login host (no mutation)", () => {
    const before = window.location.href;
    const handled = routeOAuthReturnDeepLink(
      "elizaos://chat?code=abc",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
  });

  it("ignores a bare elizaos://login with no OAuth payload (no mutation)", () => {
    const before = window.location.href;
    const handled = routeOAuthReturnDeepLink("elizaos://login", URL_SCHEME);

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
  });

  it("ignores a malformed URL (no crash, no mutation)", () => {
    const before = window.location.href;
    const handled = routeOAuthReturnDeepLink("not-a-url", URL_SCHEME);

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
  });

  it("matches on state alone (provider error / implicit flows still return)", () => {
    const handled = routeOAuthReturnDeepLink(
      "elizaos://login?state=x",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(window.location.pathname).toBe("/login");
  });
});

// @vitest-environment jsdom
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppCatchAllRoute, DASHBOARD_REDIRECTS } from "./CloudRouterShell";

/**
 * Gate B regression. elizacloud.ai (an apex control-plane host) serves
 * packages/app but has no same-origin agent backend, so an UNAUTHENTICATED
 * visitor used to hit the agent shell and 401-wall on /api/*. The catch-all now
 * redirects apex+unauthenticated → the Steward /login page, while every other
 * host (per-agent subdomains, localhost) and any authenticated session falls
 * through to the agent app unchanged.
 */

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A minimally-valid Steward JWT: readStewardSessionFromStorage only base64-decodes
// the payload (needs userId + a future exp); there is no signature verification.
function stewardToken(expSeconds: number): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({ userId: "u1", email: "a@b.test", exp: expSeconds }),
    "sig",
  ].join(".");
}
const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

const realLocation = window.location;
function setHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, hostname },
  });
}

function renderCatchAll(initialPath = "/"): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page" />} />
        {/* The console home target. The real app renders billing here; the test
            just needs a marker to prove the apex root redirected to it. */}
        <Route path="/settings" element={<div data-testid="console-home" />} />
        <Route
          path="*"
          element={
            <AppCatchAllRoute appElement={<div data-testid="agent-app" />} />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CloudRouterShell apex catch-all (Gate B)", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("redirects an unauthenticated apex visitor (elizacloud.ai) to /login", () => {
    setHostname("elizacloud.ai");
    renderCatchAll();
    expect(screen.getByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("redirects an authenticated apex ROOT visitor to the console home (credits/manage), not chat", () => {
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll("/");
    expect(screen.getByTestId("console-home")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("still renders the agent app for an authenticated apex DEEP link (not the bare root)", () => {
    // A shared-agent / deep link on the apex must keep working — only the bare
    // landing is rerouted to the console home.
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll("/some/agent/deep-link");
    expect(screen.getByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByTestId("console-home")).toBeNull();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("redirects an unauthenticated staging apex visitor to /login", () => {
    // staging.elizacloud.ai is a control-plane apex too — it must behave like
    // prod (redirect to /login), so staging can validate the fix before prod.
    setHostname("staging.elizacloud.ai");
    renderCatchAll();
    expect(screen.getByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("does NOT redirect a per-agent subdomain (it boots its real runtime)", () => {
    setHostname("abc123def.elizacloud.ai");
    renderCatchAll();
    expect(screen.getByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("does NOT redirect on localhost (dev / native builds fall through)", () => {
    setHostname("localhost");
    renderCatchAll();
    expect(screen.getByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });
});

describe("CloudRouterShell dashboard compat redirects", () => {
  it("routes legacy /dashboard/api-keys to the single Settings mount via one redirect", () => {
    const apiKeysRedirects = DASHBOARD_REDIRECTS.filter(
      (r) => r.from === "dashboard/api-keys",
    );
    // Exactly one redirect entry — the api-keys surface is mounted only as the
    // Settings → Developer section, so /dashboard/api-keys resolves to it and
    // never to a (now-removed) standalone route.
    expect(apiKeysRedirects).toHaveLength(1);
    expect(apiKeysRedirects[0]?.to).toBe("/settings#cloud-api-keys");
  });
});

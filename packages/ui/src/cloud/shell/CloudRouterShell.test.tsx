// @vitest-environment jsdom
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppCatchAllRoute, DASHBOARD_REDIRECTS } from "./CloudRouterShell";

/**
 * Apex catch-all regression coverage. elizacloud.ai (an apex control-plane
 * host) serves packages/app but has no same-origin agent backend, so the agent
 * app must NEVER boot there: it 404-storms on /api/* and the failed
 * /api/first-run/status probe throws the first-run onboarding chooser over the
 * console (the 2026-07-04 prod bug). The catch-all sends unauthenticated apex
 * visitors to /login and authenticated ones to the /dashboard console home —
 * for EVERY path, not just the bare root — while all other hosts (per-agent
 * subdomains, app.elizacloud.ai, localhost) fall through to the agent app
 * unchanged.
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
        {/* The console home target. The real app renders the dashboard
            overview here; the test just needs a marker to prove the apex
            catch-all redirected to it. */}
        <Route path="/dashboard" element={<div data-testid="console-home" />} />
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

describe("CloudRouterShell apex catch-all", () => {
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

  it("redirects an authenticated apex ROOT visitor to the /dashboard console home, not chat", () => {
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll("/");
    expect(screen.getByTestId("console-home")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("redirects an authenticated apex APP path (/settings) to the console home — the agent app never boots on the apex", () => {
    // /settings falls through to the catch-all (it is an in-app view, not a
    // registered cloud route). Booting the app here is exactly the prod bug:
    // no same-origin backend → first-run chooser over the console.
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll("/settings");
    expect(screen.getByTestId("console-home")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("redirects any other authenticated apex deep app path to the console home", () => {
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll("/some/agent/deep-link");
    expect(screen.getByTestId("console-home")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  it("redirects an unauthenticated staging apex visitor to /login", () => {
    // staging.elizacloud.ai is a control-plane apex too — it must behave like
    // prod and redirect an unauthenticated visitor to /login.
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
  it("carries NO redirects for surfaces that are standalone console routes", () => {
    // billing / api-keys / monetization / account / security / permissions are
    // registered routes now (see register-all.test.ts); a same-path redirect
    // entry would be dead weight that could shadow them if ordering changed.
    const standalone = new Set([
      "dashboard/billing",
      "dashboard/api-keys",
      "dashboard/monetization",
      "dashboard/account",
      "dashboard/security",
      "dashboard/security/permissions",
    ]);
    for (const r of DASHBOARD_REDIRECTS) {
      expect(standalone.has(r.from), `unexpected redirect for ${r.from}`).toBe(
        false,
      );
    }
  });

  it("resolves legacy earnings + affiliates links to the monetization console page", () => {
    const targets = Object.fromEntries(
      DASHBOARD_REDIRECTS.map((r) => [r.from, r.to]),
    );
    expect(targets["dashboard/earnings"]).toBe("/dashboard/monetization");
    expect(targets["dashboard/affiliates"]).toBe("/dashboard/monetization");
  });
});

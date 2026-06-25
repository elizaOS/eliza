// @vitest-environment jsdom
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppCatchAllRoute } from "./CloudRouterShell";

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

function renderCatchAll(): void {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page" />} />
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

  it("renders the agent app on apex when a valid Steward session exists", () => {
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll();
    expect(screen.getByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByTestId("login-page")).toBeNull();
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

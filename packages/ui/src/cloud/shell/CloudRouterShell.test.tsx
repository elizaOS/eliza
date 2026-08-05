/** Verifies the CloudRouterShell catch-all host matrix — apex console redirects (with zero network), app-mode gating on the Eliza app hosts, and untouched fall-through everywhere else — through the package's configured test harness. */
// @vitest-environment jsdom
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";
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

/** Same catch-all render, plus the query provider + route markers the lazy
 * app-mode gate needs. Used by the app-host tests; the apex tests keep the
 * bare render above, proving the apex path needs none of this. */
function renderCatchAllWithAppModeMarkers(initialPath = "/"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div data-testid="login-page" />} />
          <Route
            path="/dashboard"
            element={<div data-testid="console-home" />}
          />
          <Route
            path="/dashboard/agents"
            element={<div data-testid="instances-page" />}
          />
          <Route path="/join" element={<div data-testid="join-page" />} />
          <Route
            path="*"
            element={
              <AppCatchAllRoute appElement={<div data-testid="agent-app" />} />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const realFetch = globalThis.fetch;
let fetchLog: string[] = [];

/** Hand-rolled fetch recorder: logs `METHOD url` for every call and answers
 * with `respond` (defaulting to an empty agents list). */
function installFetchRecorder(
  respond?: (url: string, init?: RequestInit) => Response,
): void {
  fetchLog = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(
      respond
        ? respond(url, init)
        : new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  }) as typeof fetch;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it("redirects an apex visitor with an invalid stored token instead of holding forever outside StewardAuthProvider", () => {
    setHostname("elizacloud.ai");
    localStorage.setItem(STEWARD_TOKEN_KEY, "not-a-jwt");
    renderCatchAll("/settings");

    expect(screen.getByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(screen.queryByText("Signing you in…")).toBeNull();
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

describe("CloudRouterShell apex catch-all — zero app-mode network", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    globalThis.fetch = realFetch;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("an unauthenticated apex render performs ZERO fetches (byte-identical apex)", async () => {
    setHostname("elizacloud.ai");
    installFetchRecorder();
    renderCatchAll();
    expect(screen.getByTestId("login-page")).toBeTruthy();
    await flushMicrotasks();
    expect(fetchLog).toEqual([]);
  });

  it("an authenticated apex render performs ZERO fetches (no agents probe, no pairing)", async () => {
    setHostname("elizacloud.ai");
    installFetchRecorder();
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAll();
    expect(screen.getByTestId("console-home")).toBeTruthy();
    await flushMicrotasks();
    expect(fetchLog).toEqual([]);
  });
});

describe("CloudRouterShell app-mode catch-all (app.elizacloud.ai)", () => {
  const realAssign = appModeNavigation.assign;
  const realReplace = appModeNavigation.replace;
  let assignedUrls: string[] = [];

  afterEach(() => {
    cleanup();
    localStorage.clear();
    globalThis.fetch = realFetch;
    appModeNavigation.assign = realAssign;
    appModeNavigation.replace = realReplace;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("sends an unauthenticated app-host visitor through the login flow, not the agent app", async () => {
    setHostname("app.elizacloud.ai");
    installFetchRecorder();
    renderCatchAllWithAppModeMarkers();
    // The gate chunk is lazy; the login redirect lands after it loads.
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(fetchLog).toEqual([]);
  });

  it("gates every non-registered (marketing/app) path on the app host, not just the root", async () => {
    setHostname("app.elizacloud.ai");
    installFetchRecorder();
    renderCatchAllWithAppModeMarkers("/some/marketing-path");
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("routes a signed-in app-host visitor with one running dedicated agent into its web UI via pairing", async () => {
    setHostname("app.elizacloud.ai");
    const redirectUrl = "https://agent-1.elizacloud.ai/pair?token=tok";
    installFetchRecorder((url, init) => {
      if (url === "/api/v1/eliza/agents/agent-1/pairing-token") {
        return new Response(JSON.stringify({ data: { redirectUrl } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/v1/eliza/agents" && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "agent-1",
                agentName: "Eliza",
                status: "running",
                executionTier: "dedicated-always",
                lastHeartbeatAt: "2026-08-05T00:00:00.000Z",
                updatedAt: "2026-08-05T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: `unstubbed ${url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    assignedUrls = [];
    // Both seams feed one log: automatic entry replaces history, an explicit
    // chooser pick pushes; the split itself is pinned in app-mode.test.ts.
    appModeNavigation.assign = (url: string) => {
      assignedUrls.push(url);
    };
    appModeNavigation.replace = (url: string) => {
      assignedUrls.push(url);
    };
    localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken(FUTURE_EXP));
    renderCatchAllWithAppModeMarkers();

    await waitFor(() => expect(assignedUrls).toEqual([redirectUrl]));
    expect(fetchLog).toContain(
      "POST /api/v1/eliza/agents/agent-1/pairing-token",
    );
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("app-staging.elizacloud.ai is an app-mode host too (staging mirrors prod)", async () => {
    setHostname("app-staging.elizacloud.ai");
    installFetchRecorder();
    renderCatchAllWithAppModeMarkers();
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
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

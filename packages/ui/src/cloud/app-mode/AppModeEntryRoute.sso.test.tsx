/** SSO auto-bridge behavior of the app-mode entry gate, with the jsdom document origin pinned to the canonical managed-app host so the hostname-gated bridge decision runs exactly as deployed — real render, hand-rolled fetch/navigation stubs. The localhost-origin suite proves the same paths stay inert off managed hosts. */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://cloud.eliza.app/"}

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModeEntryRoute } from "./AppModeEntryRoute";
import { appModeNavigation } from "./app-mode";

const SSO_STATE_KEY = "eliza_sso_bridge_state";
const SSO_VERIFIER_KEY = "eliza_sso_bridge_verifier";
const SSO_ATTEMPT_KEY = "eliza_sso_bridge_attempted_at";
const SSO_LOGGED_OUT_KEY = "eliza_sso_logged_out";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signIn(): void {
  localStorage.setItem(
    STEWARD_TOKEN_KEY,
    [
      base64url({ alg: "none", typ: "JWT" }),
      base64url({
        userId: "u1",
        email: "a@b.test",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "sig",
    ].join("."),
  );
}

function clearAuthedCookie(): void {
  document.cookie =
    "steward-authed=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

const realFetch = globalThis.fetch;
const realReplace = appModeNavigation.replace;
let fetchLog: string[];
let replacedUrls: string[];

function stubNetwork(): void {
  fetchLog = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/eliza/agents") {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: `unstubbed ${url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  replacedUrls = [];
  appModeNavigation.replace = (url: string) => {
    replacedUrls.push(url);
  };
}

function LoginProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="login-page">{location.search}</div>;
}

function renderEntry(initialPath = "/"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route path="/join" element={<div data-testid="join-page" />} />
          <Route
            path="*"
            element={
              <AppModeEntryRoute appElement={<div data-testid="agent-app" />} />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stubNetwork();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  clearAuthedCookie();
  globalThis.fetch = realFetch;
  appModeNavigation.replace = realReplace;
});

describe("AppModeEntryRoute — SSO auto-bridge (managed app origin)", () => {
  it("signed out + domain session marker → full-page bounce to the eliza.app mint leg with a stored state nonce + PKCE challenge", async () => {
    document.cookie = "steward-authed=1; path=/";
    renderEntry("/chat?x=1");

    await waitFor(() => expect(replacedUrls).toHaveLength(1));
    const url = new URL(replacedUrls[0]);
    expect(url.origin).toBe("https://eliza.app");
    expect(url.pathname).toBe("/auth/bridge");
    expect(url.searchParams.get("returnTo")).toBe("/chat?x=1");
    // The echoed state is exactly the nonce persisted for the return leg.
    expect(url.searchParams.get("state")).toBe(
      sessionStorage.getItem(SSO_STATE_KEY),
    );
    // The URL carries the CHALLENGE; the verifier stays in sessionStorage and
    // never appears in the (loggable) URL.
    const challenge = url.searchParams.get("challenge");
    const verifier = sessionStorage.getItem(SSO_VERIFIER_KEY);
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge).not.toBe(verifier);
    expect(replacedUrls[0]).not.toContain(verifier as string);
    // Loop guard armed before leaving.
    expect(sessionStorage.getItem(SSO_ATTEMPT_KEY)).not.toBeNull();
    // The gate holds a notice — never the login page under a leaving redirect.
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(screen.getByText("Signing you in")).toBeTruthy();
  });

  it("signed out with no cross-host cookie hint starts the auth-origin login handoff", async () => {
    renderEntry("/");
    await waitFor(() => expect(replacedUrls).toHaveLength(1));
    expect(replacedUrls[0]).toMatch(
      /^https:\/\/eliza\.app\/auth\/bridge\?state=/,
    );
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(screen.getByText("Signing you in")).toBeTruthy();
  });

  it("logout-then-visit does NOT re-bridge: the explicit logged-out marker wins over a live eliza.app session", async () => {
    document.cookie = "steward-authed=1; path=/";
    localStorage.setItem(SSO_LOGGED_OUT_KEY, "1");
    renderEntry("/");
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(replacedUrls).toEqual([]);
  });

  it("a fresh failed attempt (loop guard) falls through to login instead of bouncing again", async () => {
    document.cookie = "steward-authed=1; path=/";
    sessionStorage.setItem(SSO_ATTEMPT_KEY, String(Date.now()));
    renderEntry("/");
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(replacedUrls).toEqual([]);
  });

  it("a real sign-in clears the logged-out marker (logout suppression ends at the next login)", async () => {
    localStorage.setItem(SSO_LOGGED_OUT_KEY, "1");
    signIn();
    renderEntry("/");
    expect(await screen.findByTestId("join-page")).toBeTruthy();
    expect(localStorage.getItem(SSO_LOGGED_OUT_KEY)).toBeNull();
    expect(replacedUrls).toEqual([]);
  });
});

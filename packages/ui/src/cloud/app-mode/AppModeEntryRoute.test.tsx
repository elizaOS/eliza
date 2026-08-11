/** Verifies the AppModeEntryRoute gate — auth gating and the chat-floor routing table (any agents → the same-origin chat app with ZERO pairing traffic; empty org → /join) — through the package's configured test harness (jsdom, real render, hand-rolled fetch stub; no Steward provider mounted, sessions come from the persisted localStorage JWT). */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppModeEntryRoute } from "./AppModeEntryRoute";
import { type AppModeAgent, appModeNavigation } from "./app-mode";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A minimally-valid Steward JWT: readStewardSessionFromStorage only
// base64-decodes the payload (userId + a future exp); no signature check.
function stewardToken(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId: "u1",
      email: "a@b.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "sig",
  ].join(".");
}

function signIn(): void {
  localStorage.setItem(STEWARD_TOKEN_KEY, stewardToken());
}

function agent(
  overrides: Partial<AppModeAgent> & { id: string },
): AppModeAgent {
  return {
    agentName: overrides.id,
    status: "running",
    executionTier: "dedicated-always",
    lastHeartbeatAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

interface StubRoutes {
  /** Response for GET /api/v1/eliza/agents. */
  agents: () => Response;
}

const realFetch = globalThis.fetch;
const realAssign = appModeNavigation.assign;
const realReplace = appModeNavigation.replace;
let fetchLog: string[];
let assignedUrls: string[];

function stubNetwork(routes: StubRoutes): void {
  fetchLog = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/eliza/agents") {
      return Promise.resolve(routes.agents());
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: `unstubbed ${url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  assignedUrls = [];
  // Any full-page navigation (the old pairing redirect used these seams) is a
  // chat-floor violation at entry; the suite pins that the log stays empty.
  appModeNavigation.assign = (url: string) => {
    assignedUrls.push(url);
  };
  appModeNavigation.replace = (url: string) => {
    assignedUrls.push(url);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function agentsOk(list: AppModeAgent[]): () => Response {
  return () => jsonResponse(200, { success: true, data: list });
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
          <Route
            path="/dashboard/agents"
            element={<div data-testid="instances-page" />}
          />
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = realFetch;
  appModeNavigation.assign = realAssign;
  appModeNavigation.replace = realReplace;
});

describe("AppModeEntryRoute — auth gating", () => {
  it("unauthenticated → the existing login flow, returnTo pointing back at the entry", () => {
    stubNetwork({ agents: agentsOk([]) });
    renderEntry("/");

    expect(screen.getByTestId("login-page").textContent).toBe("?returnTo=%2F");
    expect(screen.queryByTestId("agent-app")).toBeNull();
    // Signed out, nothing to decide: no app-mode network calls at all.
    expect(fetchLog).toEqual([]);
  });

  it("unauthenticated on a deep non-app path → login preserves that path for the post-login re-run", () => {
    stubNetwork({ agents: agentsOk([]) });
    renderEntry("/pricing");

    expect(screen.getByTestId("login-page").textContent).toBe(
      "?returnTo=%2Fpricing",
    );
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });
});

describe("AppModeEntryRoute — chat-floor routing table", () => {
  it("one running dedicated agent → the same-origin chat app; NO pairing token is minted, NO redirect fires", async () => {
    // The cold-start dead-end pin. `status: "running"` in the control plane
    // does not mean the container is warm: the previous gate POSTed
    // /pairing-token here (one-time, 60s TTL) and full-page-redirected into
    // `<agentId>.…/pair?token=…`; a cold-starting agent cannot consume the
    // token inside the TTL, so every cold start dead-ended on the agent's
    // "Sign-in link expired" page. Entry must render the chat app instead and
    // issue zero pairing traffic.
    signIn();
    stubNetwork({ agents: agentsOk([agent({ id: "agent-1" })]) });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
    expect(assignedUrls).toEqual([]);
  });

  it("several running dedicated agents → still the chat app (no chooser interstitial at entry)", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([
        agent({ id: "stale", lastHeartbeatAt: "2026-08-01T00:00:00.000Z" }),
        agent({ id: "fresh", lastHeartbeatAt: "2026-08-05T00:00:00.000Z" }),
      ]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
  });

  it("dedicated agents exist but none running → the same-origin chat app (never the console)", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "stopped" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("an errored dedicated agent (failed provision) → the same-origin chat app, not a dashboard bounce", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "error" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("a provisioning (cold-starting) dedicated agent → the chat app, no doomed pairing hop", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "provisioning" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
    expect(assignedUrls).toEqual([]);
  });

  it("no agents at all → the /join deploy-first-agent flow", async () => {
    signIn();
    stubNetwork({ agents: agentsOk([]) });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
  });

  it("shared-tier-only org → the same-origin chat app, unchanged", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "s1", executionTier: "shared" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("agents fetch failure → graceful fallback to the same-origin chat app", async () => {
    signIn();
    stubNetwork({
      agents: () => jsonResponse(500, { error: "backend down" }),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
  });

  it("never renders the instances console from entry, in any state", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([
        agent({ id: "e1", status: "error" }),
        agent({ id: "r1", status: "running" }),
        agent({ id: "s1", status: "stopped" }),
      ]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("instances-page")).toBeNull(),
    );
  });
});

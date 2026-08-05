/** Verifies the AppModeEntryRoute gate — auth gating, the agents-driven routing table, and the pairing redirect outcomes (200 / 202 / error) — through the package's configured test harness (jsdom, real render, hand-rolled fetch stub; no Steward provider mounted, sessions come from the persisted localStorage JWT). */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  /** Response for POST /api/v1/eliza/agents/:id/pairing-token. */
  pairing?: (agentId: string) => Response;
}

const realFetch = globalThis.fetch;
const realAssign = appModeNavigation.assign;
let fetchLog: string[];
let assignedUrls: string[];

function stubNetwork(routes: StubRoutes): void {
  fetchLog = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(`${init?.method ?? "GET"} ${url}`);
    const pairing = /^\/api\/v1\/eliza\/agents\/([^/]+)\/pairing-token$/.exec(
      url,
    );
    if (pairing && routes.pairing) {
      return Promise.resolve(routes.pairing(pairing[1]));
    }
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
  appModeNavigation.assign = (url: string) => {
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

describe("AppModeEntryRoute — routing table", () => {
  it("exactly one running dedicated agent → full-page pairing redirect into its web UI", async () => {
    signIn();
    const redirectUrl = "https://agent-1.elizacloud.ai/pair?token=tok";
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1" })]),
      pairing: () => jsonResponse(200, { data: { redirectUrl } }),
    });
    renderEntry();

    await waitFor(() => expect(assignedUrls).toEqual([redirectUrl]));
    expect(fetchLog).toContain(
      "POST /api/v1/eliza/agents/agent-1/pairing-token",
    );
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("pairing 202 (agent must resume) → lands on the Instances view", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1" })]),
      pairing: () => jsonResponse(202, { data: { status: "starting" } }),
    });
    renderEntry();

    expect(await screen.findByTestId("instances-page")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("pairing failure → visible error state with an escape to Instances, never a blank screen", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1" })]),
      pairing: () => jsonResponse(503, { error: "agent not reachable" }),
    });
    renderEntry();

    expect(await screen.findByText("agent not reachable")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Go to your instances" }),
    );
    expect(await screen.findByTestId("instances-page")).toBeTruthy();
  });

  it("several running dedicated agents → chooser (most recently active first), rows pair on demand", async () => {
    signIn();
    const redirectUrl = "https://fresh.elizacloud.ai/pair?token=tok";
    stubNetwork({
      agents: agentsOk([
        agent({ id: "stale", lastHeartbeatAt: "2026-08-01T00:00:00.000Z" }),
        agent({ id: "fresh", lastHeartbeatAt: "2026-08-05T00:00:00.000Z" }),
      ]),
      pairing: (agentId) =>
        agentId === "fresh"
          ? jsonResponse(200, { data: { redirectUrl } })
          : jsonResponse(503, { error: "wrong agent" }),
    });
    renderEntry();

    const rows = await screen.findAllByRole("button", { name: /Open/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "freshOpen",
      "staleOpen",
    ]);

    fireEvent.click(rows[0]);
    await waitFor(() => expect(assignedUrls).toEqual([redirectUrl]));
    expect(fetchLog).toContain("POST /api/v1/eliza/agents/fresh/pairing-token");
  });

  it("dedicated agents exist but none running → the Instances view (resume from there)", async () => {
    signIn();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "stopped" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("instances-page")).toBeTruthy();
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

  it("agents fetch failure → graceful fallback to the Instances view", async () => {
    signIn();
    stubNetwork({
      agents: () => jsonResponse(500, { error: "backend down" }),
    });
    renderEntry();

    expect(await screen.findByTestId("instances-page")).toBeTruthy();
  });
});

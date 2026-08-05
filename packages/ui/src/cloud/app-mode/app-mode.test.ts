/** Verifies the app-mode hostname matrix, entry-routing decision table, and pairing redirect through the package's configured test harness (jsdom, hand-rolled fetch stub — no module mocks). */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  APP_MODE_CREATE_PATH,
  APP_MODE_INSTANCES_PATH,
  type AppModeAgent,
  appModeNavigation,
  decideAppModeRoute,
  isAppModeHostname,
  redirectToAgentWebUI,
} from "./app-mode";

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

describe("isAppModeHostname — hostname matrix", () => {
  const matrix: Array<[string, boolean]> = [
    ["app.elizacloud.ai", true],
    ["app-staging.elizacloud.ai", true],
    ["APP.ELIZACLOUD.AI", true],
    ["elizacloud.ai", false],
    ["www.elizacloud.ai", false],
    ["staging.elizacloud.ai", false],
    ["api.elizacloud.ai", false],
    ["api-staging.elizacloud.ai", false],
    ["abc123def.elizacloud.ai", false],
    ["app.elizacloud.ai.evil.example", false],
    ["localhost", false],
    ["127.0.0.1", false],
  ];

  for (const [hostname, expected] of matrix) {
    it(`${hostname} → ${expected}`, () => {
      expect(isAppModeHostname(hostname, false)).toBe(expected);
    });
  }

  it("dev escape hatch turns app-mode on regardless of hostname", () => {
    expect(isAppModeHostname("localhost", true)).toBe(true);
    expect(isAppModeHostname("elizacloud.ai", false)).toBe(false);
  });
});

describe("decideAppModeRoute — decision table", () => {
  it("no agents at all → the /join deploy-first-agent flow", () => {
    expect(decideAppModeRoute([])).toEqual({
      kind: "create",
      to: APP_MODE_CREATE_PATH,
    });
  });

  it("exactly one running dedicated agent → enter-agent", () => {
    const a = agent({ id: "a1" });
    expect(decideAppModeRoute([a])).toEqual({ kind: "enter-agent", agent: a });
  });

  it("a running dedicated agent wins over running shared + stopped dedicated noise", () => {
    const winner = agent({ id: "ded-1" });
    const route = decideAppModeRoute([
      agent({ id: "shared-1", executionTier: "shared" }),
      agent({ id: "ded-stopped", status: "stopped" }),
      winner,
    ]);
    expect(route).toEqual({ kind: "enter-agent", agent: winner });
  });

  it("several running dedicated agents → chooser ordered most-recently-active first (lastHeartbeatAt ?? updatedAt)", () => {
    const stale = agent({
      id: "stale",
      lastHeartbeatAt: "2026-08-01T00:00:00.000Z",
    });
    const fresh = agent({
      id: "fresh",
      lastHeartbeatAt: "2026-08-05T00:00:00.000Z",
    });
    const heartbeatless = agent({
      id: "no-heartbeat",
      lastHeartbeatAt: null,
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const route = decideAppModeRoute([stale, heartbeatless, fresh]);
    expect(route.kind).toBe("choose-agent");
    if (route.kind !== "choose-agent") throw new Error("unreachable");
    expect(route.running.map((a) => a.id)).toEqual([
      "fresh",
      "no-heartbeat",
      "stale",
    ]);
  });

  it("unparseable activity stamps sort last instead of throwing", () => {
    const broken = agent({ id: "broken", lastHeartbeatAt: "not-a-date" });
    const fresh = agent({
      id: "fresh",
      lastHeartbeatAt: "2026-08-05T00:00:00.000Z",
    });
    const route = decideAppModeRoute([broken, fresh]);
    if (route.kind !== "choose-agent") throw new Error("expected chooser");
    expect(route.running.map((a) => a.id)).toEqual(["fresh", "broken"]);
  });

  it("custom-tier agents are pairing candidates (per-container tier)", () => {
    const custom = agent({ id: "c1", executionTier: "custom" });
    expect(decideAppModeRoute([custom])).toEqual({
      kind: "enter-agent",
      agent: custom,
    });
  });

  it("dedicated agents exist but none running → Instances resume", () => {
    const route = decideAppModeRoute([
      agent({ id: "d1", status: "stopped" }),
      agent({ id: "d2", status: "sleeping" }),
    ]);
    expect(route).toEqual({ kind: "resume", to: APP_MODE_INSTANCES_PATH });
  });

  it("deletion_pending is not running → Instances resume", () => {
    const route = decideAppModeRoute([
      agent({ id: "d1", status: "deletion_pending" }),
    ]);
    expect(route).toEqual({ kind: "resume", to: APP_MODE_INSTANCES_PATH });
  });

  it("shared-tier-only org → chat-home (the same-origin chat app, unchanged)", () => {
    const route = decideAppModeRoute([
      agent({ id: "s1", executionTier: "shared" }),
      agent({ id: "s2", executionTier: "shared", status: "stopped" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });
});

describe("redirectToAgentWebUI — pairing redirect", () => {
  const realFetch = globalThis.fetch;
  const realAssign = appModeNavigation.assign;
  let fetchCalls: Array<{ url: string; method: string | undefined }>;
  let assignedUrls: string[];

  function stubFetch(respond: () => Response | Promise<Response>): void {
    fetchCalls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), method: init?.method });
      return Promise.resolve(respond());
    }) as typeof fetch;
  }

  function captureAssign(): void {
    assignedUrls = [];
    appModeNavigation.assign = (url: string) => {
      assignedUrls.push(url);
    };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    appModeNavigation.assign = realAssign;
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("200 with a redirectUrl → full-page assign to the agent's /pair URL", async () => {
    const redirectUrl = "https://agent-1.elizacloud.ai/pair?token=tok";
    stubFetch(() => jsonResponse(200, { data: { redirectUrl } }));
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result).toEqual({ ok: true, redirectUrl });
    expect(assignedUrls).toEqual([redirectUrl]);
    expect(fetchCalls).toEqual([
      { url: "/api/v1/eliza/agents/agent-1/pairing-token", method: "POST" },
    ]);
  });

  it("202 (agent must resume first) → starting result, no navigation", async () => {
    stubFetch(() =>
      jsonResponse(202, { data: { status: "starting", retryAfterMs: 5000 } }),
    );
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result).toEqual({ ok: false, starting: true });
    expect(assignedUrls).toEqual([]);
  });

  it("error status → the server's error message, no navigation", async () => {
    stubFetch(() => jsonResponse(503, { error: "agent not reachable" }));
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result).toEqual({
      ok: false,
      starting: false,
      error: "agent not reachable",
    });
    expect(assignedUrls).toEqual([]);
  });

  it("non-JSON error body → HTTP-status fallback message", async () => {
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result).toEqual({
      ok: false,
      starting: false,
      error: "Failed to generate pairing token (HTTP 502)",
    });
    expect(assignedUrls).toEqual([]);
  });

  it("200 without a redirectUrl → explicit error, no navigation", async () => {
    stubFetch(() => jsonResponse(200, { data: {} }));
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result.ok).toBe(false);
    if (result.ok || result.starting) throw new Error("expected error result");
    expect(result.error).toMatch(/no redirect url/i);
    expect(assignedUrls).toEqual([]);
  });

  it("transport failure → error result, never a throw", async () => {
    fetchCalls = [];
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as typeof fetch;
    captureAssign();

    const result = await redirectToAgentWebUI("agent-1");

    expect(result).toEqual({
      ok: false,
      starting: false,
      error: "network down",
    });
    expect(assignedUrls).toEqual([]);
  });
});

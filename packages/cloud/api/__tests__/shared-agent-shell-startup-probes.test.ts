/**
 * Shared-agent REST coverage for the app-shell startup probes a Tier-0 agent
 * used to 404. Each case drives the real mounted Hono route at the exact browser
 * path the hosted app requests, so a synthesis that only works in a unit test of
 * the adapter helper cannot pass here.
 *
 * These probes are what the console showed failing on a live shared agent: an
 * empty-but-errored slash menu, an advisory runtime-mode snapshot that fell back
 * to local heuristics, and a LifeOps capture loop re-reporting an "unexpected"
 * failure on every page-visibility change.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

const shellRoute = (
  await import("../v1/eliza/agents/[agentId]/api/[...path]/route")
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT_ID = "cc3f37f5-f69a-4b27-9fa1-a4bd3d702136";
// The Capacitor WebView origin, which CORS reflects (and allows credentials for)
// instead of answering the wildcard a plain browser origin gets. Asserting the
// reflected form is the stricter check and matches the sibling shell tests.
const APP_ORIGIN = "https://localhost";
const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", shellRoute);

function request(path: string, method = "GET") {
  return app.request(
    `https://api.elizacloud.ai/api/v1/eliza/agents/${AGENT_ID}/api/${path}`,
    { method, headers: { Origin: APP_ORIGIN } },
  );
}

describe("shared-agent shell startup probes", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: {
        id: AGENT_ID,
        organization_id: "org-1",
        execution_tier: "shared",
      },
      agentId: AGENT_ID,
      orgId: "org-1",
      agentName: "Eliza",
    });
  });

  test("GET /api/runtime/mode reports cloud, not a local-heuristic fallback", async () => {
    const response = await request("runtime/mode");

    expect(response.status).toBe(200);
    // Both values must satisfy the client's RuntimeMode /
    // RuntimeDeploymentRuntime unions or fetchRuntimeModeSnapshot() discards the
    // whole snapshot and falls back to local heuristics.
    await expect(response.json()).resolves.toEqual({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  test("GET /api/commands returns an empty catalog instead of failing the slash menu", async () => {
    const response = await request("commands?surface=gui");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ commands: [] });
  });

  test("GET /api/custom-actions returns an empty action list", async () => {
    const response = await request("custom-actions");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actions: [] });
  });

  test("GET /api/agent/events returns an empty event log with a query string", async () => {
    const response = await request("agent/events?limit=300");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
  });

  test("GET /api/stream/settings returns empty settings in the agent-server envelope", async () => {
    const response = await request("stream/settings");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, settings: {} });
  });

  test("POST /api/apps/overlay-presence acks with no resolved app", async () => {
    const response = await request("apps/overlay-presence", "POST");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      appName: null,
    });
  });

  test("POST /api/views/chat/navigate acks the one view this tier serves", async () => {
    const response = await request("views/chat/navigate", "POST");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      viewId: "chat",
      viewPath: "/chat",
      viewType: "gui",
    });
  });

  test("POST /api/lifeops/activity-signals returns the 503 the client's capture latch recognizes", async () => {
    const response = await request("lifeops/activity-signals", "POST");

    // 503 is load-bearing, not cosmetic: activity-signals-capture.ts's
    // isRuntimeUnavailableError() matches status 503 on this exact path and
    // latches `runtimeReady = false`. Any other status falls through to
    // console.error and the signal spam returns.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      code: "lifeops_runtime_unavailable",
      error:
        "LifeOps activity signals require a dedicated agent runtime; this shared agent does not ingest them.",
      capability: "lifeops-activity-signals",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
    });
  });

  test("POST /api/conversations/:id/greeting reports no greeting without inventing text", async () => {
    const response = await request(
      `conversations/${AGENT_ID}/greeting?lang=en`,
      "POST",
    );

    expect(response.status).toBe(200);
    // Empty text + generated:false is the agent server's own "no greeting
    // available" shape; the client guards on `if (data.text)` so nothing renders.
    // This tier neither runs a billed turn nor invents character dialogue.
    await expect(response.json()).resolves.toEqual({
      text: "",
      agentName: "Eliza",
      generated: false,
      persisted: false,
    });
  });

  test("a greeting for a non-canonical conversation stays a 404", async () => {
    const response = await request(
      "conversations/11111111-2222-3333-4444-555555555555/greeting",
      "POST",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Not found",
      code: "resource_not_found",
    });
  });

  test("every synthesized probe carries the app CORS origin", async () => {
    for (const [method, path] of [
      ["GET", "runtime/mode"],
      ["GET", "commands"],
      ["GET", "custom-actions"],
      ["GET", "agent/events"],
      ["GET", "stream/settings"],
      ["POST", "apps/overlay-presence"],
      ["POST", "views/chat/navigate"],
      ["POST", "lifeops/activity-signals"],
      ["POST", `conversations/${AGENT_ID}/greeting`],
    ] as const) {
      const response = await request(path, method);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        APP_ORIGIN,
      );
    }
  });

  test("a view this tier does not serve stays a 404 rather than a fake ack", async () => {
    const response = await request("views/workbench/navigate", "POST");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Not found",
      code: "resource_not_found",
    });
  });

  test("an unknown shell path is still not masked by the new cases", async () => {
    const getResponse = await request("totally-unknown");
    expect(getResponse.status).toBe(404);

    const postResponse = await request("totally-unknown", "POST");
    expect(postResponse.status).toBe(404);
  });

  test("navigate requires the full views/<id>/navigate shape", async () => {
    // A bare `views` POST must not be mistaken for a navigate ack.
    expect((await request("views", "POST")).status).toBe(404);
    expect((await request("views/chat", "POST")).status).toBe(404);
    expect((await request("views/chat/navigate/extra", "POST")).status).toBe(
      404,
    );
  });

  test("no probe answers before the agent resolves — an unauthorized caller gets its error", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Agent not found",
      status: 404,
    });

    for (const [method, path] of [
      ["GET", "runtime/mode"],
      ["GET", "commands"],
      ["GET", "custom-actions"],
      ["GET", "agent/events"],
      ["GET", "stream/settings"],
      ["POST", "apps/overlay-presence"],
      ["POST", "views/chat/navigate"],
      ["POST", "lifeops/activity-signals"],
      ["POST", `conversations/${AGENT_ID}/greeting`],
    ] as const) {
      const response = await request(path, method);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "Agent not found",
      });
    }
  });
});

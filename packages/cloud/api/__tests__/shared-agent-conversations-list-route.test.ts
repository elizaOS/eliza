// Exercises the SHARED-agent conversations LIST route — the exact endpoint the
// PWA cloud-managed init gate polls (`isCloudProxyPassthroughServing` ->
// `GET /api/conversations`). Regression guard for CONVERSATIONS-500-2026-07-22:
// the list route calls `agent.created_at.toISOString()`, so if resolveSharedAgent
// ever hands back a non-Date `created_at` (as the scope cache did after its JSON
// round-trip) the route 500s and strands the PWA on "initializing agent". These
// tests pin the 200 contract for a well-typed resolver result and confirm the
// route reads `created_at` as a Date.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

const conversationsListRoute = (
  await import("../v1/eliza/agents/[agentId]/api/conversations/route")
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT = "69a6249e-0000-4a1a-8a16-19aee293bfea";
const CREATED = new Date("2026-06-18T12:34:56.000Z");
const APP_ORIGIN = "https://localhost";

function listConversations(origin?: string): Response | Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
  };
  if (origin) headers.Origin = origin;
  return conversationsListRoute.request("/", { method: "GET", headers });
}

describe("shared agent conversations LIST route (PWA init gate probe)", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: {
        agent_name: "Eliza",
        created_at: CREATED,
        execution_tier: "shared",
      },
      agentId: AGENT,
      orgId: "org-1",
      agentName: "Eliza",
    });
  });

  test("GET returns 200 with the canonical single conversation", async () => {
    const res = await listConversations(APP_ORIGIN);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      conversations: [
        {
          id: AGENT,
          roomId: AGENT,
          title: "Eliza",
          createdAt: CREATED.toISOString(),
          updatedAt: CREATED.toISOString(),
        },
      ],
    });
  });

  test("GET does NOT 500 when the resolver returns a well-typed Date created_at", async () => {
    // The defect (CONVERSATIONS-500-2026-07-22) was a string created_at from the
    // scope cache -> `.toISOString()` threw. With resolveSharedAgent normalizing
    // dates, the route reads a Date and never 500s.
    const res = await listConversations(APP_ORIGIN);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as {
      conversations: Array<{ createdAt: string }>;
    };
    // createdAt is a serialized ISO string in the response body.
    expect(body.conversations[0].createdAt).toBe(CREATED.toISOString());
  });

  test("GET surfaces the resolver's error status (e.g. 404) instead of masking it", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Agent not found",
      status: 404,
    });
    const res = await listConversations(APP_ORIGIN);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Agent not found",
    });
  });
});

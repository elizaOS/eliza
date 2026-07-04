// Exercises cloud API tests shared agent conversation route.test behavior with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

const conversationRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/route"
  )
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const CREATED = new Date("2026-06-18T00:00:00.000Z");
const APP_ORIGIN = "https://localhost";

function patchConversation(
  body: unknown,
  origin?: string,
): Response | Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return conversationRoute.request("/", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

function deleteConversation(origin?: string): Response | Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
  };
  if (origin) headers.Origin = origin;
  return conversationRoute.request("/", { method: "DELETE", headers });
}

describe("shared agent conversation route", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: { agent_name: "Eliza", created_at: CREATED },
      agentId: AGENT,
      orgId: "org-1",
      agentName: "Eliza",
    });
  });

  test("PATCH accepts title updates and reflects app-origin CORS", async () => {
    const res = await patchConversation(
      { title: "Launch checklist" },
      APP_ORIGIN,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(res.json()).resolves.toEqual({
      conversation: {
        id: AGENT,
        roomId: AGENT,
        title: "Launch checklist",
        createdAt: CREATED.toISOString(),
        updatedAt: CREATED.toISOString(),
      },
    });
  });

  test("PATCH accepts generate-only updates as a compatibility no-op", async () => {
    const res = await patchConversation({ generate: true }, APP_ORIGIN);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      conversation: { id: AGENT, title: "Eliza" },
    });
  });

  test("DELETE is accepted as a compatibility no-op", async () => {
    const res = await deleteConversation(APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  test("OPTIONS preflight allows PATCH for app-origin callers", async () => {
    const res = await conversationRoute.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: APP_ORIGIN,
        "Access-Control-Request-Method": "PATCH",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});

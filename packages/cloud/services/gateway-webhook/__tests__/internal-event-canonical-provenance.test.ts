/** Exercises authenticated internal-event ingress for canonical notifier provenance. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleInternalEvent } from "../src/internal-event-handler";
import type { RoutingRedis } from "../src/server-router";

const ORIGINAL_SECRET = process.env.GATEWAY_INTERNAL_SECRET;
const ORIGINAL_SHARED_SECRET = process.env.AGENT_SERVER_SHARED_SECRET;
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.GATEWAY_INTERNAL_SECRET;
  } else {
    process.env.GATEWAY_INTERNAL_SECRET = ORIGINAL_SECRET;
  }
  if (ORIGINAL_SHARED_SECRET === undefined) {
    delete process.env.AGENT_SERVER_SHARED_SECRET;
  } else {
    process.env.AGENT_SERVER_SHARED_SECRET = ORIGINAL_SHARED_SECRET;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restore();
});

function makeRedis(): RoutingRedis {
  return {
    get: mock(async (key: string) => {
      if (key === "agent:agent-1:server") return "server-1";
      if (key === "server:server-1:url") return "http://agent-server.local";
      return null;
    }),
    set: mock(async () => undefined),
    lpush: mock(async () => 1),
    ltrim: mock(async () => "OK"),
    expire: mock(async () => 1),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("internal event canonical provenance ingress", () => {
  test("forwards a strict notification provenance envelope to agent-server", async () => {
    process.env.GATEWAY_INTERNAL_SECRET = "secret";
    process.env.AGENT_SERVER_SHARED_SECRET = "server-secret";
    const fetchMock = mock(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ handled: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const body = {
      agentId: "agent-1",
      userId: "owner@example.com",
      type: "notification",
      payload: {
        text: "Calendar reminder",
        canonicalProvenance: {
          source: "calendar",
          accountId: "google-account-1",
          platformRecordId: "calendar-event-123",
          chat: { id: "primary", type: "private" },
        },
      },
    };
    const response = await handleInternalEvent(
      new Request("http://gateway/internal/event", {
        method: "POST",
        headers: {
          "X-Internal-Secret": "secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { redis: makeRedis() },
    );

    expect(response.status).toBe(200);
    await waitFor(() => fetchMock.mock.calls.length > 0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent-server.local/agents/agent-1/event",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Server-Token": "server-secret",
        }),
        body: JSON.stringify({
          userId: "owner@example.com",
          type: "notification",
          payload: body.payload,
        }),
      }),
    );
  });

  test("rejects malformed canonical provenance before forwarding", async () => {
    process.env.GATEWAY_INTERNAL_SECRET = "secret";
    const fetchMock = mock(async () => {
      throw new Error("should not forward");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleInternalEvent(
      new Request("http://gateway/internal/event", {
        method: "POST",
        headers: {
          "X-Internal-Secret": "secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: "agent-1",
          userId: "owner@example.com",
          type: "notification",
          payload: {
            text: "bad",
            canonicalProvenance: {
              source: "calendar",
              accountId: "google-account-1",
              chat: { id: "primary", type: "private" },
            },
          },
        }),
      }),
      { redis: makeRedis() },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

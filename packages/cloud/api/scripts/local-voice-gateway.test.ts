/**
 * Tests local voice gateway startup identity validation against deterministic
 * loopback API responses without starting the realtime voice server.
 */
import { describe, expect, mock, test } from "bun:test";
import { readLocalIdentity } from "./local-voice-gateway";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSATION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function gatewayFetch(options?: {
  agents?: ReadonlyArray<{ id: string; status: string }>;
  conversations?: ReadonlyArray<{ id: string; updatedAt: string }>;
}) {
  return mock(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/health") {
      return response({ ready: true, canRespond: true });
    }
    if (pathname === "/api/agents") {
      return response({
        agents: options?.agents ?? [{ id: AGENT_A, status: "running" }],
      });
    }
    if (pathname === "/api/conversations") {
      return response({
        conversations: options?.conversations ?? [
          { id: CONVERSATION_A, updatedAt: "2026-08-19T10:00:00Z" },
        ],
      });
    }
    return response({ error: "not found" }, 404);
  });
}

describe("readLocalIdentity", () => {
  test("validates matching configured ids against the live runtime", async () => {
    const fetchImpl = gatewayFetch();

    await expect(
      readLocalIdentity("http://127.0.0.1:31337", {
        fetchImpl,
        environment: {
          ELIZA_LOCAL_VOICE_AGENT_ID: AGENT_A,
          ELIZA_LOCAL_VOICE_CONVERSATION_ID: CONVERSATION_A,
        },
      }),
    ).resolves.toEqual({
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("canonicalizes uppercase configured UUIDs before live matching", async () => {
    await expect(
      readLocalIdentity("http://127.0.0.1:31337", {
        fetchImpl: gatewayFetch(),
        environment: {
          ELIZA_LOCAL_VOICE_AGENT_ID: AGENT_A.toUpperCase(),
          ELIZA_LOCAL_VOICE_CONVERSATION_ID: CONVERSATION_A.toUpperCase(),
        },
      }),
    ).resolves.toEqual({
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
    });
  });

  test("accepts the canonical IPv6 loopback origin", async () => {
    await expect(
      readLocalIdentity("http://[::1]:31337", {
        fetchImpl: gatewayFetch(),
        environment: {},
      }),
    ).resolves.toEqual({
      agentId: AGENT_A,
      conversationId: CONVERSATION_A,
    });
  });

  test.each([
    "not a URL",
    "https://api.example.com",
    "http://192.168.1.10:31337",
    "file:///tmp/eliza.sock",
    "http://user:secret@localhost:31337",
    "http://localhost:31337/api",
    "http://localhost:31337/?agent=one",
    "http://localhost:31337/#runtime",
  ])("rejects unsafe origin %s before any fetch", async (runtimeOrigin) => {
    const fetchImpl = gatewayFetch();

    await expect(
      readLocalIdentity(runtimeOrigin, { fetchImpl, environment: {} }),
    ).rejects.toThrow(/not a valid URL|bare HTTP loopback origin/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "wrong agent",
      configuredAgentId: AGENT_B,
      agents: [{ id: AGENT_A, status: "running" }],
    },
    {
      name: "stopped agent",
      configuredAgentId: AGENT_A,
      agents: [{ id: AGENT_A, status: "stopped" }],
    },
  ])(
    "rejects a configured $name before advertising readiness",
    async (testCase) => {
      await expect(
        readLocalIdentity("http://127.0.0.1:31337", {
          fetchImpl: gatewayFetch({ agents: testCase.agents }),
          environment: {
            ELIZA_LOCAL_VOICE_AGENT_ID: testCase.configuredAgentId,
            ELIZA_LOCAL_VOICE_CONVERSATION_ID: CONVERSATION_A,
          },
        }),
      ).rejects.toThrow("does not match a running agent");
    },
  );

  test("rejects a configured conversation that the runtime cannot serve", async () => {
    await expect(
      readLocalIdentity("http://127.0.0.1:31337", {
        fetchImpl: gatewayFetch(),
        environment: {
          ELIZA_LOCAL_VOICE_AGENT_ID: AGENT_A,
          ELIZA_LOCAL_VOICE_CONVERSATION_ID: CONVERSATION_B,
        },
      }),
    ).rejects.toThrow("does not match a live conversation");
  });

  test("discovers the running agent and newest live conversation without overrides", async () => {
    const fetchImpl = gatewayFetch({
      agents: [
        { id: AGENT_B, status: "stopped" },
        { id: AGENT_A, status: "running" },
      ],
      conversations: [
        { id: CONVERSATION_A, updatedAt: "2026-08-19T10:00:00Z" },
        { id: CONVERSATION_B, updatedAt: "2026-08-19T11:00:00Z" },
      ],
    });

    await expect(
      readLocalIdentity("http://127.0.0.1:31337", {
        fetchImpl,
        environment: {},
      }),
    ).resolves.toEqual({
      agentId: AGENT_A,
      conversationId: CONVERSATION_B,
    });
  });
});

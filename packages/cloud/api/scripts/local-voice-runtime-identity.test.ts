/**
 * Deterministic boundary tests for local voice runtime identity resolution.
 * Injected fetch responses exercise the production resolver without starting
 * Cartesia or a realtime gateway server.
 */

import { describe, expect, test } from "bun:test";
import {
  LocalVoiceRuntimeIdentityError,
  resolveLocalVoiceRuntimeIdentity,
} from "./local-voice-runtime-identity";

const AGENT_ID = "a1111111-a111-4111-8111-a11111111111";
const OTHER_AGENT_ID = "b2222222-b222-4222-8222-b22222222222";
const CONVERSATION_ID = "c3333333-c333-4333-8333-c33333333333";
const NEWER_CONVERSATION_ID = "d4444444-d444-4444-8444-d44444444444";

interface RuntimeFixtureOptions {
  agents?: readonly unknown[];
  conversations?: readonly unknown[];
  health?: unknown;
}

function runtimeFetch(options: RuntimeFixtureOptions = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.pathname === "/api/health") {
      return Response.json(options.health ?? { ready: true, canRespond: true });
    }
    if (url.pathname === "/api/agents") {
      return Response.json({
        agents: options.agents ?? [{ id: AGENT_ID, status: "running" }],
      });
    }
    if (url.pathname === "/api/conversations") {
      return Response.json({
        conversations: options.conversations ?? [
          {
            id: CONVERSATION_ID,
            updatedAt: "2026-08-19T20:00:00.000Z",
          },
        ],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("local voice runtime identity", () => {
  test("binds configured canonical IDs to live running runtime records", async () => {
    const { fetchImpl, calls } = runtimeFetch({
      conversations: [
        {
          id: CONVERSATION_ID,
          updatedAt: "2026-08-19T20:00:00.000Z",
          agentId: AGENT_ID,
        },
      ],
    });

    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        configuredAgentId: AGENT_ID,
        configuredConversationId: CONVERSATION_ID,
        fetchImpl,
      }),
    ).resolves.toEqual({
      runtimeOrigin: "http://127.0.0.1:31337",
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(calls).toEqual([
      "http://127.0.0.1:31337/api/health",
      "http://127.0.0.1:31337/api/agents",
      "http://127.0.0.1:31337/api/conversations",
    ]);
  });

  test("discovers the newest conversation belonging to the singleton running agent", async () => {
    const { fetchImpl } = runtimeFetch({
      conversations: [
        {
          id: NEWER_CONVERSATION_ID,
          updatedAt: "2026-08-19T22:00:00.000Z",
          agentId: OTHER_AGENT_ID,
        },
        {
          id: CONVERSATION_ID,
          updatedAt: "2026-08-19T20:00:00.000Z",
          agentId: AGENT_ID,
        },
      ],
    });

    const identity = await resolveLocalVoiceRuntimeIdentity({
      runtimeOrigin: "http://localhost:31337/",
      fetchImpl,
    });
    expect(identity.agentId).toBe(AGENT_ID);
    expect(identity.conversationId).toBe(CONVERSATION_ID);
  });

  test.each([
    "https://127.0.0.1:31337",
    "http://127.0.0.1.evil:31337",
    "http://127.0.0.1:31337/path",
    "http://user@127.0.0.1:31337",
    " http://127.0.0.1:31337",
  ])(
    "rejects a noncanonical or hostile origin before fetching: %s",
    async (runtimeOrigin) => {
      const { fetchImpl, calls } = runtimeFetch();
      await expect(
        resolveLocalVoiceRuntimeIdentity({ runtimeOrigin, fetchImpl }),
      ).rejects.toBeInstanceOf(LocalVoiceRuntimeIdentityError);
      expect(calls).toEqual([]);
    },
  );

  test.each([
    { configuredAgentId: AGENT_ID.toUpperCase() },
    { configuredAgentId: ` ${AGENT_ID}` },
    { configuredConversationId: CONVERSATION_ID.toUpperCase() },
  ])(
    "rejects noncanonical configured identity before fetching",
    async (configured) => {
      const { fetchImpl, calls } = runtimeFetch();
      await expect(
        resolveLocalVoiceRuntimeIdentity({
          runtimeOrigin: "http://127.0.0.1:31337",
          ...configured,
          fetchImpl,
        }),
      ).rejects.toBeInstanceOf(LocalVoiceRuntimeIdentityError);
      expect(calls).toEqual([]);
    },
  );

  test.each([
    {
      name: "missing agent",
      configuredAgentId: OTHER_AGENT_ID,
      agents: [{ id: AGENT_ID, status: "running" }],
      conversations: undefined,
      configuredConversationId: undefined,
    },
    {
      name: "stopped agent",
      configuredAgentId: AGENT_ID,
      agents: [{ id: AGENT_ID, status: "stopped" }],
      conversations: undefined,
      configuredConversationId: undefined,
    },
    {
      name: "ambiguous multi-agent runtime",
      configuredAgentId: AGENT_ID,
      agents: [
        { id: AGENT_ID, status: "running" },
        { id: OTHER_AGENT_ID, status: "stopped" },
      ],
      conversations: undefined,
      configuredConversationId: undefined,
    },
    {
      name: "missing conversation",
      configuredAgentId: AGENT_ID,
      agents: [{ id: AGENT_ID, status: "running" }],
      conversations: [],
      configuredConversationId: CONVERSATION_ID,
    },
    {
      name: "conversation owned by another agent",
      configuredAgentId: AGENT_ID,
      agents: [{ id: AGENT_ID, status: "running" }],
      conversations: [
        {
          id: CONVERSATION_ID,
          updatedAt: "2026-08-19T20:00:00.000Z",
          agentId: OTHER_AGENT_ID,
        },
      ],
      configuredConversationId: CONVERSATION_ID,
    },
    {
      name: "conversation with an invalid timestamp",
      configuredAgentId: AGENT_ID,
      agents: [{ id: AGENT_ID, status: "running" }],
      conversations: [
        {
          id: CONVERSATION_ID,
          updatedAt: "not-a-timestamp",
          agentId: AGENT_ID,
        },
      ],
      configuredConversationId: CONVERSATION_ID,
    },
  ])("fails closed for $name", async (fixture) => {
    const { fetchImpl } = runtimeFetch({
      agents: fixture.agents,
      conversations: fixture.conversations,
    });
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        configuredAgentId: fixture.configuredAgentId,
        configuredConversationId: fixture.configuredConversationId,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LocalVoiceRuntimeIdentityError);
  });

  test("rejects noncanonical live identity responses", async () => {
    const { fetchImpl } = runtimeFetch({
      agents: [{ id: AGENT_ID.toUpperCase(), status: "running" }],
    });
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        fetchImpl,
      }),
    ).rejects.toThrow("canonical lowercase UUID");
  });
});

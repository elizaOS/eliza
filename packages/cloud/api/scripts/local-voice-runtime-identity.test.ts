/**
 * Deterministic and integration-backed boundary tests for local voice runtime
 * identity resolution. Injected responses cover malformed runtime state while
 * real loopback servers prove redirects cannot escape the validated origin.
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
  redirects: Array<RequestRedirect | undefined>;
} {
  const calls: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.href);
    redirects.push(init?.redirect);
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
  return { fetchImpl, calls, redirects };
}

describe("local voice runtime identity", () => {
  test("binds configured canonical IDs to live running runtime records", async () => {
    const { fetchImpl, calls, redirects } = runtimeFetch({
      conversations: [
        {
          id: CONVERSATION_ID,
          updatedAt: "2026-08-19T20:00:00.000Z",
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
    expect(redirects).toEqual(["error", "error", "error"]);
  });

  test("discovers the newest conversation under the singleton running agent", async () => {
    const { fetchImpl } = runtimeFetch({
      conversations: [
        {
          id: NEWER_CONVERSATION_ID,
          updatedAt: "2026-08-19T22:00:00.000Z",
          // The production ConversationMeta DTO has no agentId. Unknown fields
          // cannot override the singleton /api/agents authority.
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
    expect(identity.conversationId).toBe(NEWER_CONVERSATION_ID);
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

  test.each([
    "2026-08-19T20:00:00Z",
    "2026-08-19T13:00:00.000-07:00",
    "Wed, 19 Aug 2026 20:00:00 GMT",
  ])("rejects a noncanonical live timestamp: %s", async (updatedAt) => {
    const { fetchImpl } = runtimeFetch({
      conversations: [{ id: CONVERSATION_ID, updatedAt }],
    });
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        fetchImpl,
      }),
    ).rejects.toThrow("canonical ISO timestamp");
  });

  test("rejects an oversized runtime response while reading its stream", async () => {
    const fetchImpl = (async () =>
      new Response(
        `{"padding":"${"x".repeat(1024 * 1024)}"}`,
      )) as unknown as typeof fetch;
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        fetchImpl,
      }),
    ).rejects.toThrow("response size limit");
  });

  test("rejects runtime record sets above their bounded ceilings", async () => {
    const tooManyAgents = runtimeFetch({
      agents: [
        { id: AGENT_ID, status: "running" },
        { id: OTHER_AGENT_ID, status: "running" },
      ],
    });
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        fetchImpl: tooManyAgents.fetchImpl,
      }),
      // Two agents is not a "record limit" condition — selectAgentId owns the
      // exactly-one rule and says so in words an operator can act on.
    ).rejects.toThrow("local runtime must expose exactly one agent");

    const tooManyConversations = runtimeFetch({
      conversations: Array.from({ length: 2001 }, (_, index) => ({
        id: `${index.toString(16).padStart(8, "0")}-c333-4333-8333-c33333333333`,
        updatedAt: "2026-08-19T20:00:00.000Z",
      })),
    });
    await expect(
      resolveLocalVoiceRuntimeIdentity({
        runtimeOrigin: "http://127.0.0.1:31337",
        fetchImpl: tooManyConversations.fetchImpl,
      }),
    ).rejects.toThrow("conversations response exceeds the record limit");
  });

  test("refuses a loopback redirect without contacting its target", async () => {
    let targetRequests = 0;
    const target = Bun.serve({
      port: 0,
      fetch: () => {
        targetRequests += 1;
        return Response.json({ ready: true, canRespond: true });
      },
    });
    const source = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${target.port}/captured` },
        }),
    });
    try {
      await expect(
        resolveLocalVoiceRuntimeIdentity({
          runtimeOrigin: `http://127.0.0.1:${source.port}`,
        }),
      ).rejects.toBeInstanceOf(LocalVoiceRuntimeIdentityError);
      expect(targetRequests).toBe(0);
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
});

// restoreConversationsFromDb derives a conversation id by stripping the
// "web-conv-" prefix off a channel id, and the create path accepts one from a
// client payload — so a non-UUID id is ordinary, not corruption. Rejecting the
// whole listing over one such record refused startup on healthy hosts.
test("selects a conversation whose id is not a UUID", async () => {
  const runtime = runtimeFetch({
    conversations: [
      {
        id: "web-conv-legacy-channel",
        updatedAt: "2026-08-19T20:00:00.000Z",
      },
    ],
  });

  const identity = await resolveLocalVoiceRuntimeIdentity({
    runtimeOrigin: "http://127.0.0.1:31337",
    fetchImpl: runtime.fetchImpl,
  });

  expect(identity.conversationId).toBe("web-conv-legacy-channel");
});

test("skips an unreadable conversation record instead of refusing startup", async () => {
  const runtime = runtimeFetch({
    conversations: [
      "not-an-object",
      { id: "usable-conversation", updatedAt: "2026-08-19T20:00:00.000Z" },
    ],
  });

  const identity = await resolveLocalVoiceRuntimeIdentity({
    runtimeOrigin: "http://127.0.0.1:31337",
    fetchImpl: runtime.fetchImpl,
  });

  expect(identity.conversationId).toBe("usable-conversation");
});

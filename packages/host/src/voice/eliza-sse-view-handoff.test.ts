import { expect, test } from "vitest";
import { listenLoopbackHttp } from "../../../app/test/fixtures/loopback-server.ts";
import { streamElizaConversation } from "./eliza-sse-bridge";
import { createLocalRuntimeConversationFetch } from "./local-runtime-conversation-fetch";

const handoffId = "11111111-1111-4111-8111-111111111111";
function action(
  actionName: string,
  viewId = "chat",
  extra: Record<string, unknown> = {},
) {
  return {
    actionName,
    success: true,
    values: {
      mode: "show",
      viewId,
      completedActionDelivered: false,
      ...extra,
    },
  };
}
async function bridge(actionResults: unknown[]) {
  let calls = 0;
  const chunks: string[] = [];
  const result = await streamElizaConversation(
    {
      endpoint: "https://fixture.invalid",
      authorization: "fixture-only",
      model: "unused",
      transcript: "go home",
      agentId: "agent",
      conversationId: "conversation",
      traceId: "a".repeat(32),
      signal: new AbortController().signal,
      fetchImpl: Object.assign(
        async () => {
          calls++;
          return new Response(
            "event: done\ndata: " +
              JSON.stringify({
                type: "done",
                text: "Opening Home.",
                actionResults,
              }) +
              "\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect() {} },
      ),
    },
    (text) => chunks.push(text),
  );
  expect(calls).toBe(1);
  expect(chunks.join("")).toBe("Opening Home.");
  expect(result.completed).toBe(true);
  return result.viewHandoff;
}
test("actual terminal SSE accepts registered VIEWS_SHOW equivalently to VIEWS show for Home/Notes", async () => {
  for (const view of ["chat", "notes"])
    expect(await bridge([action("VIEWS_SHOW", view)])).toEqual(
      await bridge([action("VIEWS", view)]),
    );
  expect(await bridge([action("VIEWS_SHOW")])).toEqual({ viewId: "chat" });
});
test("unrelated children and unsupported registered child modes never become navigation", async () => {
  for (const name of [
    "VIEWS_LIST",
    "VIEWS_HIDE",
    "VIEWS_SHOW_OTHER",
    "APP_LAUNCH",
    "EVIL_VIEWS_SHOW",
  ])
    expect(await bridge([action(name)])).toBeUndefined();
  expect(
    await bridge([action("VIEWS_SHOW", "notes", { mode: "open" })]),
  ).toBeUndefined();
  expect(
    await bridge([{ ...action("VIEWS_SHOW"), success: false }]),
  ).toBeUndefined();
});
test("multiple parent/child successful navigations remain ambiguous regardless order or target", async () => {
  for (const actions of [
    [action("VIEWS"), action("VIEWS_SHOW")],
    [action("VIEWS_SHOW"), action("VIEWS")],
    [action("VIEWS_SHOW"), action("VIEWS_SHOW", "notes")],
  ])
    expect(await bridge(actions)).toBeUndefined();
});
test("valid delivered targeted transport suppresses child terminal duplicate exactly like parent", async () => {
  for (const name of ["VIEWS", "VIEWS_SHOW"])
    expect(
      await bridge([
        action(name, "chat", {
          completedActionDelivered: true,
          completedActionHandoffId: handoffId,
        }),
      ]),
    ).toBeUndefined();
  expect(
    await bridge([
      action("VIEWS_SHOW", "chat", {
        completedActionDelivered: false,
        completedActionHandoffId: handoffId,
      }),
    ]),
  ).toEqual({ viewId: "chat" });
  expect(
    await bridge([
      action("VIEWS", "notes", {
        completedActionDelivered: true,
        completedActionHandoffId: handoffId,
      }),
      action("VIEWS_SHOW", "chat"),
    ]),
  ).toBeUndefined();
});

const binding = {
  requestId: handoffId,
  clientId: "22222222-2222-4222-8222-222222222222",
  installationId: "33333333-3333-4333-8333-333333333333",
  viewId: "chat",
  viewType: "gui",
} as const;
test("terminal SSE preserves a canonical prepared navigation binding instead of visual-only destination", async () => {
  const values = {
    navigationPrepared: true,
    completedActionHandoffId: handoffId,
    navigationBinding: binding,
  } as const;
  expect(await bridge([action("VIEWS_SHOW", "chat", values)])).toEqual({
    viewId: "chat",
    ...values,
  });
  for (const extra of [
    { navigationPrepared: true },
    {
      ...values,
      navigationBinding: {
        ...binding,
        requestId: "44444444-4444-4444-8444-444444444444",
      },
    },
    { ...values, navigationBinding: { ...binding, viewId: "notes" } },
    { ...values, navigationBinding: { ...binding, installationId: "" } },
  ])
    expect(await bridge([action("VIEWS_SHOW", "chat", extra)])).toBeUndefined();
});

test("only a valid canonical terminal receipt supplies the user message correlation", async () => {
  for (const userMessageId of [
    undefined,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa",
    "not-an-id",
  ]) {
    const call = streamElizaConversation(
      {
        endpoint: "https://fixture.invalid",
        authorization: "fixture-only",
        model: "unused",
        transcript: "open notes",
        agentId: "agent",
        conversationId: "conversation",
        traceId: "a".repeat(32),
        signal: new AbortController().signal,
        fetchImpl: Object.assign(
          async () =>
            new Response(
              `data: ${JSON.stringify({ type: "done", text: "Done", ...(userMessageId === undefined ? {} : { userMessageId }) })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          { preconnect() {} },
        ),
      },
      () => {},
    );
    if (userMessageId === "not-an-id")
      await expect(call).rejects.toThrow(
        "Invalid terminal user message correlation",
      );
    else expect((await call).userMessageId).toBe(userMessageId);
  }
});

test("bounded voice policy survives the actual SSE bridge and loopback adapter", async () => {
  const received: { headers: Headers; body: Record<string, unknown> }[] = [];
  const server = await listenLoopbackHttp(async (request) => {
    received.push({
      headers: request.headers,
      body: (await request.json()) as Record<string, unknown>,
    });
    return new Response(
      'event: done\ndata: {"type":"done","text":"Ready."}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const adapter = createLocalRuntimeConversationFetch(server.url.origin, {
    agentId: "agent",
    conversationId: "conversation",
  });
  const base = {
    endpoint: "https://fixture.invalid",
    authorization: "server-only",
    model: "unused",
    transcript: "Complete original transcript",
    agentId: "agent",
    conversationId: "conversation",
    traceId: "a".repeat(32),
    signal: new AbortController().signal,
    fetchImpl: adapter,
  };
  try {
    await streamElizaConversation(
      {
        ...base,
        modelAttemptPolicy: {
          policyId: "reviewed-policy",
          sessionId: "original-session",
        },
      },
      () => {},
    );
    expect(received).toHaveLength(1);
    expect(received[0].headers.get("X-Eliza-Voice-Model-Policy")).toBe(
      "reviewed-policy",
    );
    expect(received[0].headers.get("X-Eliza-Voice-Session-Id")).toBe(
      "original-session",
    );
    expect(received[0].headers.get("authorization")).toBeNull();
    expect(received[0].body.text).toBe(base.transcript);
    expect(JSON.stringify(received[0].body)).not.toContain("reviewed-policy");
    await expect(
      streamElizaConversation(
        {
          ...base,
          modelAttemptPolicy: {
            policyId: "forged,duplicate",
            sessionId: "original-session",
          },
        },
        () => {},
      ),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
    await expect(
      adapter(
        "https://fixture.invalid/api/v1/eliza/agents/agent/api/conversations/conversation/messages/stream",
        {
          method: "POST",
          headers: { "X-Eliza-Voice-Model-Policy": "policy" },
          body: JSON.stringify(received[0].body),
        },
      ),
    ).rejects.toThrow("Invalid bounded");
    expect(received).toHaveLength(1);
    await streamElizaConversation(base, () => {});
    expect(received).toHaveLength(2);
    expect(received[1].headers.get("X-Eliza-Voice-Model-Policy")).toBeNull();
  } finally {
    await server.close();
  }
});

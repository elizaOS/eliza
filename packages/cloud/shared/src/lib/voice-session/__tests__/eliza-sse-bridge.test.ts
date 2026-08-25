/**
 * Eliza SSE bridge: real OpenAI-shaped SSE decode + trace header + abort.
 * The fetch is scripted; the decoding path under test is real.
 */

import { describe, expect, test } from "bun:test";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";

import {
  type ElizaServerTimingReceipt,
  parseElizaServerTiming,
  streamElizaConversation,
  VOICE_TRACE_HEADER,
} from "../eliza-sse-bridge";

function sseResponse(
  lines: string[],
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

async function streamTerminalActionResult(actionResult: Record<string, unknown>) {
  return streamTerminalActionResults([actionResult]);
}

async function streamTerminalActionResults(actionResults: Record<string, unknown>[]) {
  const fetchImpl = (async () =>
    sseResponse([
      `event: done\ndata: ${JSON.stringify({ actionResults })}\n\n`,
    ])) as unknown as typeof fetch;
  return streamElizaConversation(
    {
      endpoint: "http://x",
      authorization: "Bearer s",
      model: "m",
      transcript: "launch demo",
      agentId: "agent-1",
      conversationId: "conv-1",
      traceId: "trace-app-navigation",
      signal: new AbortController().signal,
      fetchImpl,
    },
    () => {},
  );
}

describe("eliza sse bridge", () => {
  test("decodes delta.content tokens and completes on [DONE]", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "gemma-4-31b",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-1",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.completed).toBe(true);
    expect(result.aborted).toBe(false);
  });

  test("reports canonical route timing as soon as response headers arrive", async () => {
    const observed: Array<{
      status: number;
      elapsedMs: number;
      serverTiming: ElizaServerTimingReceipt | null;
    }> = [];
    const fetchImpl = (async () =>
      sseResponse(["data: [DONE]\n\n"], 200, {
        "Server-Timing": "turn_hydrate;dur=12.3, turn_admission;dur=4.5",
      })) as unknown as typeof fetch;

    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-timing",
        signal: new AbortController().signal,
        fetchImpl,
        onResponseHeaders: (headers) => observed.push(headers),
      },
      () => undefined,
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ status: 200 });
    expect(observed[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(observed[0]?.serverTiming).toEqual({
      metrics: { turn_hydrate: 12.3, turn_admission: 4.5 },
    });
  });

  test("bounds and allowlists Server-Timing without retaining descriptions", () => {
    expect(
      parseElizaServerTiming(
        'turn_claim;dur=4.4;desc="tenant-secret", provider;desc="cerebras", injected;dur=1;desc="raw", turn_hydrate;dur=700001, turn_admission;dur=-2',
      ),
    ).toEqual({ metrics: { turn_claim: 4.4 }, provider: "cerebras" });
    expect(parseElizaServerTiming(`turn_claim;dur=1,${"x".repeat(2_100)}`)).toBeNull();
    expect(parseElizaServerTiming('provider;desc="attacker-controlled"')).toBeNull();
  });

  test("rejects non-canonical Server-Timing duration representations", () => {
    for (const duration of ["0x10", "1e3", "+1", "01", ".5", "1.", "1.25"]) {
      expect(parseElizaServerTiming(`turn_claim;dur=${duration}`)).toBeNull();
    }
    expect(parseElizaServerTiming("turn_claim;dur=0")).toEqual({
      metrics: { turn_claim: 0 },
    });
    expect(parseElizaServerTiming("turn_claim;dur=600000.0")).toEqual({
      metrics: { turn_claim: 600000 },
    });
  });

  test("decodes local runtime token frames without replaying fullText", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "status", kind: "thinking" })}\n\n`,
        `data: ${JSON.stringify({ type: "token", text: "Hello", fullText: "Hello" })}\n\n`,
        `data: ${JSON.stringify({ type: "token", text: " local", fullText: "Hello local" })}\n\n`,
        `data: ${JSON.stringify({ type: "done", fullText: "Hello local" })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-local",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Hello", " local"]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("buffers provisional chunks and snapshots before an authoritative replacement", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "token",
          text: "Changed ",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          text: "to warm.",
          fullText: "Changed to warm.",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Okay, I changed my personality to warm.",
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Okay, I changed my personality to warm.",
          actionResults: [
            {
              actionName: "UPDATE_CHARACTER",
              success: true,
            },
          ],
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "make your personality warmer",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-action-replacement",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Okay, I changed my personality to warm."]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("speaks a provisional turnComplete acknowledgement once at terminal confirmation", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Opened Notes.",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Opened Notes.",
          actionResults: [
            {
              actionName: "VIEWS",
              success: true,
              values: { mode: "show", viewId: "notes", viewPath: "/notes" },
            },
          ],
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "open notes",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-terminal-ack",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Opened Notes."]);
    expect(result).toEqual({
      completed: true,
      aborted: false,
      viewHandoff: { viewId: "notes", viewPath: "/notes" },
    });
  });

  test("emits every ordinary model delta after an authoritative replacement", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Changed to warm.",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Okay, I changed",
        })}\n\n`,
        `data: ${JSON.stringify({ type: "token", text: " my personality to warm." })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Okay, I changed my personality to warm.",
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "make your personality warmer",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-model-after-ack",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Okay, I changed", " my personality to warm."]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("a non-provisional delta confirms the accumulated provisional prefix", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Sure,",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({ type: "token", text: " here it is." })}\n\n`,
        `data: ${JSON.stringify({ type: "done", fullText: "Sure, here it is." })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "show it",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-confirmed-prefix",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Sure, here it is."]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("terminal confirmation speaks only the provisional action suffix after a model prefix", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "token", text: "Here are your notes:" })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          text: "\n• Call",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          text: " Shaw",
          fullText: "Here are your notes:\n• Call Shaw",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Here are your notes:\n• Call Shaw",
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "show my notes",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-prefix-action-suffix",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Here are your notes:", "\n• Call Shaw"]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("holds a divergent provisional replacement until terminal authorization", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;
    let resolvePrefix: () => void = () => {};
    const prefixObserved = new Promise<void>((resolve) => {
      resolvePrefix = resolve;
    });
    const stream = streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "open notes",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-deferred-divergence",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => {
        deltas.push(delta);
        resolvePrefix();
      },
    );
    let settled = false;
    const outcome = stream.then(
      (value) => {
        settled = true;
        return { kind: "resolved" as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { kind: "rejected" as const, error };
      },
    );

    controller?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "token", text: "Opened Notes." })}\n\n` +
          `data: ${JSON.stringify({
            type: "token",
            fullText: "Created a note instead.",
            provisional: true,
          })}\n\n`,
      ),
    );
    await prefixObserved;
    expect(settled).toBe(false);
    expect(deltas).toEqual(["Opened Notes."]);

    controller?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Created a note instead.",
        })}\n\n`,
      ),
    );
    controller?.close();
    const terminalOutcome = await outcome;
    expect(terminalOutcome.kind).toBe("rejected");
    if (terminalOutcome.kind === "rejected") {
      expect(terminalOutcome.error).toMatchObject({ code: "protocol_error" });
    }
  });

  test("a non-provisional replacement and continuation supersede a pending callback", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "token", text: "I can help" })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          fullText: "I can help. Action complete.",
          provisional: true,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          fullText: "I can help with that",
        })}\n\n`,
        `data: ${JSON.stringify({ type: "token", text: " now." })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "I can help with that now.",
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "help me",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-follow-on-replacement",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["I can help", " with that", " now."]);
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("accepts an explicit empty terminal only when no text became speakable", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "done", fullText: "" })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "stay silent",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-explicit-silence",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => deltas.push(delta),
    );

    expect(result).toEqual({ completed: true, aborted: false });
    expect(deltas).toEqual([]);
  });

  test("rejects an explicit empty terminal after ordinary text became speakable", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "token", text: "This must not survive." })}\n\n`,
        `data: ${JSON.stringify({ type: "done", fullText: "" })}\n\n`,
      ])) as unknown as typeof fetch;

    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "answer then retract",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "trace-invalid-empty-terminal",
          signal: new AbortController().signal,
          fetchImpl,
        },
        (delta) => deltas.push(delta),
      ),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(deltas).toEqual(["This must not survive."]);
  });

  test("fails truthfully when a snapshot rewrites text already sent to speech", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "token", text: "Opened Notes." })}\n\n`,
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Created a note instead.",
        })}\n\n`,
      ])) as unknown as typeof fetch;

    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "open workflows",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "trace-divergent-action",
          signal: new AbortController().signal,
          fetchImpl,
        },
        (delta) => deltas.push(delta),
      ),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(deltas).toEqual(["Opened Notes."]);
  });

  test("rejects an unterminated action snapshot instead of fabricating completion", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "token",
          fullText: "Changed to warm.",
          provisional: true,
        })}\n\n`,
      ])) as unknown as typeof fetch;

    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "make your personality warmer",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "trace-unterminated-action",
          signal: new AbortController().signal,
          fetchImpl,
        },
        (delta) => deltas.push(delta),
      ),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(deltas).toEqual([]);
  });

  test("propagates both voice and standard trace headers", async () => {
    let seenVoiceHeader: string | null = null;
    let seenStandardHeader: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seenVoiceHeader = headers.get(VOICE_TRACE_HEADER);
      seenStandardHeader = headers.get("X-Eliza-Trace-Id");
      return sseResponse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-XYZ",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );
    expect(seenVoiceHeader).toBe("trace-XYZ");
    expect(seenStandardHeader).toBe("trace-XYZ");
  });

  test("does not let a timing observer failure break a healthy stream", async () => {
    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-observer",
        signal: new AbortController().signal,
        fetchImpl: (async () => sseResponse(["data: [DONE]\n\n"])) as unknown as typeof fetch,
        onResponseHeaders: async () => {
          throw new Error("diagnostics unavailable");
        },
      },
      () => undefined,
    );
    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("uses the canonical persisted message route with minted agent + conversation identity", async () => {
    let seenUrl = "";
    let seenBody: { text?: string } | null = null;
    let seenHeaders: Headers | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      seenHeaders = new Headers(init.headers);
      return sseResponse([
        `event: chunk\ndata: ${JSON.stringify({ chunk: "persisted reply" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: "persisted reply" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;
    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-XYZ",
        conversationId: "conv-ABC",
        organizationId: "org-123",
        userId: "user-456",
        traceId: "t",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => expect(delta).toBe("persisted reply"),
    );
    expect(seenUrl).toBe(
      "http://x/api/v1/eliza/agents/agent-XYZ/api/conversations/conv-ABC/messages/stream",
    );
    expect(seenBody).toEqual({
      text: "hi",
      metadata: {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
      },
      streamProtocol: "delta-v2",
    });
    expect(seenHeaders?.get("Authorization")).toBe("Bearer s");
    expect(seenHeaders?.get("X-Service-Key")).toBe("Bearer s");
    expect(seenHeaders?.get("X-Eliza-Agent-Id")).toBe("agent-XYZ");
    expect(seenHeaders?.get("X-Eliza-Conversation-Id")).toBe("conv-ABC");
    expect(seenHeaders?.get("X-Eliza-Organization-Id")).toBe("org-123");
    expect(seenHeaders?.get("X-Eliza-User-Id")).toBe("user-456");
  });

  test("carries the server-attested lifecycle history cutoff in the internal body", async () => {
    let seenBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;

    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer server-held",
        model: "m",
        transcript: "generate a greeting",
        messageRole: "system",
        clientMessageId: "twilio-call:CA1:opening",
        historyCutoffAt: 1_725_000_000_000,
        transientInput: true,
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "cutoff-trace",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );

    expect(seenBody).toMatchObject({
      text: "generate a greeting",
      messageRole: "system",
      clientMessageId: "twilio-call:CA1:opening",
      historyCutoffAt: 1_725_000_000_000,
      transientInput: true,
    });
  });

  test("returns the originating-client VIEWS handoff from the local runtime done frame", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "token", text: "Opened Notes." })}\n\n`,
        `data: ${JSON.stringify({
          type: "done",
          fullText: "Opened Notes.",
          actionResults: [
            {
              actionName: "VIEWS",
              success: true,
              values: {
                mode: "show",
                viewId: "notes",
                viewPath: "/notes",
                subview: "recent",
              },
            },
          ],
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "open notes",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-navigation",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );

    expect(result).toEqual({
      completed: true,
      aborted: false,
      viewHandoff: {
        viewId: "notes",
        viewPath: "/notes",
        subview: "recent",
      },
    });
  });

  test("returns a successful APP launch handoff addressed to Browser", async () => {
    await expect(
      streamTerminalActionResult({
        actionName: "APP",
        success: true,
        values: {
          mode: "launch",
          viewId: "browser",
          viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
          subview: "preview",
        },
      }),
    ).resolves.toEqual({
      completed: true,
      aborted: false,
      viewHandoff: {
        viewId: "browser",
        viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
        subview: "preview",
      },
    });
  });

  test("rejects failed, wrong-mode, and non-Browser APP handoffs", async () => {
    const rejected = [
      {
        actionName: "APP",
        success: false,
        values: { mode: "launch", viewId: "browser", viewPath: "/browser" },
      },
      {
        actionName: "APP",
        success: true,
        values: { mode: "stop", viewId: "browser", viewPath: "/browser" },
      },
      {
        actionName: "APP",
        success: true,
        values: { mode: "launch", viewId: "wallet", viewPath: "/wallet" },
      },
    ];

    for (const actionResult of rejected) {
      await expect(streamTerminalActionResult(actionResult)).resolves.toEqual({
        completed: true,
        aborted: false,
      });
    }
  });

  test("rejects non-canonical APP Browser paths and malformed terminal shapes", async () => {
    const rejectedPaths = [
      "/browser",
      "/wallet?browse=https%3A%2F%2Fexample.com",
      "/browser?browse=javascript%3Aalert(1)",
      "/browser?browse=%2Fapi%2Fapps%2Flocal%2F..%2Fsecret",
      "/browser?browse=%2F%2Fevil.example",
      "/browser?browse=https%3A%2F%2Fuser%3Asecret%40example.com",
      "/browser?browse=https%3A%2F%2Fexample.com&browse=https%3A%2F%2Fevil.example",
      "/browser?browse=https%3A%2F%2Fexample.com%2F%250Ainject",
      `/${"a".repeat(257)}`,
    ];
    for (const viewPath of rejectedPaths) {
      await expect(
        streamTerminalActionResult({
          actionName: "APP",
          success: true,
          values: { mode: "launch", viewId: "browser", viewPath },
        }),
      ).resolves.toEqual({ completed: true, aborted: false });
    }

    await expect(
      streamTerminalActionResult({
        data: { actionName: "APP" },
        success: true,
        values: {
          mode: "launch",
          viewId: "browser",
          viewPath: "/browser?browse=https%3A%2F%2Fexample.com",
        },
      }),
    ).resolves.toEqual({ completed: true, aborted: false });
  });

  test("fails closed when a terminal frame contains multiple successful navigations", async () => {
    await expect(
      streamTerminalActionResults([
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Fone.example",
          },
        },
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=https%3A%2F%2Ftwo.example",
          },
        },
      ]),
    ).resolves.toEqual({ completed: true, aborted: false });
  });

  test("keeps the navigation handoff when non-navigation VIEWS modes share the frame", async () => {
    await expect(
      streamTerminalActionResults([
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "create", viewId: "chat" },
        },
        {
          actionName: "VIEWS",
          success: true,
          values: { mode: "show", viewId: "chat", viewPath: "/chat" },
        },
      ]),
    ).resolves.toEqual({
      completed: true,
      aborted: false,
      viewHandoff: { viewId: "chat", viewPath: "/chat" },
    });
  });

  test("does not promote failed or malformed terminal action results", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        `event: done\ndata: ${JSON.stringify({
          actionResults: [
            {
              actionName: "VIEWS",
              success: false,
              values: { mode: "show", viewId: "notes" },
            },
            {
              actionName: "DELETE_EVERYTHING",
              success: true,
              values: { mode: "show", viewId: "settings" },
            },
          ],
        })}\n\n`,
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "open notes",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-no-navigation",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );

    expect(result).toEqual({ completed: true, aborted: false });
  });

  test("surfaces canonical agent stream errors instead of completing an empty turn", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "error", message: "agent failed" })}\n\n`,
      ])) as unknown as typeof fetch;
    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "hi",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "t",
          signal: new AbortController().signal,
          fetchImpl,
        },
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("agent failed"),
    });
  });

  test("aborting a never-ending internal response cancels its body reader", async () => {
    const controller = new AbortController();
    let responseCancelReason: unknown;
    const fetchImpl = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
            ),
          );
        },
        cancel(reason) {
          responseCancelReason = reason;
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "t",
        signal: controller.signal,
        fetchImpl,
      },
      () => controller.abort("barge-in"),
    );
    expect(result.aborted).toBe(true);
    expect(responseCancelReason).toBe("barge-in");
  });

  test("throws an upstream error on a non-2xx response", async () => {
    const fetchImpl = (async () => sseResponse([], 500)) as unknown as typeof fetch;
    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "hi",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "t",
          signal: new AbortController().signal,
          fetchImpl,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "upstream_error", retryable: true });
  });

  test("preserves the canonical insufficient-credits code and retryability", async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          success: false,
          error: "Insufficient credits. Required: $0.0014, Available: $0.0000",
          code: "insufficient_credits",
          retryable: false,
        },
        { status: 402 },
      )) as unknown as typeof fetch;

    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "hi",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "t",
          signal: new AbortController().signal,
          fetchImpl,
        },
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "upstream_error",
      status: 402,
      upstreamCode: "insufficient_credits",
      retryable: false,
      message: expect.stringContaining("Insufficient credits"),
    });
  });
});

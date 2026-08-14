/**
 * Contract coverage for the loopback local-runtime adapter used by the real
 * voice-session harness, including runtime turn-abort propagation and its
 * same-room queue barrier; the downstream fetch is captured without a model.
 */

import { describe, expect, test } from "bun:test";
import {
  REALTIME_VOICE_CLIENT_TRANSPORT,
  REALTIME_VOICE_INGRESS_COMMITTED_V1,
  REALTIME_VOICE_INGRESS_HEADER,
} from "@elizaos/shared";
import { streamElizaConversation } from "../../../../../shared/src/lib/voice-session/eliza-sse-bridge";
import {
  createLocalRuntimeConversationFetch,
  LocalRuntimeConversationFetchError,
} from "../lib/local-runtime-conversation-fetch";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const COMMITTED_STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  [REALTIME_VOICE_INGRESS_HEADER]: REALTIME_VOICE_INGRESS_COMMITTED_V1,
};

function committedAbortStatus(
  clientMessageId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestAborted: true,
    requestObserved: true,
    requestArmed: false,
    requestArmRejected: false,
    requestIngressState: "committed",
    requestIngressFailure: null,
    requestSettled: true,
    clientMessageId,
    active: false,
    queuePending: 0,
    ...overrides,
  };
}

describe("local runtime conversation fetch", () => {
  test("rewrites the cloud route to canonical local SSE without cloud credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      if (new URL(String(input)).pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      return new Response('event: done\ndata: {"text":"ok"}\n\n', {
        status: 200,
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337/path?ignored=1",
      downstream,
    );

    const response = await bridge(
      `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: "Bearer cloud-secret",
          "X-Service-Key": "Bearer cloud-secret",
          "X-Eliza-Organization-Id": "org-a",
          "X-Eliza-User-Id": "user-a",
          "X-Eliza-Voice-Trace-Id": "trace-a",
        },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: "voice:trace-a",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
          streamProtocol: "delta-v2",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:31337/api/conversations");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.signal).not.toBe(signal);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
    expect(calls[1]?.url).toBe(
      `http://127.0.0.1:31337/api/conversations/${CONVERSATION_ID}/messages/stream`,
    );
    expect(calls[1]?.init?.signal).not.toBe(signal);
    expect(calls[1]?.init?.signal?.aborted).toBe(false);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      text: "hello locally",
      clientMessageId: "voice:trace-a",
      metadata: {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
      },
      streamProtocol: "delta-v2",
    });
    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Service-Key")).toBe(false);
    expect(headers.has("X-Eliza-Organization-Id")).toBe(false);
    expect(headers.has("X-Eliza-User-Id")).toBe(false);
    expect(headers.get("X-Eliza-Voice-Trace-Id")).toBe("trace-a");
    expect(headers.get("Accept")).toBe("text/event-stream");
    await response.body?.cancel();
  });

  test("preserves provisional delta-v2 authority through the loopback adapter", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (new URL(String(input)).pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        [
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
          })}\n\n`,
        ].join(""),
        { headers: COMMITTED_STREAM_HEADERS },
      );
    }) as typeof fetch;
    const deltas: string[] = [];

    const result = await streamElizaConversation(
      {
        endpoint: "https://cloud.example",
        authorization: "Bearer local-secret",
        model: "m",
        transcript: "make your personality warmer",
        agentId: "agent-a",
        conversationId: CONVERSATION_ID,
        traceId: "trace-provisional-loopback",
        signal: new AbortController().signal,
        fetchImpl: createLocalRuntimeConversationFetch(
          "http://127.0.0.1:31337",
          downstream,
        ),
      },
      (delta) => deltas.push(delta),
    );

    expect(result).toEqual({ completed: true, aborted: false });
    expect(deltas).toEqual(["Okay, I changed my personality to warm."]);
    expect(calls).toEqual([
      {
        url: `http://127.0.0.1:31337/api/conversations/${CONVERSATION_ID}/messages/stream`,
        body: {
          text: "make your personality warmer",
          clientMessageId: "voice:trace-provisional-loopback",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        },
      },
    ]);
  });

  test("waits exact prior-request settlement before admitting a replacement in the room", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let releaseAbort: ((response: Response) => void) | undefined;
    const abortResponse = new Promise<Response>((resolve) => {
      releaseAbort = resolve;
    });
    let signalAbortRequest: (() => void) | undefined;
    const abortRequested = new Promise<void>((resolve) => {
      signalAbortRequest = resolve;
    });
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        signalAbortRequest?.();
        return abortResponse;
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 250, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const request = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const firstController = new AbortController();
    const firstResponse = await request("turn-1", firstController.signal);
    firstController.abort(new DOMException("barge in", "AbortError"));
    await abortRequested;

    let replacementStarted = false;
    const replacementPromise = request(
      "turn-2",
      new AbortController().signal,
    ).then((response) => {
      replacementStarted = true;
      return response;
    });
    const firstCancel = firstResponse.body?.cancel(
      firstController.signal.reason,
    );
    await Promise.resolve();
    expect(replacementStarted).toBe(false);
    expect(
      calls.filter((call) =>
        new URL(call.url).pathname.endsWith("/messages/stream"),
      ),
    ).toHaveLength(1);

    releaseAbort?.(Response.json(committedAbortStatus("voice:turn-1")));
    await firstCancel;
    const replacement = await replacementPromise;
    expect(replacementStarted).toBe(true);
    const abortCall = calls.find(
      (call) => new URL(call.url).pathname === `/api/turns/${ROOM_ID}/abort`,
    );
    expect(JSON.parse(String(abortCall?.init?.body))).toEqual({
      reason: "voice-session-interrupt",
      clientMessageId: "voice:turn-1",
    });
    await replacement.body?.cancel();
  });

  test("accepts a pre-registration tombstone without wedging the next request", async () => {
    const streamIds: string[] = [];
    const abortIds: string[] = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const body = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        abortIds.push(body.clientMessageId);
        return Response.json(
          committedAbortStatus(body.clientMessageId, {
            requestAborted: false,
            requestObserved: false,
            requestArmed: true,
          }),
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        clientMessageId: string;
      };
      streamIds.push(body.clientMessageId);
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const request = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const firstController = new AbortController();
    const first = await request("pre-register", firstController.signal);
    firstController.abort(new DOMException("barge in", "AbortError"));
    await first.body?.cancel(firstController.signal.reason);

    const next = await request("next", new AbortController().signal);
    expect(abortIds).toEqual(["voice:pre-register"]);
    expect(streamIds).toEqual(["voice:pre-register", "voice:next"]);
    await next.body?.cancel();
  });

  test("keeps concurrent same-room aborts isolated by exact request id", async () => {
    const abortIds: string[] = [];
    const abortResponses = new Map<
      string,
      { promise: Promise<Response>; resolve: (response: Response) => void }
    >();
    for (const id of ["voice:tab-a", "voice:tab-b"]) {
      let resolve: ((response: Response) => void) | undefined;
      const promise = new Promise<Response>((settle) => {
        resolve = settle;
      });
      abortResponses.set(id, {
        promise,
        resolve: (response) => resolve?.(response),
      });
    }
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const body = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        abortIds.push(body.clientMessageId);
        const deferred = abortResponses.get(body.clientMessageId);
        if (!deferred) throw new Error("unexpected exact abort id");
        return deferred.promise;
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 250 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const open = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const [responseA, responseB] = await Promise.all([
      open("tab-a", controllerA.signal),
      open("tab-b", controllerB.signal),
    ]);
    controllerA.abort(new DOMException("barge a", "AbortError"));
    controllerB.abort(new DOMException("barge b", "AbortError"));
    const cancelA = responseA.body?.cancel(controllerA.signal.reason);
    const cancelB = responseB.body?.cancel(controllerB.signal.reason);
    await Promise.all([cancelA, cancelB]);
    await Promise.resolve();
    expect(new Set(abortIds)).toEqual(new Set(["voice:tab-a", "voice:tab-b"]));

    let replacementStarted = false;
    const replacementPromise = open(
      "replacement",
      new AbortController().signal,
    ).then((response) => {
      replacementStarted = true;
      return response;
    });

    abortResponses
      .get("voice:tab-b")
      ?.resolve(Response.json(committedAbortStatus("voice:tab-b")));
    await Promise.resolve();
    expect(replacementStarted).toBe(false);

    abortResponses
      .get("voice:tab-a")
      ?.resolve(Response.json(committedAbortStatus("voice:tab-a")));
    const replacement = await replacementPromise;
    expect(replacementStarted).toBe(true);
    await replacement.body?.cancel();
  });

  test("returns Stop before room lookup while preserving the aborted transcript before replacement", async () => {
    let releaseConversations: ((response: Response) => void) | undefined;
    const conversations = new Promise<Response>((resolve) => {
      releaseConversations = resolve;
    });
    const streamIds: string[] = [];
    let firstIngressCommitted = false;
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") return conversations;
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const { clientMessageId } = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        return Response.json(
          firstIngressCommitted
            ? committedAbortStatus(clientMessageId)
            : {
                ...committedAbortStatus(clientMessageId),
                requestAborted: false,
                requestObserved: false,
                requestArmed: true,
                requestIngressState: "pending",
                requestSettled: false,
              },
        );
      }
      const { clientMessageId } = JSON.parse(String(init?.body)) as {
        clientMessageId: string;
      };
      streamIds.push(clientMessageId);
      if (clientMessageId === "voice:lookup-stop") {
        firstIngressCommitted = true;
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 250, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const open = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "keep this transcript",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const controller = new AbortController();
    const stopped = open("lookup-stop", controller.signal);
    controller.abort(new DOMException("stop now", "AbortError"));
    const stopOutcome = await Promise.race([
      stopped.then(
        () => "resolved",
        () => "aborted",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("blocked"), 10),
      ),
    ]);
    expect(stopOutcome).toBe("aborted");

    releaseConversations?.(
      Response.json({
        conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
      }),
    );
    const replacement = await open(
      "after-lookup-stop",
      new AbortController().signal,
    );
    expect(streamIds).toEqual(["voice:lookup-stop", "voice:after-lookup-stop"]);
    await replacement.body?.cancel();
  });

  test("does not retain an abort barrier when metadata fails before any stream POST", async () => {
    let releaseFirstMetadata: ((response: Response) => void) | undefined;
    const firstMetadata = new Promise<Response>((resolve) => {
      releaseFirstMetadata = resolve;
    });
    let metadataCalls = 0;
    const streamIds: string[] = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        metadataCalls += 1;
        if (metadataCalls === 1) return firstMetadata;
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname.startsWith("/api/turns/")) {
        throw new Error("no exact abort exists before room resolution");
      }
      const { clientMessageId } = JSON.parse(String(init?.body)) as {
        clientMessageId: string;
      };
      streamIds.push(clientMessageId);
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { ingressTimeoutMs: 100 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const open = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const firstController = new AbortController();
    const first = open("metadata-failure", firstController.signal);
    firstController.abort(new DOMException("superseded", "AbortError"));
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    releaseFirstMetadata?.(
      new Response("metadata unavailable", { status: 500 }),
    );
    await Promise.resolve();

    const replacement = await open(
      "after-metadata-failure",
      new AbortController().signal,
    );
    expect(metadataCalls).toBe(2);
    expect(streamIds).toEqual(["voice:after-metadata-failure"]);
    await replacement.body?.cancel();
  });

  test("retries one immutable aborted transcript when the first loopback POST never arrives", async () => {
    const requestBodies: string[] = [];
    let rejectFirstPost: ((reason: unknown) => void) | undefined;
    const firstPost = new Promise<Response>((_resolve, reject) => {
      rejectFirstPost = reject;
    });
    let ingressCommitted = false;
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const { clientMessageId } = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        return Response.json(
          ingressCommitted
            ? committedAbortStatus(clientMessageId)
            : {
                ...committedAbortStatus(clientMessageId),
                requestAborted: false,
                requestObserved: false,
                requestArmed: true,
                requestIngressState: "pending",
                requestSettled: false,
              },
        );
      }
      const serializedBody = String(init?.body);
      requestBodies.push(serializedBody);
      if (requestBodies.length === 1) return firstPost;
      ingressCommitted = true;
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 250, abortRetryDelayMs: 1 },
    );
    const controller = new AbortController();
    const request = bridge(
      `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "X-Eliza-Voice-Trace-Id": "retry-ingress" },
        body: JSON.stringify({
          text: "the correction must remain in context",
          clientMessageId: "voice:retry-ingress",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      },
    );
    await Promise.resolve();
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(request).rejects.toHaveProperty("name", "AbortError");
    rejectFirstPost?.(new TypeError("connection closed before delivery"));

    const replacement = await bridge(
      `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`,
      {
        method: "POST",
        signal: new AbortController().signal,
        headers: { "X-Eliza-Voice-Trace-Id": "after-retry" },
        body: JSON.stringify({
          text: "now answer both turns",
          clientMessageId: "voice:after-retry",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      },
    );
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[2] ?? "{}").clientMessageId).toBe(
      "voice:after-retry",
    );
    await replacement.body?.cancel();
  });

  test("rejects a successful stream response that lacks the durable ingress acknowledgement", async () => {
    const downstream = (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      return new Response("", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
    );
    await expect(
      bridge(
        `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`,
        {
          method: "POST",
          headers: { "X-Eliza-Voice-Trace-Id": "missing-ingress-ack" },
          body: JSON.stringify({
            text: "hello",
            clientMessageId: "voice:missing-ingress-ack",
            metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
            streamProtocol: "delta-v2",
          }),
        },
      ),
    ).rejects.toThrow("arrived before durable ingress");
  });

  test("does not retain a barrier after an authoritative pre-ingress HTTP rejection", async () => {
    const streamIds: string[] = [];
    let abortCalls = 0;
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        abortCalls += 1;
        return Response.json(committedAbortStatus("voice:known-http-failure"));
      }
      const { clientMessageId } = JSON.parse(String(init?.body)) as {
        clientMessageId: string;
      };
      streamIds.push(clientMessageId);
      if (clientMessageId === "voice:known-http-failure") {
        return new Response("ingress rejected", { status: 500 });
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 50, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const request = (traceId: string) =>
      bridge(streamUrl, {
        method: "POST",
        signal: new AbortController().signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    await expect(request("known-http-failure")).rejects.toThrow(
      "returned HTTP 500",
    );
    const replacement = await request("after-known-http-failure");
    expect(streamIds).toEqual([
      "voice:known-http-failure",
      "voice:after-known-http-failure",
    ]);
    expect(abortCalls).toBe(0);
    await replacement.body?.cancel();
  });

  test("clears an aborted request barrier after its exact ingress receipt fails terminally", async () => {
    const streamIds: string[] = [];
    const abortIds: string[] = [];
    let resolveFirstResponse: ((response: Response) => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markFirstReleased: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      markFirstReleased = resolve;
    });
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const { clientMessageId } = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        abortIds.push(clientMessageId);
        await firstReleased;
        return Response.json(
          committedAbortStatus(clientMessageId, {
            requestAborted: false,
            requestObserved: true,
            requestArmed: false,
            requestIngressState: "failed",
            requestIngressFailure: "request_finished_before_ingress",
            requestSettled: true,
          }),
        );
      }
      const { clientMessageId } = JSON.parse(String(init?.body)) as {
        clientMessageId: string;
      };
      streamIds.push(clientMessageId);
      if (clientMessageId === "voice:aborted-known-failure") {
        markFirstStarted?.();
        return new Promise<Response>((resolve) => {
          resolveFirstResponse = resolve;
        });
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 100, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const request = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const firstController = new AbortController();
    const first = request("aborted-known-failure", firstController.signal);
    await firstStarted;
    firstController.abort(new DOMException("superseded", "AbortError"));
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    resolveFirstResponse?.(new Response("ingress rejected", { status: 500 }));
    markFirstReleased?.();

    const replacement = await request(
      "after-aborted-known-failure",
      new AbortController().signal,
    );
    expect(streamIds).toEqual([
      "voice:aborted-known-failure",
      "voice:after-aborted-known-failure",
    ]);
    expect(abortIds).toEqual(["voice:aborted-known-failure"]);
    await replacement.body?.cancel();
  });

  test("keeps an unknown-fate response loss behind the exact ingress barrier", async () => {
    const streamBodies: string[] = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const { clientMessageId } = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        return Response.json(committedAbortStatus(clientMessageId));
      }
      const serializedBody = String(init?.body);
      streamBodies.push(serializedBody);
      const { clientMessageId } = JSON.parse(serializedBody) as {
        clientMessageId: string;
      };
      if (clientMessageId === "voice:lost-response") {
        if (streamBodies.length === 1) {
          throw new TypeError("response disappeared after durable accept");
        }
        return new Response("already settled", { status: 409 });
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 250, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const makeInit = (traceId: string): RequestInit => ({
      method: "POST",
      signal: new AbortController().signal,
      headers: { "X-Eliza-Voice-Trace-Id": traceId },
      body: JSON.stringify({
        text: "retain even if the response is lost",
        clientMessageId: `voice:${traceId}`,
        metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
        streamProtocol: "delta-v2",
      }),
    });

    await expect(bridge(streamUrl, makeInit("lost-response"))).rejects.toThrow(
      "response disappeared",
    );
    const replacement = await bridge(streamUrl, makeInit("after-loss"));
    expect(streamBodies).toHaveLength(3);
    expect(streamBodies[0]).toBe(streamBodies[1]);
    expect(JSON.parse(streamBodies[2] ?? "{}").clientMessageId).toBe(
      "voice:after-loss",
    );
    await replacement.body?.cancel();
  });

  test("bounds a hung exact abort and retries only that old id before recovery", async () => {
    let hangAbort = true;
    const abortIds: string[] = [];
    const downstream = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        const body = JSON.parse(String(init?.body)) as {
          clientMessageId: string;
        };
        abortIds.push(body.clientMessageId);
        if (hangAbort) return new Promise<Response>(() => undefined);
        return Response.json(
          committedAbortStatus(body.clientMessageId, {
            requestAborted: false,
            requestObserved: false,
            requestArmed: true,
          }),
        );
      }
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: COMMITTED_STREAM_HEADERS,
      });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 20, abortRetryDelayMs: 1 },
    );
    const streamUrl = `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`;
    const request = (traceId: string, signal: AbortSignal) =>
      bridge(streamUrl, {
        method: "POST",
        signal,
        headers: { "X-Eliza-Voice-Trace-Id": traceId },
        body: JSON.stringify({
          text: "hello locally",
          clientMessageId: `voice:${traceId}`,
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      });

    const firstController = new AbortController();
    const first = await request("hung-old", firstController.signal);
    firstController.abort(new DOMException("barge in", "AbortError"));
    const cancelStartedAt = Date.now();
    await first.body?.cancel(firstController.signal.reason);
    expect(Date.now() - cancelStartedAt).toBeLessThan(250);

    await expect(
      request("blocked-new", new AbortController().signal),
    ).rejects.toThrow("local runtime turn abort did not settle within 20ms");
    hangAbort = false;
    const recovered = await request(
      "recovered-new",
      new AbortController().signal,
    );
    expect(abortIds).toEqual([
      "voice:hung-old",
      "voice:hung-old",
      "voice:hung-old",
    ]);
    await recovered.body?.cancel();
  });

  test("returns caller-visible body cancellation before native cleanup or abort settlement", async () => {
    const never = new Promise<void>(() => undefined);
    const downstream = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/conversations") {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, roomId: ROOM_ID }],
        });
      }
      if (pathname === `/api/turns/${ROOM_ID}/abort`) {
        return new Promise<Response>(() => undefined);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => never,
        }),
        { headers: COMMITTED_STREAM_HEADERS },
      );
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      downstream,
      { abortTimeoutMs: 20, abortRetryDelayMs: 1 },
    );
    const controller = new AbortController();
    const response = await bridge(
      `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${CONVERSATION_ID}/messages/stream`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "X-Eliza-Voice-Trace-Id": "fast-stop" },
        body: JSON.stringify({
          text: "stop",
          clientMessageId: "voice:fast-stop",
          metadata: { clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT },
          streamProtocol: "delta-v2",
        }),
      },
    );
    controller.abort(new DOMException("stop", "AbortError"));

    const outcome = await Promise.race([
      response.body?.cancel(controller.signal.reason).then(() => "cancelled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("blocked"), 10),
      ),
    ]);
    expect(outcome).toBe("cancelled");
  });

  test("rejects non-loopback origins and unsupported upstream paths", async () => {
    expect(() =>
      createLocalRuntimeConversationFetch("https://api.example.com"),
    ).toThrow(LocalRuntimeConversationFetchError);

    const bridge = createLocalRuntimeConversationFetch(
      "http://localhost:31337",
    );
    await expect(
      bridge("https://cloud.example/not-a-conversation", {
        method: "POST",
        body: JSON.stringify({
          text: "hello",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
  });

  test("rejects malformed or empty conversation bodies", async () => {
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
    );
    const url =
      "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/11111111-1111-4111-8111-111111111111/messages/stream";

    await expect(
      bridge(url, { method: "POST", body: "{nope" }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({
          text: "",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
    await expect(
      bridge(url, {
        method: "POST",
        body: JSON.stringify({
          text: "hello",
          metadata: {
            clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
          },
          streamProtocol: "legacy",
        }),
      }),
    ).rejects.toThrow(LocalRuntimeConversationFetchError);
  });
});

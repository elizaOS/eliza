/**
 * Unit coverage for the agent chat-streaming transport: terminal-done handling
 * and stream-generation errors. Deterministic streams, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";
import { StreamGenerationError } from "./client-base";

describe("ElizaClient agent streaming transport", () => {
  it("resolves chat streams immediately after a terminal done event", async () => {
    const encoder = new TextEncoder();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"token","text":"hi","fullText":"hi"}\n\n' +
            'data: {"type":"done","fullText":"hi","agentName":"Eliza"}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const cancel = vi.fn(async () => {});
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      onToken,
    );

    expect(result).toEqual({
      text: "hi",
      agentName: "Eliza",
      completed: true,
    });
    expect(onToken).toHaveBeenCalledWith("hi", "hi");
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("elizaos-sse-terminal-done");
  });

  it("surfaces the done event's thought as reasoning", async () => {
    const encoder = new TextEncoder();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"token","text":"Sure.","fullText":"Sure."}\n\n' +
            'data: {"type":"done","fullText":"Sure.","agentName":"Eliza","thought":"User wants a yes/no; keep it short."}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const cancel = vi.fn(async () => {});
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      vi.fn(),
    );

    expect(result).toEqual({
      text: "Sure.",
      agentName: "Eliza",
      completed: true,
      reasoning: "User wants a yes/no; keep it short.",
    });
  });

  it("surfaces done event action results for page handoffs", async () => {
    const encoder = new TextEncoder();
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: encoder.encode(
        'data: {"type":"done","fullText":"Created.","agentName":"Eliza","actionResults":[{"actionName":"WORKFLOW","success":true,"values":{"workflowId":"workflow-1"}}]}\n\n',
      ),
    });
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel: vi.fn(async () => {}) }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "create workflow",
      vi.fn(),
    );

    expect(result.actionResults).toEqual([
      {
        actionName: "WORKFLOW",
        success: true,
        values: { workflowId: "workflow-1" },
      },
    ]);
  });

  it("preserves structured terminal error events as StreamGenerationError", async () => {
    const encoder = new TextEncoder();
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: encoder.encode(
        'data: {"type":"error","message":"no provider configured","failureKind":"no_provider"}\n\n',
      ),
    });
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel: vi.fn(async () => {}) }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    let thrown: unknown;
    try {
      await client.streamChatEndpoint(
        "/api/conversations/conversation-id/messages/stream",
        "hello",
        vi.fn(),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StreamGenerationError);
    expect(thrown).toMatchObject({
      message: "no provider configured",
      failureKind: "no_provider",
    });
  });

  it("omits reasoning when the done event has no thought", async () => {
    const encoder = new TextEncoder();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"done","fullText":"ok","agentName":"Eliza"}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel: vi.fn(async () => {}) }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      vi.fn(),
    );

    expect(result).not.toHaveProperty("reasoning");
    expect(result.completed).toBe(true);
  });

  it("emits onToken for an early chunk BEFORE the next chunk arrives (true incremental render, #8773)", async () => {
    const encoder = new TextEncoder();
    // The 2nd read pends until the test releases it — so if onToken('a') has
    // fired by then, the consumer is genuinely incremental (not buffering the
    // whole reply). Every existing test delivers all events in ONE read.
    let releaseSecond: (value: { done: boolean; value?: Uint8Array }) => void =
      () => {};
    const secondRead = new Promise<{ done: boolean; value?: Uint8Array }>(
      (resolve) => {
        releaseSecond = resolve;
      },
    );
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"token","text":"a","fullText":"a"}\n\n',
        ),
      })
      .mockImplementationOnce(() => secondRead)
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"done","fullText":"ab","agentName":"Eliza"}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read, cancel: vi.fn(async () => {}) }) },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const onToken = vi.fn();

    const resultPromise = client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      onToken,
    );

    // Token 'a' must surface while the 2nd chunk is still pending.
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledWith("a", "a"));
    expect(onToken).toHaveBeenCalledTimes(1);

    // Release the 2nd chunk (token 'b'); the stream then completes on the done event.
    releaseSecond({
      done: false,
      value: encoder.encode(
        'data: {"type":"token","text":"b","fullText":"ab"}\n\n',
      ),
    });

    const result = await resultPromise;
    expect(onToken).toHaveBeenNthCalledWith(2, "b", "ab");
    expect(result).toEqual({ text: "ab", agentName: "Eliza", completed: true });
  });

  it("reassembles a single SSE event split across two read() chunks (#8773)", async () => {
    const encoder = new TextEncoder();
    // A `data:` JSON line split mid-token across two TCP reads — the exact
    // real-network boundary case. The consumer must buffer until the \n\n.
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode('data: {"type":"to'),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'ken","text":"hi","fullText":"hi"}\n\n' +
            'data: {"type":"done","fullText":"hi","agentName":"Eliza"}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read, cancel: vi.fn(async () => {}) }) },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      onToken,
    );

    // Exactly one well-formed token — no partial/malformed emission from chunk-1.
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("hi", "hi");
    expect(result).toEqual({ text: "hi", agentName: "Eliza", completed: true });
  });

  it("streams security audit events through the configured request transport", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const request = vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: entry\ndata: {"type":"entry","severity":"info"}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new ElizaClient("eliza-local-agent://ipc", "local-token");
    client.setRequestTransport({ request });
    const onEvent = vi.fn();

    await client.streamSecurityAudit(onEvent);

    expect(request).toHaveBeenCalledWith(
      "eliza-local-agent://ipc/api/security/audit?stream=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer local-token",
        }),
      }),
      expect.any(Object),
    );
    expect(globalFetch).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: "entry",
      severity: "info",
    });

    vi.unstubAllGlobals();
  });
});

describe("ElizaClient chat-turn status SSE (#8813)", () => {
  function streamFromSse(sse: string) {
    const encoder = new TextEncoder();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode(sse) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const cancel = vi.fn(async () => {});
    const request = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: { getReader: () => ({ read, cancel }) },
        }) as unknown as Response,
    );
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    return client;
  }

  it("routes additive status events to onStatus without ending the stream", async () => {
    const client = streamFromSse(
      'data: {"type":"status","kind":"thinking"}\n\n' +
        'data: {"type":"status","kind":"running_action","actionName":"SEND_MESSAGE"}\n\n' +
        'data: {"type":"status","kind":"streaming"}\n\n' +
        'data: {"type":"token","text":"Done.","fullText":"Done."}\n\n' +
        'data: {"type":"done","fullText":"Done.","agentName":"Eliza"}\n\n',
    );
    const onToken = vi.fn();
    const onStatus = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hi",
      onToken,
      "DM",
      undefined,
      undefined,
      undefined,
      onStatus,
    );

    // The reply still streams + completes — status is purely additive.
    expect(result.text).toBe("Done.");
    expect(result.completed).toBe(true);
    expect(onToken).toHaveBeenCalledWith("Done.", "Done.");
    // Every status event surfaced, in order, with action detail preserved.
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      { kind: "thinking" },
      { kind: "running_action", actionName: "SEND_MESSAGE" },
      { kind: "streaming" },
    ]);
  });

  it("ignores an unknown status kind (forward-compat) and never crashes", async () => {
    const client = streamFromSse(
      'data: {"type":"status","kind":"thinking"}\n\n' +
        'data: {"type":"status","kind":"future_phase"}\n\n' +
        'data: {"type":"done","fullText":"ok","agentName":"Eliza"}\n\n',
    );
    const onStatus = vi.fn();

    await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hi",
      vi.fn(),
      "DM",
      undefined,
      undefined,
      undefined,
      onStatus,
    );

    // Only the recognized kind is delivered; the unknown one is dropped.
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      { kind: "thinking" },
    ]);
  });

  it("routes additive `tool` events to onToolEvent, correlated by callId", async () => {
    const client = streamFromSse(
      'data: {"type":"status","kind":"running_tool","toolName":"WEB_SEARCH"}\n\n' +
        'data: {"type":"tool","phase":"call","callId":"c1","toolName":"WEB_SEARCH","args":{"query":"elizaOS"}}\n\n' +
        'data: {"type":"tool","phase":"result","callId":"c1","toolName":"WEB_SEARCH","result":{"hits":3}}\n\n' +
        'data: {"type":"token","text":"Found 3.","fullText":"Found 3."}\n\n' +
        'data: {"type":"done","fullText":"Found 3.","agentName":"Eliza"}\n\n',
    );
    const onToken = vi.fn();
    const onStatus = vi.fn();
    const onToolEvent = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "search elizaOS",
      onToken,
      "DM",
      undefined,
      undefined,
      undefined,
      onStatus,
      onToolEvent,
    );

    // The reply still streams + completes — tool events are purely additive.
    expect(result.text).toBe("Found 3.");
    expect(result.completed).toBe(true);
    expect(onToolEvent.mock.calls.map((c) => c[0])).toEqual([
      {
        phase: "call",
        callId: "c1",
        toolName: "WEB_SEARCH",
        args: { query: "elizaOS" },
      },
      {
        phase: "result",
        callId: "c1",
        toolName: "WEB_SEARCH",
        result: { hits: 3 },
      },
    ]);
  });

  it("drops a malformed `tool` frame (missing callId) without crashing the stream", async () => {
    const client = streamFromSse(
      'data: {"type":"tool","phase":"call","toolName":"WEB_SEARCH"}\n\n' +
        'data: {"type":"tool","phase":"future_phase","callId":"c1","toolName":"X"}\n\n' +
        'data: {"type":"done","fullText":"ok","agentName":"Eliza"}\n\n',
    );
    const onToolEvent = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hi",
      vi.fn(),
      "DM",
      undefined,
      undefined,
      undefined,
      undefined,
      onToolEvent,
    );

    // Neither malformed frame (no callId; unknown phase) reaches the consumer.
    expect(onToolEvent).not.toHaveBeenCalled();
    expect(result.completed).toBe(true);
  });

  it("leaves token/done behaviour byte-for-byte unchanged when no onStatus is passed", async () => {
    const client = streamFromSse(
      'data: {"type":"status","kind":"thinking"}\n\n' +
        'data: {"type":"token","text":"hi","fullText":"hi"}\n\n' +
        'data: {"type":"done","fullText":"hi","agentName":"Eliza"}\n\n',
    );
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      onToken,
    );

    expect(result).toMatchObject({
      text: "hi",
      agentName: "Eliza",
      completed: true,
    });
    expect(onToken).toHaveBeenCalledWith("hi", "hi");
  });

  it("marks a 60s idle stall as a retryable provider_issue, keeping partial text", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const read = vi
        .fn()
        // First read delivers a partial token, then the provider hangs — the
        // second read never resolves, so only the 60s idle timer can settle it.
        .mockResolvedValueOnce({
          done: false,
          value: encoder.encode(
            'data: {"type":"token","text":"par","fullText":"par"}\n\n',
          ),
        })
        .mockReturnValueOnce(new Promise(() => {}));
      const cancel = vi.fn(async () => {});
      const request = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: { getReader: () => ({ read, cancel }) },
          }) as unknown as Response,
      );
      const client = new ElizaClient("http://agent.example:31337", "token");
      client.setRequestTransport({ request });

      const resultPromise = client.streamChatEndpoint(
        "/api/conversations/conversation-id/messages/stream",
        "hello",
        vi.fn(),
      );

      // Process the partial token, then trip the 60s idle timeout on the hang.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      // The stall is now a retryable provider issue (renderer shows Retry)
      // instead of an ambiguous interrupt, and the partial text is retained.
      expect(result.completed).toBe(false);
      expect(result.failureKind).toBe("provider_issue");
      expect(result.text).toContain("par");
      expect(cancel).toHaveBeenCalledWith("elizaos-sse-idle-timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

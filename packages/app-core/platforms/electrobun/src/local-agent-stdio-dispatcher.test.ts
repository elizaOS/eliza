/** Exercises local agent stdio dispatcher behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  LocalAgentStdioDispatcher,
  type StdioFrameWriter,
} from "./local-agent-stdio-dispatcher";

/**
 * Unit tests for the main-process client of the desktop local-agent NDJSON
 * stdio bridge (#12355): request framing, id correlation, cancellation, and
 * error-frame-to-rejection translation. Drives a deterministic in-memory writer
 * (no spawned child); the real child-side kernel is proven by the capture lane.
 */

function makeWriter(): { writer: StdioFrameWriter; lines: string[] } {
  const lines: string[] = [];
  return { writer: { write: (line) => lines.push(line) }, lines };
}

describe("LocalAgentStdioDispatcher", () => {
  it("frames a request as NDJSON with a monotonic id and resolves on the matching response", async () => {
    const { writer, lines } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);

    const promise = dispatcher.request({
      requestId: "owner-1",
      path: "/api/health",
      method: "GET",
      headers: {},
      body: null,
    });

    expect(lines).toHaveLength(1);
    const sent = JSON.parse(lines[0]);
    expect(sent.id).toBe(1);
    expect(sent.method).toBe("local_agent_request");
    expect(sent.payload).toEqual({
      path: "/api/health",
      method: "GET",
      headers: {},
      body: null,
    });

    dispatcher.handleLine(
      JSON.stringify({
        id: 1,
        ok: true,
        result: { status: 200, body: '{"ok":true}' },
      }),
    );

    await expect(promise).resolves.toEqual({
      status: 200,
      body: '{"ok":true}',
    });
  });

  it("correlates out-of-order responses by id", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);

    const first = dispatcher.request({
      requestId: "owner-a",
      path: "/api/a",
      method: "GET",
      headers: {},
      body: null,
    });
    const second = dispatcher.request({
      requestId: "owner-b",
      path: "/api/b",
      method: "GET",
      headers: {},
      body: null,
    });

    dispatcher.handleLine(
      JSON.stringify({ id: 2, ok: true, result: { status: 201 } }),
    );
    dispatcher.handleLine(
      JSON.stringify({ id: 1, ok: true, result: { status: 200 } }),
    );

    await expect(first).resolves.toEqual({ status: 200 });
    await expect(second).resolves.toEqual({ status: 201 });
  });

  it("rejects on an error frame with the child's message", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const promise = dispatcher.request({
      requestId: "owner-2",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    dispatcher.handleLine(
      JSON.stringify({ id: 1, ok: false, error: "route not found" }),
    );
    await expect(promise).rejects.toThrow(/route not found/);
  });

  it("ignores non-JSON lines and unknown ids (child multiplexes logs on stdout)", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const promise = dispatcher.request({
      requestId: "owner-3",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    dispatcher.handleLine("[Agent] some plain log line");
    dispatcher.handleLine(
      JSON.stringify({ id: 999, ok: true, result: { status: 200 } }),
    );
    dispatcher.handleLine(
      JSON.stringify({ id: 1, ok: true, result: { status: 204 } }),
    );
    await expect(promise).resolves.toEqual({ status: 204 });
  });

  it("rejects a response frame whose result has no numeric status", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const promise = dispatcher.request({
      requestId: "owner-4",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    dispatcher.handleLine(
      JSON.stringify({ id: 1, ok: true, result: { body: "nope" } }),
    );
    await expect(promise).rejects.toThrow(/missing a numeric status/);
  });

  it("sends a cancellation control frame for the owned request", () => {
    const { writer, lines } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    void dispatcher.request({
      requestId: "owner-cancel",
      path: "/api/slow",
      method: "GET",
      headers: {},
      body: null,
    });

    expect(dispatcher.cancel("owner-cancel")).toBe(true);
    expect(JSON.parse(lines[1])).toEqual({
      id: 2,
      method: "local_agent_cancel",
      payload: { requestId: 1 },
    });
    expect(dispatcher.cancel("unknown")).toBe(false);
  });

  it("opens and forwards an incremental stream without buffering", async () => {
    const { writer, lines } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const chunks: string[] = [];
    const ended: Array<string | undefined> = [];
    const head = dispatcher.requestStream(
      {
        requestId: "stream-1",
        path: "/api/conversations/c/messages/stream",
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: "{}",
      },
      {
        onChunk: (chunk) => chunks.push(chunk),
        onEnd: (error) => ended.push(error),
      },
    );
    expect(JSON.parse(lines[0])).toMatchObject({
      id: "stream-1",
      stream: true,
      method: "local_agent_stream_request",
    });

    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-1",
        stream: "response",
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await expect(head).resolves.toMatchObject({
      streamId: "stream-1",
      status: 200,
    });
    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-1",
        stream: "chunk",
        dataBase64: Buffer.from("data: hi\n\n").toString("base64"),
      }),
    );
    expect(chunks).toEqual(["data: hi\n\n"]);
    dispatcher.handleLine(
      JSON.stringify({ id: "stream-1", stream: "complete" }),
    );
    expect(ended).toEqual([undefined]);
  });

  it("rejects completion before the HTTP response instead of fabricating 200", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const head = dispatcher.requestStream(
      {
        requestId: "stream-no-head",
        path: "/api/stream",
        method: "GET",
        headers: {},
        body: null,
      },
      { onChunk: () => undefined, onEnd: () => undefined },
    );

    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-no-head",
        stream: "complete",
      }),
    );

    await expect(head).rejects.toThrow(
      /completed before sending an HTTP response/,
    );
  });

  it("rejects a chunk that arrives before the HTTP response", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const head = dispatcher.requestStream(
      {
        requestId: "stream-out-of-order",
        path: "/api/stream",
        method: "GET",
        headers: {},
        body: null,
      },
      { onChunk: () => undefined, onEnd: () => undefined },
    );

    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-out-of-order",
        stream: "chunk",
        dataBase64: Buffer.from("bad order").toString("base64"),
      }),
    );

    await expect(head).rejects.toThrow(/chunk arrived before response/);
  });

  it("ends an established stream on a duplicate response frame", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const ended: Array<string | undefined> = [];
    const head = dispatcher.requestStream(
      {
        requestId: "stream-duplicate-head",
        path: "/api/stream",
        method: "GET",
        headers: {},
        body: null,
      },
      { onChunk: () => undefined, onEnd: (error) => ended.push(error) },
    );

    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-duplicate-head",
        stream: "response",
        status: 200,
      }),
    );
    await expect(head).resolves.toMatchObject({ status: 200 });
    dispatcher.handleLine(
      JSON.stringify({
        id: "stream-duplicate-head",
        stream: "response",
        status: 200,
      }),
    );

    expect(ended).toEqual([
      "local-agent stream protocol error: duplicate response frame",
    ]);
  });

  it("dispose() rejects all in-flight requests (pipe closed)", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const promise = dispatcher.request({
      requestId: "owner-5",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    dispatcher.dispose("agent child exited");
    await expect(promise).rejects.toThrow(/agent child exited/);
  });
});

/** Exercises local agent stdio dispatcher behavior with deterministic app-core test fixtures. */
import { describe, expect, it, vi } from "vitest";
import {
  LocalAgentStdioDispatcher,
  type StdioFrameWriter,
} from "./local-agent-stdio-dispatcher";

/**
 * Unit tests for the main-process client of the desktop local-agent NDJSON
 * stdio bridge (#12355): request framing, id correlation, timeout, and
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
      path: "/api/a",
      method: "GET",
      headers: {},
      body: null,
    });
    const second = dispatcher.request({
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

  it("times out a request with no response", async () => {
    vi.useFakeTimers();
    try {
      const { writer } = makeWriter();
      const dispatcher = new LocalAgentStdioDispatcher(writer, 100);
      const promise = dispatcher.request({
        path: "/api/slow",
        method: "GET",
        headers: {},
        body: null,
      });
      const assertion = expect(promise).rejects.toThrow(
        /timed out after 100ms/,
      );
      await vi.advanceTimersByTimeAsync(101);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() rejects all in-flight requests (pipe closed)", async () => {
    const { writer } = makeWriter();
    const dispatcher = new LocalAgentStdioDispatcher(writer);
    const promise = dispatcher.request({
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    dispatcher.dispose("agent child exited");
    await expect(promise).rejects.toThrow(/agent child exited/);
  });
});

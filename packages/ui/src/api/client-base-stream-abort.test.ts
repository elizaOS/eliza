/**
 * Unit coverage for client-side stream aborts on the base ElizaClient.
 * Deterministic SSE streams, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

/**
 * Pins that a client abort tears down the SSE read loop immediately. The caller's
 * AbortSignal must stay wired to the fetch through the body read (not just the
 * request phase), so a client-side Stop cancels the stream without waiting on the
 * separate server-abort POST. Deterministic streams, no live model.
 */
describe("streamChatEndpoint client abort", () => {
  it("stops the read loop and cancels the reader when the client aborts mid-stream", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    let readCalls = 0;
    const read = vi.fn(() => {
      readCalls += 1;
      if (readCalls === 1) {
        // First token arrives, then the server goes quiet (still generating).
        return Promise.resolve({
          done: false,
          value: encoder.encode(
            'data: {"type":"token","text":"partial","fullText":"partial"}\n\n',
          ),
        });
      }
      // The stream is now stalled between tokens. Simulate the user hitting Stop
      // while this read is pending — the abort must tear the loop down without
      // waiting for this (never-resolving) read or the 60s idle timeout.
      queueMicrotask(() => controller.abort());
      return new Promise<never>(() => {});
    });
    const cancel = vi.fn(async () => {});
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conv-1/messages/stream",
      "hello",
      onToken,
      "DM",
      controller.signal,
    );

    // The partial that streamed before the stop is preserved and returned as an
    // interrupted (completed:false) turn.
    expect(onToken).toHaveBeenCalledWith("partial", "partial");
    expect(result.text).toBe("partial");
    expect(result.completed).toBe(false);
    // The read loop stopped consuming: the reader was cancelled with the client
    // abort reason and no read was issued past the stalled second one.
    expect(cancel).toHaveBeenCalledWith("elizaos-sse-client-abort");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("completes normally and never client-cancels when the signal is not aborted", async () => {
    // The abort wiring must not disturb a normal terminal-done completion, and
    // the per-read abort promise must not leak an unhandled rejection.
    const encoder = new TextEncoder();
    const controller = new AbortController();
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
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    const result = await client.streamChatEndpoint(
      "/api/conversations/conv-1/messages/stream",
      "hi",
      vi.fn(),
      "DM",
      controller.signal,
    );

    expect(result).toEqual({ text: "hi", agentName: "Eliza", completed: true });
    expect(cancel).toHaveBeenCalledWith("elizaos-sse-terminal-done");
    expect(cancel).not.toHaveBeenCalledWith("elizaos-sse-client-abort");
  });
});

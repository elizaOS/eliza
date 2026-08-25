/**
 * Covers the bounded HTTP body reader — declarative size gate, live size gate,
 * deadline cancellation, and error mapping — so oversized or hanging Dropbox
 * responses never allocate unbounded memory.
 */
import { describe, expect, it } from "vitest";

import { type BoundedResponseErrors, readBoundedResponse } from "./bounded-response";

function errors(): BoundedResponseErrors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tooLarge: (declaredBytes: number | null) => {
      calls.push(`tooLarge:${declaredBytes}`);
      return new Error(`tooLarge:${declaredBytes}`);
    },
    timedOut: () => {
      calls.push("timedOut");
      return new Error("timedOut");
    },
    readFailed: (cause: unknown) => {
      calls.push(`readFailed:${String(cause)}`);
      return new Error(`readFailed:${String(cause)}`);
    },
  };
}

function responseFromChunks(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

function hangingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // never enqueue or close — hangs until timeout cancels
    },
  });
  return new Response(stream);
}

function failingResponse(cause: unknown): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(_controller) {
      // throw synchronously on read: simulate underlying stream error
    },
    pull() {
      throw cause;
    },
  });
  // wrap to ensure body exists
  const response = new Response(stream);
  // override getReader to throw
  const body = response.body;
  if (body) void body.getReader.bind(body);
  // Instead construct a custom stream that fails on read
  const failStream = new ReadableStream<Uint8Array>({
    pull() {
      throw cause;
    },
  });
  return new Response(failStream);
}

describe("readBoundedResponse", () => {
  it("rejects when declared Content-Length exceeds maxBytes without consuming body", async () => {
    const response = responseFromChunks([new Uint8Array([1, 2, 3])], {
      "Content-Length": "100",
    });
    const e = errors();
    await expect(readBoundedResponse(response, 10, 1000, e)).rejects.toThrow("tooLarge:100");
    expect(e.calls).toContain("tooLarge:100");
  });

  it("returns empty Uint8Array when response has no body", async () => {
    const response = new Response(null);
    const e = errors();
    const bytes = await readBoundedResponse(response, 10, 1000, e);
    expect(bytes).toEqual(new Uint8Array());
  });

  it("reads and concatenates chunks within bounds", async () => {
    const response = responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]);
    const e = errors();
    const bytes = await readBoundedResponse(response, 10, 1000, e);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects when live total exceeds maxBytes and cancels reader", async () => {
    const response = responseFromChunks([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
    const e = errors();
    await expect(readBoundedResponse(response, 4, 1000, e)).rejects.toThrow("tooLarge");
    expect(e.calls.some((c) => c.startsWith("tooLarge:"))).toBe(true);
  });

  it("treats missing or non-numeric Content-Length as no declarative gate", async () => {
    const r1 = responseFromChunks([new Uint8Array([1])], { "Content-Length": "not-a-number" });
    const e1 = errors();
    await expect(readBoundedResponse(r1, 10, 1000, e1)).resolves.toEqual(new Uint8Array([1]));

    const r2 = responseFromChunks([new Uint8Array([1])], {});
    const e2 = errors();
    await expect(readBoundedResponse(r2, 10, 1000, e2)).resolves.toEqual(new Uint8Array([1]));
  });

  it("treats non-safe-integer Content-Length as no declarative gate", async () => {
    // Number.MAX_SAFE_INTEGER + 1 is not safe
    const big = String(Number.MAX_SAFE_INTEGER + 2);
    const r = responseFromChunks([new Uint8Array([1])], { "Content-Length": big });
    const e = errors();
    await expect(readBoundedResponse(r, 10, 1000, e)).resolves.toEqual(new Uint8Array([1]));
  });

  it("times out when stream hangs past deadline", async () => {
    const response = hangingResponse();
    const e = errors();
    await expect(readBoundedResponse(response, 10, 50, e)).rejects.toThrow("timedOut");
    expect(e.calls).toContain("timedOut");
  });

  it("immediately times out when timeoutMs is 0 or negative", async () => {
    const response = responseFromChunks([new Uint8Array([1, 2])]);
    const e = errors();
    await expect(readBoundedResponse(response, 10, 0, e)).rejects.toThrow("timedOut");
  });

  it("maps stream read failure to readFailed", async () => {
    const cause = new Error("underlying failure");
    const response = failingResponse(cause);
    const e = errors();
    await expect(readBoundedResponse(response, 10, 1000, e)).rejects.toThrow("readFailed");
    expect(e.calls.some((c) => c.startsWith("readFailed:"))).toBe(true);
  });

  it("respects exact maxBytes boundary (total == maxBytes succeeds)", async () => {
    const response = responseFromChunks([new Uint8Array([1, 2, 3])]);
    const e = errors();
    await expect(readBoundedResponse(response, 3, 1000, e)).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("admits declared Content-Length equal to maxBytes", async () => {
    const response = responseFromChunks([new Uint8Array([1])], { "Content-Length": "5" });
    const e = errors();
    await expect(readBoundedResponse(response, 5, 1000, e)).resolves.toEqual(new Uint8Array([1]));
  });
});

import { describe, expect, it } from "vitest";
import { readBoundedResponse } from "./bounded-response";

function makeErrors() {
  return {
    tooLarge: (declaredBytes: number | null) => new Error(`too large: ${String(declaredBytes)}`),
    timedOut: () => new Error("timed out"),
    readFailed: (cause: unknown) => new Error(`read failed: ${String(cause)}`),
  };
}

function responseWithBody(bytes: Uint8Array, headers?: Record<string, string>) {
  return new Response(bytes, {
    headers: { "Content-Length": String(bytes.byteLength), ...headers },
  });
}

function streamOf(chunks: Uint8Array[]) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("readBoundedResponse", () => {
  it("rejects immediately when the declared Content-Length exceeds the cap", async () => {
    const errors = makeErrors();
    const resp = responseWithBody(new Uint8Array(10), {
      "Content-Length": "100",
    });
    await expect(readBoundedResponse(resp, 50, 1000, errors)).rejects.toThrow("too large: 100");
  });

  it("reads a body within the cap", async () => {
    const errors = makeErrors();
    const body = new TextEncoder().encode("hello bounded world");
    const resp = new Response(body);
    const out = await readBoundedResponse(resp, 1024, 1000, errors);
    expect(new TextDecoder().decode(out)).toBe("hello bounded world");
  });

  it("returns an empty buffer when the response has no body", async () => {
    const errors = makeErrors();
    const resp = new Response(null, { status: 204 });
    const out = await readBoundedResponse(resp, 1024, 1000, errors);
    expect(out.byteLength).toBe(0);
  });

  it("accumulates streamed chunks", async () => {
    const errors = makeErrors();
    const resp = new Response(
      streamOf([new TextEncoder().encode("chunk-1-"), new TextEncoder().encode("chunk-2")])
    );
    const out = await readBoundedResponse(resp, 1024, 1000, errors);
    expect(new TextDecoder().decode(out)).toBe("chunk-1-chunk-2");
  });

  it("throws tooLarge when streamed bytes exceed the cap mid-read", async () => {
    const errors = makeErrors();
    const resp = new Response(
      streamOf([new TextEncoder().encode("0123456789"), new TextEncoder().encode("abcdefghij")])
    );
    await expect(readBoundedResponse(resp, 15, 1000, errors)).rejects.toThrow("too large: null");
  });

  it("throws readFailed when the stream errors", async () => {
    const errors = makeErrors();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("stream exploded");
      },
    });
    const resp = new Response(stream);
    await expect(readBoundedResponse(resp, 1024, 1000, errors)).rejects.toThrow("read failed");
  });

  it("ignores a malformed Content-Length header", async () => {
    const errors = makeErrors();
    const body = new TextEncoder().encode("data");
    const resp = new Response(body, { headers: { "Content-Length": "abc" } });
    const out = await readBoundedResponse(resp, 1024, 1000, errors);
    expect(new TextDecoder().decode(out)).toBe("data");
  });
});

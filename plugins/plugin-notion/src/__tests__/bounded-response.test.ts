import { describe, expect, it } from "vitest";
import { readBoundedResponse } from "./bounded-response.ts";

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const errors = {
  tooLarge: (n: number | null) => new Error(`too large: ${n}`),
  timedOut: () => new Error("timed out"),
  readFailed: (cause: unknown) => new Error(`read failed: ${String(cause)}`),
};

describe("readBoundedResponse", () => {
  it("reads bodies within the limit", async () => {
    const response = new Response(streamFrom([new Uint8Array([1, 2, 3])]), {
      headers: { "Content-Length": "3" },
    });
    const data = await readBoundedResponse(response, 10, 1000, errors);
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects declared content-length over the limit", async () => {
    const response = new Response(streamFrom([new Uint8Array([1])]), {
      headers: { "Content-Length": "999" },
    });
    await expect(readBoundedResponse(response, 10, 1000, errors)).rejects.toThrow("too large");
  });

  it("rejects bodies exceeding the limit mid-stream", async () => {
    const response = new Response(streamFrom([new Uint8Array(20), new Uint8Array(20)]));
    await expect(readBoundedResponse(response, 10, 1000, errors)).rejects.toThrow("too large");
  });

  it("returns empty for bodies without a stream", async () => {
    const response = new Response(null);
    const data = await readBoundedResponse(response, 10, 1000, errors);
    expect(data).toEqual(new Uint8Array());
  });
});

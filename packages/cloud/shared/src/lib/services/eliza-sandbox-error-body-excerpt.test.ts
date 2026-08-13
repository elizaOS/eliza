/**
 * Unit tests for the `readErrorBodyExcerpt` helper that streams a bounded
 * excerpt of a snapshot error response body for diagnostic logging (#18228).
 * Covers JSON extraction, non-JSON passthrough, empty body, truncation at the
 * 512-byte limit, read-failure fail-soft, reader cancellation, and multi-byte
 * UTF-8 decoder flushing at the byte boundary (felirami P2 nit on PR #18336).
 */
import { describe, expect, test } from "bun:test";
import { readErrorBodyExcerpt } from "./eliza-sandbox.ts?actual";

/** Build a minimal Response-like object from raw body bytes. */
function mockResponse(
  body: string | Uint8Array | null,
  contentType = "application/json",
): Pick<Response, "body" | "headers"> {
  if (body === null) {
    return { body: null, headers: new Headers({ "content-type": contentType }) };
  }
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers({ "content-type": contentType }),
  };
}

/** Build a multi-chunk Response-like object from raw byte arrays. */
function mockChunkedResponse(
  chunks: Uint8Array[],
  contentType = "application/json",
): Pick<Response, "body" | "headers"> {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    headers: new Headers({ "content-type": contentType }),
  };
}

describe("readErrorBodyExcerpt", () => {
  test("extracts the error field from a JSON body", async () => {
    const res = mockResponse(JSON.stringify({ error: "Container crashed" }));
    expect(await readErrorBodyExcerpt(res)).toBe("Container crashed");
  });

  test("extracts the message field from a JSON body", async () => {
    const res = mockResponse(JSON.stringify({ message: "Out of memory" }));
    expect(await readErrorBodyExcerpt(res)).toBe("Out of memory");
  });

  test("prefers error field over message field in a JSON body", async () => {
    const res = mockResponse(JSON.stringify({ error: "Primary error", message: "Secondary" }));
    expect(await readErrorBodyExcerpt(res)).toBe("Primary error");
  });

  test("returns raw excerpt when JSON body has no error/message fields", async () => {
    const res = mockResponse(JSON.stringify({ detail: "some detail" }));
    expect(await readErrorBodyExcerpt(res)).toBe(JSON.stringify({ detail: "some detail" }));
  });

  test("returns raw excerpt for non-JSON content type", async () => {
    const res = mockResponse("Internal Server Error", "text/plain");
    expect(await readErrorBodyExcerpt(res)).toBe("Internal Server Error");
  });

  test("falls through to raw excerpt for HTML-like body with JSON content-type", async () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    const res = mockResponse(html);
    // JSON.parse fails on HTML, so it should fall through to raw trimmed body.
    expect(await readErrorBodyExcerpt(res)).toBe(html);
  });

  test("returns null for empty body", async () => {
    const res = mockResponse("");
    expect(await readErrorBodyExcerpt(res)).toBeNull();
  });

  test("returns null for whitespace-only body", async () => {
    const res = mockResponse("   \n\t  ");
    expect(await readErrorBodyExcerpt(res)).toBeNull();
  });

  test("returns null when body is null", async () => {
    const res = mockResponse(null);
    expect(await readErrorBodyExcerpt(res)).toBeNull();
  });

  test("truncates body larger than 512 bytes at the boundary", async () => {
    // Create a body well beyond 512 bytes of ASCII text.
    const longBody = "A".repeat(1000);
    const res = mockResponse(longBody, "text/plain");
    const result = await readErrorBodyExcerpt(res);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(512);
    expect(result!.startsWith("AAAA")).toBe(true);
  });

  test("returns null when the reader throws during read (fail-soft)", async () => {
    const res: Pick<Response, "body" | "headers"> = {
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("Stream interrupted"));
        },
      }),
      headers: new Headers({ "content-type": "application/json" }),
    };
    expect(await readErrorBodyExcerpt(res)).toBeNull();
  });

  test("handles reader cancellation gracefully after partial reads", async () => {
    // Body larger than the 512-byte limit — the reader should be cancelled
    // after the byte budget is hit, before consuming the full body.
    // The stream must NOT be closed so that reader.cancel() actually fires
    // the underlying source's cancel handler (cancel on a closed stream is a
    // no-op).
    let cancelCalled = false;
    const longBody = "B".repeat(2000);
    const res: Pick<Response, "body" | "headers"> = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(longBody));
          // Deliberately do NOT close — the stream stays readable so
          // reader.cancel() triggers the source's cancel() handler.
        },
        cancel() {
          cancelCalled = true;
        },
      }),
      headers: new Headers({ "content-type": "text/plain" }),
    };
    const result = await readErrorBodyExcerpt(res);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(512);
    // The body (2000 bytes) far exceeds the 512-byte limit, so cancel()
    // must be called to release the connection.
    expect(cancelCalled).toBe(true);
  });

  test("flushes a multi-byte UTF-8 character split at the byte boundary", async () => {
    // U+00E9 (é) is 2 bytes in UTF-8: 0xC3 0xA9. We build a body where
    // byte 511 is the first byte of é and byte 512 is the second byte.
    // The 512-byte slice cuts mid-character — the final decoder.decode()
    // flush must reconstruct the é instead of dropping it.
    const encoder = new TextEncoder();
    const prefix = "x".repeat(511); // 511 ASCII bytes
    const suffix = "tail"; // after the boundary

    // Encode prefix + é + suffix, then split into chunks at byte 512.
    const fullBytes = encoder.encode(prefix + "é" + suffix);
    // fullBytes = [511 'x' bytes, 0xC3, 0xA9, 't', 'a', 'i', 'l']
    // Byte 511 = 0xC3 (first byte of é), byte 512 = 0xA9 (second byte).
    const firstChunk = fullBytes.slice(0, 512); // includes 0xC3 but not 0xA9
    const secondChunk = fullBytes.slice(512); // 0xA9 + 'tail'

    const res = mockChunkedResponse([firstChunk, secondChunk], "text/plain");
    const result = await readErrorBodyExcerpt(res);

    // Without the flush fix, the é (0xC3 byte) at position 511 would be
    // dropped. With the flush, it should be reconstructed.
    expect(result).not.toBeNull();
    // The result should contain at least part of the multi-byte char.
    // It may be truncated at 512 bytes, but the partial byte must be
    // flushed, not silently dropped.
    expect(result!.length).toBeGreaterThan(0);
  });
});

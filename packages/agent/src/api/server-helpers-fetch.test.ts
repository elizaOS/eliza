/**
 * Behavioral coverage for the HTTP fetch/streaming helpers extracted from
 * server.ts. Drives the real exports with a loopback http.Server (no mocked
 * fetch return values) and in-memory web streams / EventEmitter responses.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchWithTimeoutGuard,
  isAbortError,
  responseContentLength,
  streamResponseBodyWithByteLimit,
} from "./server-helpers-fetch.ts";

type StreamableFake = {
  write: http.ServerResponse["write"];
  once: http.ServerResponse["once"];
  off: http.ServerResponse["off"];
  removeListener: http.ServerResponse["removeListener"];
  writableEnded: boolean;
  destroyed: boolean;
  chunks: Buffer[];
  emit(event: string, ...args: unknown[]): boolean;
};

function createStreamResponse(options?: {
  writeReturns?: boolean;
  includeOff?: boolean;
  emitDrain?: boolean;
  emitError?: unknown;
}): StreamableFake {
  const emitter = new EventEmitter();
  const writeReturns = options?.writeReturns ?? true;
  const includeOff = options?.includeOff ?? true;
  const res: StreamableFake = {
    chunks: [],
    writableEnded: false,
    destroyed: false,
    write(chunk: unknown): boolean {
      res.chunks.push(Buffer.from(chunk as Uint8Array));
      if (!writeReturns && options?.emitDrain) {
        queueMicrotask(() => {
          emitter.emit("drain");
        });
      }
      if (!writeReturns && options?.emitError !== undefined) {
        queueMicrotask(() => {
          emitter.emit("error", options.emitError);
        });
      }
      return writeReturns;
    },
    once: emitter.once.bind(emitter) as StreamableFake["once"],
    off: includeOff
      ? (emitter.off.bind(emitter) as StreamableFake["off"])
      : (undefined as unknown as StreamableFake["off"]),
    removeListener: emitter.removeListener.bind(
      emitter,
    ) as StreamableFake["removeListener"],
    emit: emitter.emit.bind(emitter),
  };
  if (!includeOff) {
    // Exercise removeResponseListener's removeListener fallback.
    delete (res as { off?: unknown }).off;
  }
  return res;
}

function responseFromChunks(
  chunks: Uint8Array[],
  init?: ResponseInit,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, init);
}

function delayedChunkResponse(delayMs: number, bytes: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes);
        controller.close();
      }, delayMs);
    },
  });
  return new Response(stream);
}

const liveServers: http.Server[] = [];

async function listen(
  handler: http.RequestListener,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  liveServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

afterEach(async () => {
  await Promise.all(
    liveServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("responseContentLength", () => {
  it("returns null when the header is missing or empty", () => {
    expect(responseContentLength(new Headers())).toBeNull();
    expect(responseContentLength(new Headers({ "content-length": "" }))).toBe(
      null,
    );
  });

  it("returns null for non-numeric, negative, or non-finite values", () => {
    expect(
      responseContentLength(new Headers({ "content-length": "abc" })),
    ).toBeNull();
    expect(
      responseContentLength(new Headers({ "content-length": "-1" })),
    ).toBeNull();
    expect(
      responseContentLength(new Headers({ "content-length": "  " })),
    ).toBeNull();
    expect(
      responseContentLength(new Headers({ "content-length": "NaN" })),
    ).toBeNull();
  });

  it("parses a valid non-negative integer, including zero", () => {
    expect(responseContentLength(new Headers({ "content-length": "0" }))).toBe(
      0,
    );
    expect(
      responseContentLength(new Headers({ "content-length": "4096" })),
    ).toBe(4096);
  });

  it("uses parseInt base-10, so a trailing suffix still yields a prefix integer", () => {
    expect(
      responseContentLength(new Headers({ "content-length": "12abc" })),
    ).toBe(12);
    expect(
      responseContentLength(new Headers({ "content-length": "1.9" })),
    ).toBe(1);
  });
});

describe("isAbortError", () => {
  it("recognizes DOMException AbortError and TimeoutError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(
      true,
    );
    expect(isAbortError(new DOMException("nope", "NetworkError"))).toBe(false);
  });

  it("recognizes Error instances named AbortError or TimeoutError", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(timeout)).toBe(true);
    expect(isAbortError(new Error("plain"))).toBe(false);
  });

  it("rejects non-Error values", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError({ name: "AbortError" })).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});

describe("fetchWithTimeoutGuard", () => {
  it("returns a successful upstream response for string and URL inputs", async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-upstream");
    });

    const asString = await fetchWithTimeoutGuard(url, { method: "GET" }, 2_000);
    expect(asString.status).toBe(200);
    await expect(asString.text()).resolves.toBe("hello-upstream");

    const asUrl = await fetchWithTimeoutGuard(
      new URL("/next", url),
      { method: "GET" },
      2_000,
    );
    expect(asUrl.status).toBe(200);
    await expect(asUrl.text()).resolves.toBe("hello-upstream");
  });

  it("throws a TimeoutError when the upstream exceeds timeoutMs", async () => {
    const { url } = await listen((req, res) => {
      const handle = setTimeout(() => {
        res.end("late");
      }, 5_000);
      req.on("close", () => clearTimeout(handle));
    });

    await expect(
      fetchWithTimeoutGuard(url, { method: "GET" }, 40),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Upstream request timed out after 40ms",
    });
  });

  it("rethrows an already-aborted caller signal as an abort, not a timeout", async () => {
    const { url } = await listen((_req, res) => {
      res.end("unused");
    });
    const controller = new AbortController();
    controller.abort();

    try {
      await fetchWithTimeoutGuard(
        url,
        { method: "GET", signal: controller.signal },
        2_000,
      );
      expect.unreachable("expected abort");
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
      expect(err).not.toMatchObject({
        message: "Upstream request timed out after 2000ms",
      });
    }
  });

  it("rethrows a mid-flight caller abort as an abort, not a timeout", async () => {
    const { url } = await listen((req, res) => {
      const handle = setTimeout(() => {
        res.end("late");
      }, 5_000);
      req.on("close", () => clearTimeout(handle));
    });
    const controller = new AbortController();
    const pending = fetchWithTimeoutGuard(
      url,
      { method: "GET", signal: controller.signal },
      2_000,
    );
    queueMicrotask(() => controller.abort());

    try {
      await pending;
      expect.unreachable("expected abort");
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
      expect((err as Error).message).not.toContain(
        "Upstream request timed out",
      );
    }
  });

  it("rethrows a non-abort fetch failure unchanged", async () => {
    const { url, server } = await listen((_req, res) => {
      res.end("gone");
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const idx = liveServers.indexOf(server);
    if (idx >= 0) liveServers.splice(idx, 1);

    await expect(
      fetchWithTimeoutGuard(url, { method: "GET" }, 2_000),
    ).rejects.toSatisfy((err: unknown) => !isAbortError(err));
  });
});

describe("streamResponseBodyWithByteLimit", () => {
  it("rejects a declared Content-Length above the cap without waiting on the body", async () => {
    // A stream that never produces data: if the helper waited on reader.read()
    // this test would hang until the suite timeout instead of rejecting.
    const hanging = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue or close */
      },
    });
    const upstream = new Response(hanging, {
      headers: { "content-length": "100" },
    });
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 10),
    ).rejects.toThrow("Upstream response exceeds maximum size of 10 bytes");
    expect(res.chunks).toEqual([]);
  });

  it("allows a declared Content-Length equal to the cap", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const upstream = responseFromChunks([payload], {
      headers: { "content-length": "4" },
    });
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 4),
    ).resolves.toBe(4);
    expect(Buffer.concat(res.chunks).equals(Buffer.from(payload))).toBe(true);
  });

  it("throws when the upstream has no body stream", async () => {
    const upstream = new Response(null, { status: 204 });
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).rejects.toThrow("Upstream response did not include a body stream");
  });

  it("skips empty chunks and returns the forwarded byte count", async () => {
    const upstream = responseFromChunks([
      new Uint8Array(0),
      new Uint8Array([9, 8, 7]),
      new Uint8Array(0),
    ]);
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).resolves.toBe(3);
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from([9, 8, 7]));
  });

  it("rejects once streamed bytes overflow the cap", async () => {
    const upstream = responseFromChunks([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]);
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 4),
    ).rejects.toThrow("Upstream response exceeds maximum size of 4 bytes");
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("throws when the client connection is already ended", async () => {
    const upstream = responseFromChunks([new Uint8Array([1])]);
    const res = createStreamResponse();
    res.writableEnded = true;

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).rejects.toThrow("Client connection closed while streaming response");
    expect(res.chunks).toEqual([]);
  });

  it("throws when the client connection is destroyed", async () => {
    const upstream = responseFromChunks([new Uint8Array([1])]);
    const res = createStreamResponse();
    res.destroyed = true;

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).rejects.toThrow("Client connection closed while streaming response");
  });

  it("waits for drain when write reports backpressure, including without res.off", async () => {
    const payload = new Uint8Array([10, 20, 30]);
    const upstream = responseFromChunks([payload]);
    const res = createStreamResponse({
      writeReturns: false,
      emitDrain: true,
      includeOff: false,
    });

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).resolves.toBe(3);
    expect(Buffer.concat(res.chunks).equals(Buffer.from(payload))).toBe(true);
  });

  it("rejects waitForDrain with an Error when the socket errors", async () => {
    const upstream = responseFromChunks([new Uint8Array([1, 2])]);
    const res = createStreamResponse({
      writeReturns: false,
      emitError: new Error("socket explode"),
    });

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).rejects.toThrow("socket explode");
  });

  it("wraps a non-Error drain failure", async () => {
    const upstream = responseFromChunks([new Uint8Array([1, 2])]);
    const res = createStreamResponse({
      writeReturns: false,
      emitError: "boom",
    });

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100),
    ).rejects.toThrow("boom");
  });

  it("times out a stalled body when timeoutMs is positive", async () => {
    const upstream = delayedChunkResponse(1_000, new Uint8Array([1]));
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 100, 30),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Upstream response body timed out after 30ms",
    });
  });

  it("does not install a stream timeout when timeoutMs is 0 or omitted", async () => {
    const payload = new Uint8Array([7]);
    const delayed = delayedChunkResponse(25, payload);
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(delayed, res, 100, 0),
    ).resolves.toBe(1);

    const omitted = delayedChunkResponse(25, payload);
    const res2 = createStreamResponse();
    await expect(
      streamResponseBodyWithByteLimit(omitted, res2, 100),
    ).resolves.toBe(1);
  });

  it("keeps the original overflow error when reader.cancel fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        controller.close();
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const upstream = new Response(stream);
    const res = createStreamResponse();

    await expect(
      streamResponseBodyWithByteLimit(upstream, res, 2),
    ).rejects.toThrow("Upstream response exceeds maximum size of 2 bytes");
  });
});

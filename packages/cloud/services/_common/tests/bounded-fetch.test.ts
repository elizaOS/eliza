/** Exercises shared bounded transport cleanup with real adversarial streams and cancellation signals. */
import { describe, expect, it } from "bun:test";
import { getEventListeners } from "node:events";
import { type BoundedFetchOptions, boundedFetch } from "../src/bounded-fetch";

const options: BoundedFetchOptions = {
  timeoutMs: 50,
  maxResponseBytes: 64,
  timeoutMessage: "Deadline expired",
  cancellationMessage: "Cancelled",
  invalidBoundsError: () => new RangeError("Invalid bounds"),
  responseTooLargeError: (context) =>
    Object.assign(new Error("Too large"), { context }),
};
function transport(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

describe("boundedFetch resource ownership", () => {
  it("cancels a late response from a transport that ignores abort", async () => {
    let respond!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    let cancelled = false;
    await expect(
      boundedFetch("http://local.test", undefined, {
        ...options,
        fetchImpl: transport(() => pending),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    respond(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
  it("does not await hostile stream cancellation and removes the caller listener", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        return new Promise(() => {});
      },
    });
    const started = performance.now();
    await expect(
      boundedFetch(
        "http://local.test",
        { signal: controller.signal },
        { ...options, fetchImpl: transport(async () => new Response(body)) },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - started).toBeLessThan(800);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("honors a Request signal without dispatching when it is already cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    const request = new Request("http://local.test", {
      signal: controller.signal,
    });
    let dispatched = false;
    await expect(
      boundedFetch(request, undefined, {
        ...options,
        fetchImpl: transport(async () => {
          dispatched = true;
          return new Response();
        }),
      }),
    ).rejects.toBe(reason);
    expect(dispatched).toBe(false);
  });
  it("rejects excessive empty chunks without silently discarding stream content", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      boundedFetch("http://local.test", undefined, {
        ...options,
        maxResponseChunks: 2,
        fetchImpl: transport(async () => new Response(body)),
      }),
    ).rejects.toMatchObject({ context: { chunks: 3, maxResponseChunks: 2 } });
    expect(cancelled).toBe(true);
  });
});

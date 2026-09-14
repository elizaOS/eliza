/** Exercises shared bounded transport cleanup with real adversarial streams and cancellation signals. */
import { describe, expect, it, spyOn } from "bun:test";
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
  it("expires while uncapped ready empty chunks prevent timer callbacks", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let streamDeadline = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (performance.now() >= streamDeadline) controller.close();
        else controller.enqueue(new Uint8Array());
      },
    });
    await expect(
      boundedFetch("http://local.test", undefined, {
        ...options,
        timeoutMs: 5,
        fetchImpl: transport(async (_input, init) => {
          requestSignal = init?.signal;
          // This finite real stream outlives the hop budget without yielding
          // to timers, even on a host that can process empty chunks quickly.
          streamDeadline = performance.now() + 50;
          return new Response(body);
        }),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("lets native deadlines run when ready-body reads see a frozen Worker clock", async () => {
    const now = performance.now.bind(performance);
    const clock = spyOn(performance, "now").mockReturnValue(now());
    let requestSignal: AbortSignal | null | undefined;
    let emitted = 0;
    try {
      await expect(
        boundedFetch("http://local.test", undefined, {
          ...options,
          timeoutMs: 1,
          fetchImpl: transport(async (_input, init) => {
            requestSignal = init?.signal;
            return new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (emitted++ < 100_000) controller.enqueue(new Uint8Array());
                  else controller.close();
                },
              }),
            );
          }),
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("observes a due deadline before success when the Worker clock stayed frozen", async () => {
    const now = performance.now.bind(performance);
    const clock = spyOn(performance, "now").mockReturnValue(now());
    try {
      await expect(
        boundedFetch("http://local.test", undefined, {
          ...options,
          timeoutMs: 1,
          fetchImpl: transport(async () => {
            const releaseAt = now() + 15;
            while (now() < releaseAt) {
              // Model CPU work while the deployed Worker clock cannot advance.
            }
            return new Response(new Uint8Array([1]));
          }),
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      clock.mockRestore();
    }
  });

  it("observes caller cancellation scheduled during ready body consumption", async () => {
    const caller = new AbortController();
    const reason = new Error("caller closed during body read", {
      cause: new Error("transport consumer disconnected"),
    });
    let emitted = 0;
    let cancelReason: unknown;
    const cancelTimer = setTimeout(() => caller.abort(reason), 0);
    try {
      await expect(
        boundedFetch(
          "http://local.test",
          { signal: caller.signal },
          {
            ...options,
            timeoutMs: 2_000,
            fetchImpl: transport(
              async () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    pull(controller) {
                      if (emitted++ < 4_096)
                        controller.enqueue(new Uint8Array());
                      else controller.close();
                    },
                    cancel(error) {
                      cancelReason = error;
                    },
                  }),
                ),
            ),
          },
        ),
      ).rejects.toBe(reason);
      // If the host paused long enough for cancellation before the reader was
      // acquired, the same reason still owns the unconsumed response cleanup.
      expect(cancelReason).toBe(reason);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    } finally {
      clearTimeout(cancelTimer);
    }
  });

  it("retains every byte across task yields without imposing a chunk cap", async () => {
    const expected = Uint8Array.from(
      { length: 4_096 },
      (_, index) => index % 251,
    );
    let emitted = 0;
    const response = await boundedFetch("http://local.test", undefined, {
      ...options,
      timeoutMs: 2_000,
      maxResponseBytes: expected.byteLength,
      fetchImpl: transport(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (emitted < expected.length) {
                  controller.enqueue(new Uint8Array([expected[emitted++]]));
                } else controller.close();
              },
            }),
          ),
      ),
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  });

  it("cancels an acquired response when synchronous transport work used the budget", async () => {
    let cancelReason: unknown;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull(controller) {
        controller.close();
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    await expect(
      boundedFetch("http://local.test", undefined, {
        ...options,
        timeoutMs: 5,
        fetchImpl: transport(async (_input, init) => {
          requestSignal = init?.signal;
          const releaseAt = performance.now() + 15;
          // A finite synchronous transport pause delays the timer, while the
          // queued body remains open until the caller reads or cancels it.
          while (performance.now() < releaseAt) {
            // Keep the finite pause synchronous so the timer cannot run.
          }
          return new Response(body);
        }),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelReason).toBe(requestSignal?.reason);
    expect(body.locked).toBe(false);
  });

  it("preserves the caller error and its cause during ready body consumption", async () => {
    const caller = new AbortController();
    const cause = new Error("caller boundary closed");
    const reason = new Error("request cancelled", { cause });
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull(controller) {
        caller.abort(reason);
        controller.enqueue(new Uint8Array([2]));
      },
      cancel(error) {
        cancelReason = error;
      },
    });
    await expect(
      boundedFetch(
        "http://local.test",
        { signal: caller.signal },
        {
          ...options,
          timeoutMs: 1_000,
          fetchImpl: transport(async () => new Response(body)),
        },
      ),
    ).rejects.toBe(reason);
    expect(cancelReason).toBe(reason);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

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

/**
 * Exercises the MCP proxy's bounded body reader against declared, streamed,
 * fragmented, malformed, and teardown-failure inputs using real web streams.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __mcpProxyHopTestHooks,
  type BudgetedBodySource,
  createMcpProxyHopDeadline,
  McpProxyHopDeadlineError,
  raceWithAbort,
  readBodyTextWithinBudget,
} from "../mcp/proxy/[mcpId]/proxy-body-budget";

function source(
  body: ReadableStream<Uint8Array>,
  headers: HeadersInit = {},
): BudgetedBodySource {
  return {
    headers: new Headers(headers),
    body,
    text: async () => {
      throw new Error("stream path expected");
    },
  };
}

describe("readBodyTextWithinBudget", () => {
  test("rejects declared overflow without reading and cancels the body", async () => {
    let pulled = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(
      await readBodyTextWithinBudget(
        source(body, { "content-length": "11" }),
        10,
      ),
    ).toEqual({ ok: false, bytes: 11, reason: "byte-budget" });
    await Promise.resolve();
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("rejects streamed overflow, cancels, and releases the reader lock", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(await readBodyTextWithinBudget(source(body), 5)).toEqual({
      ok: false,
      bytes: 6,
      reason: "byte-budget",
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    const nextReader = body.getReader();
    nextReader.releaseLock();
  });

  test("decodes an exact-budget UTF-8 value split inside a code point", async () => {
    const bytes = new TextEncoder().encode("A🦊B");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.enqueue(bytes.subarray(3, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    });

    expect(
      await readBodyTextWithinBudget(source(body), bytes.byteLength),
    ).toEqual({
      ok: true,
      text: "A🦊B",
    });
  });

  test("rejects malicious tiny-chunk fragmentation without retaining chunk objects", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([97]));
      },
    });

    expect(await readBodyTextWithinBudget(source(body), 20_000)).toEqual({
      ok: false,
      bytes: 8_193,
      reason: "fragmentation-budget",
    });
    // The 8,193rd non-empty chunk trips the ceiling. Cancel may pull once
    // more while it still owns the reader; it must not keep amplifying.
    expect(pulls).toBeGreaterThanOrEqual(8_193);
    expect(pulls).toBeLessThan(8_200);
  });

  test("reports cancellation failure and still releases the lock", async () => {
    const cancelFailures = mock();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });

    await readBodyTextWithinBudget(source(body), 1, cancelFailures);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelFailures).toHaveBeenCalledWith(
      "streamed-budget",
      expect.objectContaining({ message: "cancel failed" }),
    );
    const nextReader = body.getReader();
    nextReader.releaseLock();
  });

  test("releases the reader lock when reader.read rejects", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("reader failed");
      },
    });

    await expect(readBodyTextWithinBudget(source(body), 10)).rejects.toThrow(
      "reader failed",
    );
    const nextReader = body.getReader();
    nextReader.releaseLock();
  });

  test("never-settling cancel does not delay the budget result and keeps the lock", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        return new Promise(() => {
          /* never settles */
        });
      },
    });

    const started = Date.now();
    const result = await readBodyTextWithinBudget(source(body), 1);
    expect(Date.now() - started).toBeLessThan(50);
    expect(result).toEqual({ ok: false, bytes: 2, reason: "byte-budget" });
    expect(() => body.getReader()).toThrow();
  });

  test("rejecting cancel does not replace the budget result", async () => {
    const cancelFailures = mock();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });

    const result = await readBodyTextWithinBudget(source(body), 1, {
      onCancelFailure: cancelFailures,
    });
    expect(result).toEqual({ ok: false, bytes: 2, reason: "byte-budget" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelFailures).toHaveBeenCalledWith(
      "streamed-budget",
      expect.objectContaining({ message: "cancel failed" }),
    );
  });

  test("rejects a hanging body when the hop signal aborts", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    const controller = new AbortController();
    const resultPromise = readBodyTextWithinBudget(source(body), 100, {
      signal: controller.signal,
    });
    queueMicrotask(() => {
      controller.abort(
        new DOMException("MCP proxy hop deadline exceeded", "TimeoutError"),
      );
    });
    const hung = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("reader ignored hop abort")), 80);
    });
    expect(await Promise.race([resultPromise, hung])).toEqual({
      ok: false,
      bytes: 0,
      reason: "deadline",
    });
  });

  test("a live hop signal does not alter a below-budget decode", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    });
    const controller = new AbortController();
    expect(
      await readBodyTextWithinBudget(source(body), 100, {
        signal: controller.signal,
      }),
    ).toEqual({ ok: true, text: '{"ok":true}' });
    expect(controller.signal.aborted).toBe(false);
  });

  test("already-aborted hop refuses without pulling the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
    });
    const controller = new AbortController();
    controller.abort(new McpProxyHopDeadlineError(1));
    expect(
      await readBodyTextWithinBudget(
        source(body, { "content-length": "5" }),
        10,
        { signal: controller.signal },
      ),
    ).toEqual({ ok: false, bytes: 5, reason: "deadline" });
    expect(pulled).toBe(false);
  });

  test("null-body source.text hang returns deadline without replacing a later throw", async () => {
    const hanging: BudgetedBodySource = {
      headers: new Headers(),
      body: null,
      text: () =>
        new Promise(() => {
          /* never settles */
        }),
    };
    const controller = new AbortController();
    const resultPromise = readBodyTextWithinBudget(hanging, 100, {
      signal: controller.signal,
    });
    queueMicrotask(() => {
      controller.abort(new McpProxyHopDeadlineError(1));
    });
    expect(await resultPromise).toEqual({
      ok: false,
      bytes: 0,
      reason: "deadline",
    });
  });

  test("composed caller abort fails a hanging read as deadline", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    const caller = new AbortController();
    const hop = createMcpProxyHopDeadline(caller.signal);
    const resultPromise = readBodyTextWithinBudget(source(body), 100, {
      signal: hop.signal,
    });
    queueMicrotask(() => {
      caller.abort(new Error("caller canceled"));
    });
    expect(await resultPromise).toEqual({
      ok: false,
      bytes: 0,
      reason: "deadline",
    });
    hop.clear();
  });
});

describe("createMcpProxyHopDeadline", () => {
  afterEach(() => {
    __mcpProxyHopTestHooks.resetHopTimeoutMs();
  });

  test("clear() prevents the timer from aborting a completed hop", async () => {
    __mcpProxyHopTestHooks.setHopTimeoutMs(20);
    const hop = createMcpProxyHopDeadline();
    hop.clear();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hop.signal.aborted).toBe(false);
  });

  test("fires a typed deadline error after the configured timeout", async () => {
    __mcpProxyHopTestHooks.setHopTimeoutMs(20);
    const hop = createMcpProxyHopDeadline();
    await new Promise((resolve) => {
      hop.signal.addEventListener("abort", resolve, { once: true });
    });
    expect(hop.signal.reason).toBeInstanceOf(McpProxyHopDeadlineError);
    hop.clear();
  });

  test("an already-aborted caller is returned without starting a timer", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller"));
    const hop = createMcpProxyHopDeadline(caller.signal);
    expect(hop.signal.aborted).toBe(true);
    expect(hop.signal).toBe(caller.signal);
    hop.clear();
  });
});

describe("raceWithAbort", () => {
  test("returns when the underlying promise never settles and the hop aborts", async () => {
    const controller = new AbortController();
    const pending = raceWithAbort(
      new Promise<never>(() => {
        /* never settles — DNS / prevalidation hang */
      }),
      controller.signal,
    );
    queueMicrotask(() => {
      controller.abort(new McpProxyHopDeadlineError(20));
    });
    const hung = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("raceWithAbort ignored abort")), 80);
    });
    await expect(Promise.race([pending, hung])).rejects.toBeInstanceOf(
      McpProxyHopDeadlineError,
    );
  });
});

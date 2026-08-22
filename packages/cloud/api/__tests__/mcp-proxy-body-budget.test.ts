/**
 * Exercises the MCP proxy's bounded body reader against declared, streamed,
 * fragmented, malformed, and teardown-failure inputs using real web streams.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  type BudgetedBodySource,
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
    expect(pulls).toBe(8_193);
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
});

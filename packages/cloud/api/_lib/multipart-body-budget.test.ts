/**
 * Deterministic unit tests for the import-free multipart byte-budget reader.
 *
 * The harness drives real WHATWG Requests and ReadableStreams: declared-length
 * precheck, streamed overflow, malformed content-length, one-byte
 * fragmentation, slab growth, hung bodies, client abort, cancel reporting, and reader-lock
 * ownership. Nothing here reaches Hono, R2, or Postgres.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  MULTIPART_SLAB_FLOOR_BYTES,
  parseTrustworthyContentLength,
  readRequestWithinMultipartBudget,
} from "./multipart-body-budget";

const BUDGET = 64;
const URL = "https://cloud.test/upload";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function streamRequest(
  chunks: readonly Uint8Array[],
  headers: HeadersInit = {},
  options: {
    onCancel?: () => void | Promise<void>;
    signal?: AbortSignal;
    hang?: boolean;
    failWith?: Error;
    leaveOpen?: boolean;
  } = {},
): { request: Request; stream: ReadableStream<Uint8Array> } {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      return options.onCancel?.();
    },
    pull(controller) {
      if (options.failWith) {
        controller.error(options.failWith);
        return;
      }
      if (options.hang) {
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      // A still-open upload is the hostile case: closing here races Bun's
      // Request-body prefetch and makes reader.cancel() a no-op.
      if (!options.leaveOpen) {
        controller.close();
      }
    },
  });
  return {
    stream,
    request: new Request(URL, {
      body: stream,
      headers,
      method: "POST",
      signal: options.signal,
    }),
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("parseTrustworthyContentLength", () => {
  const cases: Array<[string | null, number | null]> = [
    [null, null],
    ["", null],
    ["abc", null],
    ["0x400", null],
    ["-1", null],
    ["12.5", null],
    ["99999999999999999999", null],
    ["0", 0],
    ["64", 64],
    [" 7 ", 7],
  ];

  for (const [header, expected] of cases) {
    test(`maps ${JSON.stringify(header)} to ${String(expected)}`, () => {
      const headers = new Headers();
      if (header !== null) headers.set("content-length", header);
      const request = new Request(URL, { headers, method: "POST" });
      expect(parseTrustworthyContentLength(request)).toBe(expected);
    });
  }
});

describe("readRequestWithinMultipartBudget", () => {
  test("refuses a declared length over budget without pulling the body", async () => {
    const onCancel = mock(() => undefined);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(bytes(1, 2, 3, 4));
      },
    });
    const request = new Request(URL, {
      body: stream,
      headers: { "content-length": String(BUDGET + 1) },
      method: "POST",
    });

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: BUDGET + 1,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBe(0);
  });

  test("cancels a chunked body as soon as retained bytes would exceed the budget", async () => {
    const onCancel = mock(() => undefined);
    const { request } = streamRequest(
      [new Uint8Array(40), new Uint8Array(40)],
      {},
      { leaveOpen: true, onCancel },
    );

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: 80,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("still streams when a trustworthy content-length is under budget", async () => {
    const onCancel = mock(() => undefined);
    const { request } = streamRequest(
      [new Uint8Array(40), new Uint8Array(40)],
      { "content-length": "1" },
      { leaveOpen: true, onCancel },
    );

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: 80,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("accepts malformed content-length headers on an in-budget body", async () => {
    const payload = bytes(9, 8, 7, 6);
    for (const header of ["abc", "0x400", "-1", "99999999999999999999", ""]) {
      const { request } = streamRequest([payload], {
        "content-length": header,
      });
      const result = await readRequestWithinMultipartBudget(request, BUDGET);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.request.headers.has("content-length")).toBe(false);
      expect(
        Array.from(new Uint8Array(await result.request.arrayBuffer())),
      ).toEqual(Array.from(payload));
    }
  });

  test("strips content-length from a successful buffered request", async () => {
    const payload = bytes(1, 2, 3);
    const { request } = streamRequest([payload], {
      "content-length": "3",
      "content-type": "multipart/form-data; boundary=x",
    });

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.request.headers.get("content-type")).toBe(
      "multipart/form-data; boundary=x",
    );
    expect(result.request.headers.has("content-length")).toBe(false);
    expect(
      Array.from(new Uint8Array(await result.request.arrayBuffer())),
    ).toEqual(Array.from(payload));
  });

  test("retains a hostile one-byte stream in one slab and accepts exactly the budget", async () => {
    const chunks = Array.from({ length: BUDGET }, () => bytes(7));
    const { request, stream } = streamRequest(chunks);

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const body = new Uint8Array(await result.request.arrayBuffer());
    expect(body.byteLength).toBe(BUDGET);
    expect(body.every((value) => value === 7)).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("grows past the initial slab and keeps an in-budget body intact", async () => {
    const chunkCount = 24;
    const chunkSize = 4096;
    const total = chunkCount * chunkSize;
    // No trustworthy declared length, so the slab starts at the floor and has
    // to grow at least once before the whole body fits.
    expect(total).toBeGreaterThan(MULTIPART_SLAB_FLOOR_BYTES);
    const chunks = Array.from({ length: chunkCount }, (_unused, index) =>
      new Uint8Array(chunkSize).fill(index + 1),
    );
    const { request, stream } = streamRequest(chunks);

    const result = await readRequestWithinMultipartBudget(request, total * 4);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const body = new Uint8Array(await result.request.arrayBuffer());
    expect(body.byteLength).toBe(total);
    for (let index = 0; index < chunkCount; index += 1) {
      const slice = body.subarray(index * chunkSize, (index + 1) * chunkSize);
      expect(slice.every((value) => value === index + 1)).toBe(true);
    }
    expect(stream.locked).toBe(false);
  });

  test("grows past an understated content-length seed without losing bytes", async () => {
    const chunks = [bytes(1, 2, 3, 4), bytes(5, 6, 7, 8), bytes(9)];
    const { request } = streamRequest(chunks, { "content-length": "2" });

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(
      Array.from(new Uint8Array(await result.request.arrayBuffer())),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("charges a one-byte overflow before retaining the over-budget byte", async () => {
    const onCancel = mock(() => undefined);
    const chunks = [
      ...Array.from({ length: BUDGET }, () => bytes(1)),
      bytes(1),
    ];
    const { request } = streamRequest(
      chunks,
      {},
      { leaveOpen: true, onCancel },
    );

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: BUDGET + 1,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("releases the reader lock on success", async () => {
    const { request, stream } = streamRequest([bytes(1, 2, 3)]);

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result.ok).toBe(true);
    expect(stream.locked).toBe(false);
  });

  test("releases the reader lock only after detached cancel settles", async () => {
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const onCancel = mock(() => cancelGate);
    const { request, stream } = streamRequest(
      [new Uint8Array(BUDGET + 1)],
      {},
      { leaveOpen: true, onCancel },
    );

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: BUDGET + 1,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(true);
    releaseCancel?.();
    await waitUntil(() => stream.locked === false);
    expect(stream.locked).toBe(false);
  });

  test("reports a rejecting cancel without throwing out of the reader", async () => {
    const onCancelFailure = mock<(label: string, error: unknown) => void>(
      () => undefined,
    );
    const { request } = streamRequest(
      [new Uint8Array(BUDGET + 1)],
      {},
      {
        leaveOpen: true,
        onCancel: async () => {
          throw new Error("cancel exploded");
        },
      },
    );

    const result = await readRequestWithinMultipartBudget(
      request,
      BUDGET,
      onCancelFailure,
    );

    expect(result.ok).toBe(false);
    await waitUntil(() => onCancelFailure.mock.calls.length === 1);
    expect(onCancelFailure).toHaveBeenCalledTimes(1);
    expect(onCancelFailure.mock.calls[0]?.[0]).toBe("streamed-budget");
    expect(onCancelFailure.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  test("swallows a throwing cancel reporter", async () => {
    const { request } = streamRequest(
      [new Uint8Array(BUDGET + 1)],
      {},
      {
        leaveOpen: true,
        onCancel: async () => {
          throw new Error("cancel exploded");
        },
      },
    );

    const result = await readRequestWithinMultipartBudget(
      request,
      BUDGET,
      () => {
        throw new Error("reporter exploded");
      },
    );

    expect(result).toEqual({
      ok: false,
      outcome: "oversized",
      bytes: BUDGET + 1,
    });
  });

  test("abandons a hung body at the owned deadline", async () => {
    const onCancel = mock(() => undefined);
    const { request, stream } = streamRequest([], {}, { hang: true, onCancel });

    const result = await readRequestWithinMultipartBudget(
      request,
      BUDGET,
      undefined,
      { timeoutMs: 50 },
    );

    expect(result).toEqual({
      ok: false,
      outcome: "incomplete",
      reason: "deadline",
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitUntil(() => stream.locked === false);
    expect(stream.locked).toBe(false);
  });

  test("returns client-aborted when the Worker request signal is already aborted", async () => {
    const onCancel = mock(() => undefined);
    const controller = new AbortController();
    const { request } = streamRequest(
      [],
      {},
      {
        hang: true,
        onCancel,
        signal: controller.signal,
      },
    );
    controller.abort();

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result).toEqual({
      ok: false,
      outcome: "incomplete",
      reason: "client-aborted",
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("returns client-aborted when the request signal fires mid-read", async () => {
    const onCancel = mock(() => undefined);
    const controller = new AbortController();
    const { request } = streamRequest(
      [],
      {},
      {
        hang: true,
        onCancel,
        signal: controller.signal,
      },
    );

    const pending = readRequestWithinMultipartBudget(
      request,
      BUDGET,
      undefined,
      { timeoutMs: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      outcome: "incomplete",
      reason: "client-aborted",
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("maps a stream error to an incomplete read-failed outcome", async () => {
    const boom = new Error("stream exploded");
    const { request } = streamRequest([], {}, { failWith: boom });

    const result = await readRequestWithinMultipartBudget(request, BUDGET);

    expect(result.ok).toBe(false);
    if (result.ok || result.outcome !== "incomplete") {
      throw new Error("expected incomplete");
    }
    expect(result.reason).toBe("read-failed");
    expect(result.error).toBe(boom);
  });
});

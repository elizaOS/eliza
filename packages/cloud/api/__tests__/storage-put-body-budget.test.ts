/**
 * Regression coverage for the storage PUT byte budget.
 *
 * The budget guard only means anything if it is charged BEFORE the request
 * body is retained, so these cases assert on what the body stream was asked
 * for — pulls taken, cancellation issued — and not merely on the status code.
 * The route half drives the real Hono router from
 * `v1/apis/storage/objects/[...key]/route.ts` so the 400/413/201 contract is
 * exercised end to end; the helper half pins `readRequestBodyWithinBudget`'s
 * own semantics (untrustworthy `content-length`, exact limit, empty body,
 * cancellation failure reporting) at a small budget.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021045";
const ROUTE_PREFIX = "/api/v1/apis/storage/objects";
const ROUTE_MOUNT = `${ROUTE_PREFIX}/:*{.+}`;
const OBJECT_PATH = "uploads/blob.bin";
// Mirrors MAX_PUT_BYTES in the route under test.
const MAX_PUT_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 10 * 1024 * 1024;

const requireUserOrApiKeyWithOrg = mock();
const getServiceMethodCost = mock();
const deductCredits = mock();
const executeNativeStoragePut = mock();
const executeNativeStorageDelete = mock();
const resolveNativeStorageObject = mock();
const executeNativeStorageGetOrHead = mock();
const loggerError = mock();
const loggerWarn = mock();
const failureResponse = mock((_context: unknown, error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : "Unexpected test error" },
    { status: 500 },
  ),
);
class TestStoragePutConflictError extends Error {}
class TestStorageQuotaExceededError extends Error {}
class TestInsufficientCreditsError extends Error {}
class TestNativeStoragePutError extends Error {}
class TestNativeStorageReadError extends Error {}

mock.module("@/db/repositories", () => ({
  StoragePutConflictError: TestStoragePutConflictError,
  StorageQuotaExceededError: TestStorageQuotaExceededError,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits },
  InsufficientCreditsError: TestInsufficientCreditsError,
}));

mock.module("@/lib/services/storage/native-storage-put", () => ({
  calculateStoragePutPrice: (flat: number, perByte: number, bytes: number) =>
    Number((flat + perByte * bytes).toFixed(6)),
  executeNativeStoragePut,
  executeNativeStorageDelete,
  resolveNativeStorageObject,
  NativeStoragePutError: TestNativeStoragePutError,
}));

mock.module("@/lib/services/storage/native-storage-read", () => ({
  executeNativeStorageGetOrHead,
  NativeStorageReadError: TestNativeStorageReadError,
}));

mock.module("@/lib/services/proxy/pricing", () => ({
  getServiceMethodCost,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError, warn: loggerWarn },
}));

const storageObjectsRoute = (
  await import("../v1/apis/storage/objects/[...key]/route")
).default;
const { parseTrustworthyContentLength, readRequestBodyWithinBudget } =
  await import("../v1/apis/storage/objects/[...key]/put-body-budget");

const app = new Hono();
app.route(ROUTE_MOUNT, storageObjectsRoute);

interface ChunkedSource {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
}

/**
 * A lazily-pulled body. `available` is deliberately far larger than the budget
 * so a reader that does not stop early would have to materialize gigabytes:
 * the pull counter is the assertion that it stopped.
 */
function chunkedBody(
  chunkBytes: number,
  available: number,
  options: { cancelThrows?: boolean } = {},
): ChunkedSource {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls >= available) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
        if (options.cancelThrows) {
          throw new Error("cancel refused");
        }
      },
    },
    // High-water mark 0 removes the stream's own read-ahead, so a pull counts
    // one read the budget actually asked for and nothing else.
    { highWaterMark: 0 },
  );
  return { body, pulls: () => pulls, cancelled: () => cancelled };
}

function putRequest(init: {
  body?: BodyInit | null;
  contentLength?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "idempotency-key": "budget-upload-1",
    "X-Storage-Object-Key": OBJECT_PATH,
  };
  if (init.contentLength !== undefined) {
    headers["content-length"] = init.contentLength;
  }
  return new Request(`http://cloud.test${ROUTE_PREFIX}/_`, {
    method: "PUT",
    headers,
    body: init.body ?? null,
    // Required by undici/workerd semantics for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function bucket() {
  return { head: mock(), get: mock(), put: mock(), delete: mock() };
}

/** `Response.json()` is typed `Promise<undefined>` here; widen it once. */
async function jsonBody(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getServiceMethodCost.mockReset();
  deductCredits.mockReset();
  executeNativeStoragePut.mockReset();
  loggerError.mockReset();
  loggerWarn.mockReset();
  failureResponse.mockClear();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
    id: "00000000-0000-4000-8000-000000021046",
  });
  getServiceMethodCost.mockResolvedValue(0.01);
  executeNativeStoragePut.mockResolvedValue({
    key: OBJECT_PATH,
    size: 1,
    contentType: "application/octet-stream",
    etag: "native-etag",
  });
});

describe("storage PUT byte budget (production route)", () => {
  test("refuses a declared oversize body with 413 before pulling a byte", async () => {
    const source = chunkedBody(CHUNK_BYTES, 1024);

    const response = await app.request(
      putRequest({
        body: source.body,
        contentLength: String(MAX_PUT_BYTES + 1),
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(413);
    expect(await jsonBody(response)).toEqual({
      error: `Object exceeds ${MAX_PUT_BYTES} byte limit (${MAX_PUT_BYTES + 1})`,
    });
    expect(source.pulls()).toBe(0);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("cuts an undeclared stream off at the first over-budget chunk", async () => {
    const source = chunkedBody(CHUNK_BYTES, 1024);

    const response = await app.request(
      putRequest({ body: source.body }),
      undefined,
      { BLOB: bucket() },
    );

    // Six 10 MiB chunks is the first running total past the 50 MiB budget.
    expect(response.status).toBe(413);
    expect(await jsonBody(response)).toEqual({
      error: `Object exceeds ${MAX_PUT_BYTES} byte limit (${CHUNK_BYTES * 6})`,
    });
    expect(source.pulls()).toBe(6);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("cuts an under-declared stream off at the first over-budget chunk", async () => {
    const source = chunkedBody(CHUNK_BYTES, 1024);

    const response = await app.request(
      putRequest({ body: source.body, contentLength: "1024" }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(413);
    expect(await jsonBody(response)).toEqual({
      error: `Object exceeds ${MAX_PUT_BYTES} byte limit (${CHUNK_BYTES * 6})`,
    });
    expect(source.pulls()).toBe(6);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("accepts a body of exactly the budget and stores every byte", async () => {
    getServiceMethodCost.mockResolvedValueOnce(0.25).mockResolvedValueOnce(0);
    executeNativeStoragePut.mockResolvedValue({
      key: OBJECT_PATH,
      size: MAX_PUT_BYTES,
      contentType: "application/octet-stream",
      etag: "native-etag",
    });

    const response = await app.request(
      putRequest({ body: new Uint8Array(MAX_PUT_BYTES) }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(201);
    expect(executeNativeStoragePut).toHaveBeenCalledTimes(1);
    const call = executeNativeStoragePut.mock.calls[0]?.[0] as {
      body: ArrayBuffer;
    };
    expect(call.body.byteLength).toBe(MAX_PUT_BYTES);
  });

  test("still answers an empty body with the unchanged 400 contract", async () => {
    const response = await app.request(putRequest({ body: null }), undefined, {
      BLOB: bucket(),
    });

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "Request body is required",
    });
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("logs a failed body cancellation without changing the 413", async () => {
    const source = chunkedBody(CHUNK_BYTES, 1024, { cancelThrows: true });

    const response = await app.request(
      putRequest({
        body: source.body,
        contentLength: String(MAX_PUT_BYTES + 1),
      }),
      undefined,
      { BLOB: bucket() },
    );
    await flushMicrotasks();

    expect(response.status).toBe(413);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[storage proxy] failed to cancel oversized PUT body",
      expect.objectContaining({ label: "content-length-precheck" }),
    );
  });
});

describe("readRequestBodyWithinBudget", () => {
  function helperRequest(init: {
    body?: BodyInit | null;
    contentLength?: string;
  }): Request {
    const headers: Record<string, string> = {};
    if (init.contentLength !== undefined) {
      headers["content-length"] = init.contentLength;
    }
    return new Request("http://cloud.test/helper", {
      method: "PUT",
      headers,
      body: init.body ?? null,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  test("treats only a plain safe decimal content-length as trustworthy", () => {
    expect(parseTrustworthyContentLength(helperRequest({}))).toBeNull();
    expect(
      parseTrustworthyContentLength(helperRequest({ contentLength: "0" })),
    ).toBe(0);
    expect(
      parseTrustworthyContentLength(helperRequest({ contentLength: "  42  " })),
    ).toBe(42);
    for (const untrustworthy of ["abc", "1e3", "0x10", "12.5", "-1", "+7"]) {
      expect(
        parseTrustworthyContentLength(
          helperRequest({ contentLength: untrustworthy }),
        ),
      ).toBeNull();
    }
    expect(
      parseTrustworthyContentLength(
        helperRequest({ contentLength: "99999999999999999999" }),
      ),
    ).toBeNull();
  });

  test("refuses a declared oversize body on the declared size, unread", async () => {
    const source = chunkedBody(8, 1024);

    const result = await readRequestBodyWithinBudget(
      helperRequest({ body: source.body, contentLength: "64" }),
      16,
    );

    expect(result).toEqual({ ok: false, bytes: 64 });
    expect(source.pulls()).toBe(0);
    expect(source.cancelled()).toBe(true);
  });

  test("accepts a body of exactly the budget", async () => {
    const result = await readRequestBodyWithinBudget(
      helperRequest({ body: new Uint8Array(16) }),
      16,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an accepted body");
    expect(result.body.byteLength).toBe(16);
  });

  test("refuses one byte past the budget on the running total", async () => {
    const result = await readRequestBodyWithinBudget(
      helperRequest({ body: new Uint8Array(17) }),
      16,
    );

    expect(result).toEqual({ ok: false, bytes: 17 });
  });

  test("preserves an empty body as an accepted zero-byte read", async () => {
    const result = await readRequestBodyWithinBudget(helperRequest({}), 16);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an accepted body");
    expect(result.body.byteLength).toBe(0);
  });

  test("reassembles a multi-chunk body inside the budget in order", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });

    const result = await readRequestBodyWithinBudget(
      helperRequest({ body }),
      16,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an accepted body");
    expect([...new Uint8Array(result.body)]).toEqual([1, 2, 3, 4, 5]);
  });

  test("reports a streamed cancellation failure and still refuses", async () => {
    const source = chunkedBody(8, 1024, { cancelThrows: true });
    const failures: Array<[string, unknown]> = [];

    const result = await readRequestBodyWithinBudget(
      helperRequest({ body: source.body }),
      16,
      (label, error) => {
        failures.push([label, error]);
      },
    );
    await flushMicrotasks();

    expect(result.ok).toBe(false);
    expect(failures.map(([label]) => label)).toEqual(["streamed-budget"]);
  });
});

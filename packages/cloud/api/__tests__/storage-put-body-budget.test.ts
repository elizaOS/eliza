/**
 * Regression coverage for storage PUT declared-length trust and cancel lifecycle.
 *
 * After develop started streaming PUTs to R2, the Worker must not accumulate
 * chunks. These cases mount the real Hono router from
 * `v1/apis/storage/objects/[...key]/route.ts` and drive bodies whose
 * `ReadableStream` counts pulls at `highWaterMark: 0`, so the assertions are
 * about what the route actually asked for: untrusted length headers are refused
 * unread, a tiny-chunk body is forwarded as a stream, and a cancel that never
 * settles or rejects still answers 411/400. The helper half pins decimal
 * parsing and finally-based cancel/release ordering.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021045";
const ROUTE_PREFIX = "/api/v1/apis/storage/objects";
const ROUTE_MOUNT = `${ROUTE_PREFIX}/:*{.+}`;
const OBJECT_PATH = "uploads/blob.bin";
const OBJECT_SHA256 = "a".repeat(64);

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
const {
  cancelBestEffort,
  parseTrustworthyContentLength,
  parseTrustworthyDecimalInteger,
} = await import("../v1/apis/storage/objects/[...key]/put-body-budget");

const app = new Hono();
app.route(ROUTE_MOUNT, storageObjectsRoute);

interface ChunkedSource {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
}

function chunkedBody(
  chunkBytes: number,
  available: number,
  options: {
    cancelThrows?: boolean;
    cancelRejects?: boolean;
    cancelNever?: boolean;
  } = {},
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
        if (options.cancelNever) {
          return new Promise(() => {
            /* never settles */
          });
        }
        if (options.cancelRejects) {
          return Promise.reject(new Error("cancel refused"));
        }
        if (options.cancelThrows) {
          throw new Error("cancel refused");
        }
        return undefined;
      },
    },
    // High-water mark 0 removes the stream's own read-ahead, so a pull counts
    // one read the route actually asked for and nothing else.
    { highWaterMark: 0 },
  );
  return { body, pulls: () => pulls, cancelled: () => cancelled };
}

function putRequest(init: {
  body?: BodyInit | null;
  contentLength?: string;
  xContentLength?: string;
  sha256?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "idempotency-key": "budget-upload-1",
    "X-Storage-Object-Key": OBJECT_PATH,
  };
  if (init.contentLength !== undefined) {
    headers["content-length"] = init.contentLength;
  }
  if (init.xContentLength !== undefined) {
    headers["x-content-length"] = init.xContentLength;
  }
  if (init.sha256 !== undefined) {
    headers["X-Content-SHA256"] = init.sha256;
  }
  return new Request(`http://cloud.test${ROUTE_PREFIX}/_`, {
    method: "PUT",
    headers,
    body: init.body ?? null,
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
  await Promise.resolve();
  await Promise.resolve();
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

describe("storage PUT declared-length trust (production route)", () => {
  test("refuses an untrustworthy X-Content-Length with 411 before pulling a byte", async () => {
    const source = chunkedBody(1, 1024);

    const response = await app.request(
      putRequest({
        body: source.body,
        xContentLength: "1e3",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(411);
    expect(await jsonBody(response)).toEqual({
      error: "A positive X-Content-Length header is required",
    });
    expect(source.pulls()).toBe(0);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
  });

  test("refuses hex and signed X-Content-Length forms unread", async () => {
    for (const untrustworthy of ["0x10", "+7", "12.5", "-1", "abc"]) {
      const source = chunkedBody(1, 64);
      const response = await app.request(
        putRequest({
          body: source.body,
          xContentLength: untrustworthy,
          sha256: OBJECT_SHA256,
        }),
        undefined,
        { BLOB: bucket() },
      );
      expect(response.status).toBe(411);
      expect(source.pulls()).toBe(0);
      expect(source.cancelled()).toBe(true);
      expect(executeNativeStoragePut).not.toHaveBeenCalled();
    }
  });

  test("refuses an untrustworthy Content-Length even when X-Content-Length is a matching Number()", async () => {
    const source = chunkedBody(1, 1024);

    const response = await app.request(
      putRequest({
        body: source.body,
        contentLength: "1e3",
        xContentLength: "1000",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "Content-Length does not match X-Content-Length",
    });
    expect(source.pulls()).toBe(0);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("forwards a tiny-chunk body as a stream without pulling it", async () => {
    const source = chunkedBody(1, 64);
    getServiceMethodCost.mockResolvedValueOnce(0.25).mockResolvedValueOnce(0);
    executeNativeStoragePut.mockResolvedValue({
      key: OBJECT_PATH,
      size: 8,
      contentType: "application/octet-stream",
      etag: "native-etag",
    });

    const response = await app.request(
      putRequest({
        body: source.body,
        xContentLength: "8",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(201);
    expect(source.pulls()).toBe(0);
    expect(source.cancelled()).toBe(false);
    expect(executeNativeStoragePut).toHaveBeenCalledTimes(1);
    const call = executeNativeStoragePut.mock.calls[0]?.[0] as {
      body: unknown;
      sizeBytes: number;
    };
    expect(call.body).toBeInstanceOf(ReadableStream);
    expect(call.sizeBytes).toBe(8);
    expect(call.body).toBe(source.body);
  });

  test("still answers a missing body with the unchanged 400 contract", async () => {
    const response = await app.request(
      putRequest({
        body: null,
        xContentLength: "1",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "Request body is required",
    });
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("a never-settling cancel still answers 411", async () => {
    const source = chunkedBody(1, 1024, { cancelNever: true });

    const response = await app.request(
      putRequest({
        body: source.body,
        xContentLength: "1e3",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );

    expect(response.status).toBe(411);
    expect(source.cancelled()).toBe(true);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("a rejecting cancel still answers 411 and logs the failure", async () => {
    const source = chunkedBody(1, 1024, { cancelRejects: true });

    const response = await app.request(
      putRequest({
        body: source.body,
        xContentLength: "0x10",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );
    await flushMicrotasks();

    expect(response.status).toBe(411);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[storage proxy] failed to cancel rejected PUT body",
      expect.objectContaining({ label: "x-content-length" }),
    );
  });

  test("a synchronous cancel throw still answers 400 on length mismatch", async () => {
    const source = chunkedBody(1, 1024, { cancelThrows: true });

    const response = await app.request(
      putRequest({
        body: source.body,
        contentLength: "4",
        xContentLength: "5",
        sha256: OBJECT_SHA256,
      }),
      undefined,
      { BLOB: bucket() },
    );
    await flushMicrotasks();

    expect(response.status).toBe(400);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[storage proxy] failed to cancel rejected PUT body",
      expect.objectContaining({ label: "content-length-mismatch" }),
    );
  });
});

describe("put-body-budget helpers", () => {
  function helperRequest(init: { contentLength?: string }): Request {
    const headers: Record<string, string> = {};
    if (init.contentLength !== undefined) {
      headers["content-length"] = init.contentLength;
    }
    return new Request("http://cloud.test/helper", {
      method: "PUT",
      headers,
    });
  }

  test("treats only a plain safe decimal as trustworthy", () => {
    expect(parseTrustworthyDecimalInteger(undefined)).toBeNull();
    expect(parseTrustworthyDecimalInteger(null)).toBeNull();
    expect(parseTrustworthyDecimalInteger("")).toBeNull();
    expect(parseTrustworthyDecimalInteger("0")).toBe(0);
    expect(parseTrustworthyDecimalInteger("  42  ")).toBe(42);
    expect(parseTrustworthyContentLength(helperRequest({}))).toBeNull();
    expect(
      parseTrustworthyContentLength(helperRequest({ contentLength: "0" })),
    ).toBe(0);
    for (const untrustworthy of ["abc", "1e3", "0x10", "12.5", "-1", "+7"]) {
      expect(parseTrustworthyDecimalInteger(untrustworthy)).toBeNull();
      expect(
        parseTrustworthyContentLength(
          helperRequest({ contentLength: untrustworthy }),
        ),
      ).toBeNull();
    }
    expect(parseTrustworthyDecimalInteger("99999999999999999999")).toBeNull();
  });

  test("releases a reader lock only after cancel settles", async () => {
    const order: string[] = [];
    let releasedBeforeCancelSettled = false;
    let cancelSettled = false;
    const reader = {
      cancel: async () => {
        order.push("cancel-start");
        await Promise.resolve();
        cancelSettled = true;
        order.push("cancel-settled");
      },
      releaseLock: () => {
        if (!cancelSettled) releasedBeforeCancelSettled = true;
        order.push("release");
      },
    };

    cancelBestEffort(reader, "lock-order");
    await flushMicrotasks();

    expect(releasedBeforeCancelSettled).toBe(false);
    expect(order).toEqual(["cancel-start", "cancel-settled", "release"]);
  });

  test("still releases after a rejecting cancel and reports the failure", async () => {
    const failures: Array<[string, unknown]> = [];
    let released = false;
    const reader = {
      cancel: async () => {
        throw new Error("cancel refused");
      },
      releaseLock: () => {
        released = true;
      },
    };

    cancelBestEffort(reader, "reject-cancel", (label, error) => {
      failures.push([label, error]);
    });
    await flushMicrotasks();

    expect(released).toBe(true);
    expect(failures.map(([label]) => label)).toEqual(["reject-cancel"]);
  });

  test("does not release while cancel never settles", async () => {
    let released = false;
    const reader = {
      cancel: () =>
        new Promise<void>(() => {
          /* never settles */
        }),
      releaseLock: () => {
        released = true;
      },
    };

    cancelBestEffort(reader, "never-cancel");
    await flushMicrotasks();

    expect(released).toBe(false);
  });

  test("releases after a synchronous cancel throw", async () => {
    const failures: Array<[string, unknown]> = [];
    let released = false;
    const reader = {
      cancel: () => {
        throw new Error("cancel refused");
      },
      releaseLock: () => {
        released = true;
      },
    };

    cancelBestEffort(reader, "sync-cancel", (label, error) => {
      failures.push([label, error]);
    });

    expect(released).toBe(true);
    expect(failures.map(([label]) => label)).toEqual(["sync-cancel"]);
  });
});

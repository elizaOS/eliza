/**
 * Deterministic transport tests for the local Docker bridge boundary: the
 * canonical SSRF guard, independent timeout/caller cancellation, pre-aborted
 * zero dispatch, redirect and status rejection, detached body disposal that a
 * hostile never-settling or rejecting cancel cannot pin, and request/response
 * byte limits. The global fetch is stubbed and restored after every test.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { sandboxBridgeFetch } from "./local-docker-sandbox-provider";

const BRIDGE_URL = "http://127.0.0.1:30001/bridge";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function abortableHungFetch(): typeof fetch {
  return mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      }),
  ) as typeof fetch;
}

describe("sandboxBridgeFetch", () => {
  test("times out even when the caller signal has not aborted", async () => {
    globalThis.fetch = abortableHungFetch();
    const controller = new AbortController();

    await expect(
      sandboxBridgeFetch(BRIDGE_URL, { signal: controller.signal }, 25),
    ).rejects.toMatchObject({ code: "LOCAL_SANDBOX_BRIDGE_FETCH_FAILED" });
    expect(controller.signal.aborted).toBe(false);
  });

  test("aborts immediately when the caller cancels", async () => {
    globalThis.fetch = abortableHungFetch();
    const controller = new AbortController();
    const pending = sandboxBridgeFetch(BRIDGE_URL, { signal: controller.signal }, 10_000);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "LOCAL_SANDBOX_BRIDGE_FETCH_FAILED" });
  });

  test("rejects redirects and disposes their response body", async () => {
    let cancelled = false;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: "http://127.0.0.1:30002/elsewhere" } },
      );
    }) as typeof fetch;

    await expect(sandboxBridgeFetch(BRIDGE_URL)).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_FETCH_FAILED",
    });
    expect(cancelled).toBe(true);
  });

  test("fails non-2xx responses and disposes their body", async () => {
    let cancelled = false;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    ) as typeof fetch;

    await expect(sandboxBridgeFetch(BRIDGE_URL)).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_HTTP_ERROR",
      context: { status: 503 },
    });
    expect(cancelled).toBe(true);
  });

  test("does not dispatch when the caller signal is already aborted", async () => {
    const fetchMock = mock(async () => new Response("ok"));
    globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(
      sandboxBridgeFetch(BRIDGE_URL, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "LOCAL_SANDBOX_BRIDGE_FETCH_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces the HTTP error immediately when body cancellation never settles", async () => {
    let cancelCalls = 0;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelCalls += 1;
              return new Promise<void>(() => {});
            },
          }),
          { status: 502 },
        ),
    ) as typeof fetch;

    const started = Date.now();
    await expect(sandboxBridgeFetch(BRIDGE_URL, {}, 10_000)).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_HTTP_ERROR",
      context: { status: 502 },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(cancelCalls).toBe(1);
  });

  test("keeps the redirect rejection when body cancellation rejects", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              return Promise.reject(new Error("hostile cancel"));
            },
          }),
          { status: 302, headers: { location: "http://127.0.0.1:30002/elsewhere" } },
        ),
    ) as typeof fetch;

    await expect(sandboxBridgeFetch(BRIDGE_URL)).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_FETCH_FAILED",
    });
  });

  test("surfaces the size error immediately when stream cancellation never settles", async () => {
    let cancelCalls = 0;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelCalls += 1;
              return new Promise<void>(() => {});
            },
          }),
        ),
    ) as typeof fetch;

    const response = await sandboxBridgeFetch(BRIDGE_URL, {}, 10_000);
    const started = Date.now();
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_RESPONSE_TOO_LARGE",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(cancelCalls).toBe(1);
  });

  test("rejects targets outside the provider-owned loopback range before fetch", async () => {
    const fetchMock = mock(async () => new Response("ok"));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(sandboxBridgeFetch("http://169.254.169.254/bridge")).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_URL_REJECTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects oversized request bodies before fetch", async () => {
    const fetchMock = mock(async () => new Response("ok"));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      sandboxBridgeFetch(BRIDGE_URL, { body: "x".repeat(1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "LOCAL_SANDBOX_BRIDGE_REQUEST_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("bounds streamed response bodies and releases them on cancellation", async () => {
    let cancelled = false;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ) as typeof fetch;

    const response = await sandboxBridgeFetch(BRIDGE_URL);
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_BRIDGE_RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });
});

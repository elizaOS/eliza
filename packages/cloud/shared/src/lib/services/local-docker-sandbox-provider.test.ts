/**
 * Deterministic transport tests for the local Docker bridge boundary: the
 * canonical SSRF guard, independent timeout/caller cancellation, redirect and
 * status rejection, body disposal, and request/response byte limits.
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

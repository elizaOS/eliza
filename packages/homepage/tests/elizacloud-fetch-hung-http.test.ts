/**
 * Unit coverage for homepage `elizacloudFetch`: honest JSON success and hung
 * hop fail-closed. Deterministic fetch mocks; no live Cloud.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { elizacloudFetch } from "../src/lib/api/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function hungFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const abort = () => {
      reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

describe("homepage elizacloudFetch hung HTTP", () => {
  test("returns JSON from a successful Cloud hop", async () => {
    const fetchMock = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(elizacloudFetch("/api/v1/health")).resolves.toEqual({
      ok: true,
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("fails closed on a hung Cloud hop instead of waiting forever", async () => {
    const timeoutSpy = mock(() => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        );
      }, 50);
      return controller.signal;
    });
    AbortSignal.timeout = timeoutSpy as typeof AbortSignal.timeout;
    globalThis.fetch = hungFetch as typeof fetch;
    const started = Date.now();
    await expect(elizacloudFetch("/api/v1/health")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// Pins the bounded bridge contract of the local Docker sandbox provider:
// bridge/bridgeStream fail closed at the hop timeout instead of pinning the
// caller when a container is wedged, and caller signals are preserved.
import { describe, expect, mock, test } from "bun:test";

describe("sandboxBridgeFetch — bounded bridge hops fail closed and keep caller signals", () => {
  test("aborts a hung bridge hop at the configured timeout", async () => {
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const { sandboxBridgeFetch } = await import("./local-docker-sandbox-provider");
    const start = Date.now();
    await expect(sandboxBridgeFetch("http://127.0.0.1:1/bridge", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("preserves a caller-provided abort signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { sandboxBridgeFetch } = await import("./local-docker-sandbox-provider");
    const controller = new AbortController();
    await sandboxBridgeFetch("http://127.0.0.1:1/bridge", {
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

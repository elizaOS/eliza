/** Unit coverage for caller cancellation and full-response fetch deadlines. */

import { describe, expect, it } from "vitest";
import {
  type FetchDeadlineOptions,
  fetchWithDeadline,
} from "./fetch-with-deadline";

function stallOnSignal(): NonNullable<FetchDeadlineOptions["fetchImpl"]> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected an abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
}

describe("fetchWithDeadline", () => {
  it("does not dispatch a mutation when the caller already cancelled", async () => {
    const caller = new AbortController();
    const reason = new DOMException("consent withdrawn", "AbortError");
    caller.abort(reason);
    let dispatched = 0;
    let consumed = 0;

    await expect(
      fetchWithDeadline(
        "https://example.test/activation",
        { method: "POST" },
        async (response) => {
          consumed += 1;
          return response.text();
        },
        {
          signal: caller.signal,
          timeoutMs: 1_000,
          fetchImpl: async () => {
            dispatched += 1;
            return new Response("accepted");
          },
        },
      ),
    ).rejects.toBe(reason);
    expect(dispatched).toBe(0);
    expect(consumed).toBe(0);
  });

  it("aborts a stalled request when its deadline expires", async () => {
    await expect(
      fetchWithDeadline(
        "https://example.test",
        {},
        async (response) => response,
        {
          fetchImpl: stallOnSignal(),
          timeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("preserves caller cancellation", async () => {
    const caller = new AbortController();
    const request = fetchWithDeadline(
      "https://example.test",
      {},
      async (response) => response,
      { fetchImpl: stallOnSignal(), signal: caller.signal, timeoutMs: 1_000 },
    );

    caller.abort(new DOMException("superseded", "AbortError"));

    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      message: "superseded",
    });
  });

  it("keeps the deadline active while the response body is consumed", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: FetchDeadlineOptions["fetchImpl"] = async (
      _input,
      init,
    ) => {
      requestSignal = init?.signal ?? undefined;
      return new Response("headers arrived");
    };

    await expect(
      fetchWithDeadline(
        "https://example.test",
        {},
        async () => await new Promise<string>(() => {}),
        { fetchImpl, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("returns a successfully consumed body", async () => {
    await expect(
      fetchWithDeadline(
        "https://example.test",
        {},
        async (response) => await response.text(),
        {
          fetchImpl: async () => new Response("ok"),
          timeoutMs: 1_000,
        },
      ),
    ).resolves.toBe("ok");
  });
});

/**
 * Behavioral coverage for telegram-api fetch timeout.
 * Proves telegramBotApiRequest / telegramBotApiGet are bounded by AbortSignal.timeout(15_000)
 * so a stalled api.telegram.org does not hang the caller.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { telegramBotApiGet, telegramBotApiRequest } from "./telegram-api";

function hangingFetch(): typeof fetch {
  return ((_: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("signal timed out", "TimeoutError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("signal timed out", "TimeoutError")),
        { once: true },
      );
    })) as unknown as typeof fetch;
}

function okFetch<T>(result: T): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    }) as Response) as unknown as typeof fetch;
}

describe("telegram-api timeout (behavioral)", () => {
  let timeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      if (ms === 15_000) return orig(10);
      return orig(ms);
    });
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  it("telegramBotApiRequest aborts hanging fetch at deadline via AbortSignal.timeout(15_000)", async () => {
    const start = Date.now();
    await expect(telegramBotApiRequest("tok", "getMe", {}, hangingFetch())).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy.mock.calls.some((c) => c[0] === 15_000)).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it("telegramBotApiGet aborts hanging fetch at deadline via AbortSignal.timeout(15_000)", async () => {
    const start = Date.now();
    await expect(telegramBotApiGet("tok", "getMe", {}, hangingFetch())).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy.mock.calls.some((c) => c[0] === 15_000)).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves on success without throwing", async () => {
    await expect(telegramBotApiRequest("tok", "getMe", {}, okFetch({ id: 1 }))).resolves.toEqual({ id: 1 });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("telegramBotApiGet resolves on success", async () => {
    await expect(telegramBotApiGet("tok", "getMe", {}, okFetch({ id: 2 }))).resolves.toEqual({ id: 2 });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });
});

// Pins the shared Discord REST deadline contract. Every caller keeps its own
// cancellation signal, but a caller that never aborts cannot disable the
// owned per-hop deadline. The bot/bearer helpers must use this same boundary.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

class TestElizaError extends Error {
  readonly code: string;

  constructor(message: string, options: { code: string }) {
    super(message);
    this.code = options.code;
  }
}

mock.module("@elizaos/core", () => ({ ElizaError: TestElizaError }));

const { discordBearerApiRequest, discordBotApiRequest, discordFetch } = await import(
  "./discord-api"
);

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function installHungFetch(): void {
  globalThis.fetch = mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(
          () => reject(new Error("test guard elapsed before Discord deadline")),
          2_000,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  ) as unknown as typeof fetch;
}

describe("discordFetch", () => {
  it("aborts a hung Discord hop at the owned deadline", async () => {
    installHungFetch();

    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", undefined, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("propagates caller cancellation through a composed signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          const guard = setTimeout(
            () => reject(new Error("test guard elapsed before caller abort")),
            2_000,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(guard);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = discordFetch(
      "https://discord.com/api/v10/users/@me",
      { signal: controller.signal },
      60_000,
    );
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(seen).toBeDefined();
    expect(seen).not.toBe(controller.signal);
  });

  it("keeps the deadline when a caller signal never aborts", async () => {
    installHungFetch();
    const never = new AbortController();

    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", { signal: never.signal }, 100),
    ).rejects.toThrow(/aborted/i);
  });

  it("routes bot and bearer helpers through the composed boundary", async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const never = new AbortController();

    await discordBotApiRequest("/users/@me", "bot", {
      signal: never.signal,
    });
    await discordBearerApiRequest("/users/@me", "bearer", {
      signal: never.signal,
    });

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal !== never.signal)).toBe(true);
  });

  it("does not dispatch when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    const fetchMock = mock(async () => new Response());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a hung response body and cancels its stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch;

    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", undefined, 50),
    ).rejects.toThrow(/timed out/i);
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels a declared oversized response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(
      async () =>
        new Response(body, { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
    ) as unknown as typeof fetch;

    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", undefined, 1_000),
    ).rejects.toMatchObject({ code: "DISCORD_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("clears its timer and caller listener after success", async () => {
    const controller = new AbortController();
    const clearTimer = spyOn(globalThis, "clearTimeout");
    const removeListener = spyOn(controller.signal, "removeEventListener");
    globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;
    try {
      const response = await discordFetch(
        "https://discord.com/api/v10/users/@me",
        { signal: controller.signal },
        1_000,
      );
      expect(await response.text()).toBe("ok");
      expect(clearTimer).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      clearTimer.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("rejects invalid timeout values before dispatch", async () => {
    const fetchMock = mock(async () => new Response());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (const timeout of [0, -1, Number.NaN, 2_147_483_648]) {
      await expect(
        discordFetch("https://discord.com/api/v10/users/@me", undefined, timeout),
      ).rejects.toMatchObject({ code: "INVALID_DISCORD_TIMEOUT" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

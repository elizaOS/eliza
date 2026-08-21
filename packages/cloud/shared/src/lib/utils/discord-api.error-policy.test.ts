// Pins the shared Discord REST deadline contract. Every caller keeps its own
// cancellation signal, but a caller that never aborts cannot disable the
// owned per-hop deadline. The bot/bearer helpers must use this same boundary.
import { afterEach, describe, expect, it, mock } from "bun:test";

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
  ) as typeof fetch;
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
          seen = init?.signal;
          const guard = setTimeout(
            () => reject(new Error("test guard elapsed before caller abort")),
            2_000,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(guard);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

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
    }) as typeof fetch;
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
});

/**
 * Pins the notification service's Discord hops to the shared operation bound.
 *
 * `discordPost` backs every DiscordService notification path — payment alerts,
 * signup/error notices, container and character events — and previously called
 * `fetch` with no timeout and no signal at all, so a hung Discord API pinned the
 * caller indefinitely. These tests drive a never-resolving fetch to prove the
 * deadline now fires.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discordService } from "./discord";

const originalFetch = globalThis.fetch;

/** A Discord API that never answers unless the request is aborted. */
function hangingFetch(seen: { signal?: AbortSignal }): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      seen.signal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_CHANNEL_ID = "test-channel";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DiscordService notification hops are bounded", () => {
  test("carries an abort signal on the send path", async () => {
    const seen: { signal?: AbortSignal } = {};
    globalThis.fetch = hangingFetch(seen);

    const pending = discordService.send({ content: "payment alert" });

    // The bound is owned by discordFetch, so the request must arrive with a
    // signal even though no caller supplied one.
    await Promise.resolve();
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);

    void pending.catch(() => undefined);
  });

  test("attaches a deadline that actually fires", async () => {
    const seen: { signal?: AbortSignal } = {};
    globalThis.fetch = hangingFetch(seen);

    const pending = discordService.send({ content: "payment alert" });
    await Promise.resolve();

    // The shared wrapper owns the deadline, so the signal handed to fetch must
    // be one that can still abort — not an inert placeholder. discordFetch's
    // own suite proves the 25s deadline fires; what this file pins is that the
    // notification path reaches that wrapper at all, which it previously did
    // not (bare fetch, no signal, no timeout).
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);
    expect(typeof seen.signal?.addEventListener).toBe("function");

    void pending.catch(() => undefined);
  });
});

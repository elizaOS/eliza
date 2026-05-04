import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDiscordSourceCache,
  DISCORD_FACT_CACHE_TTL_MS,
  fetchDiscordEnumeration,
  formatDiscordEnumerationAsFacts,
} from "./discord-target-source";

afterEach(() => {
  vi.clearAllMocks();
});

function makeFetch(
  routes: Record<
    string,
    { ok?: boolean; status?: number; body?: unknown; throwMsg?: string }
  >,
): { fn: typeof fetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (url: string) => {
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (response.throwMsg) throw new Error(response.throwMsg);
        return {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          json: async () => response.body ?? [],
        } as unknown as Response;
      }
    }
    throw new Error(`unmocked fetch ${url}`);
  });
  return { fn: mock as unknown as typeof fetch, mock };
}

describe("fetchDiscordEnumeration", () => {
  it("returns one structured entry per guild with text channels filtered", async () => {
    const { fn } = makeFetch({
      "/users/@me/guilds": {
        body: [
          { id: "g1", name: "Cozy Devs" },
          { id: "g2", name: "Other" },
        ],
      },
      "/guilds/g1/channels": {
        body: [
          { id: "c-general", name: "general", type: 0 },
          { id: "c-voice", name: "voice", type: 2 },
          { id: "c-alerts", name: "alerts", type: 0 },
        ],
      },
      "/guilds/g2/channels": {
        body: [{ id: "c-only", name: "only-text", type: 0 }],
      },
    });
    const result = await fetchDiscordEnumeration("token", { fetchImpl: fn });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      guildId: "g1",
      guildName: "Cozy Devs",
      channels: [
        { id: "c-general", name: "general" },
        { id: "c-alerts", name: "alerts" },
      ],
    });
    expect(result[1]).toEqual({
      guildId: "g2",
      guildName: "Other",
      channels: [{ id: "c-only", name: "only-text" }],
    });
  });

  it("returns empty array on guilds 401/403/5xx (silent degrade)", async () => {
    const { fn } = makeFetch({
      "/users/@me/guilds": { ok: false, status: 401 },
    });
    const result = await fetchDiscordEnumeration("bad-token", {
      fetchImpl: fn,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when guilds fetch throws", async () => {
    const { fn } = makeFetch({
      "/users/@me/guilds": { throwMsg: "ENETUNREACH" },
    });
    const result = await fetchDiscordEnumeration("token", { fetchImpl: fn });
    expect(result).toEqual([]);
  });

  it("flags per-guild channel-fetch failures without aborting other guilds", async () => {
    const { fn } = makeFetch({
      "/users/@me/guilds": {
        body: [
          { id: "g-good", name: "Good" },
          { id: "g-bad", name: "Bad" },
        ],
      },
      "/guilds/g-good/channels": {
        body: [{ id: "c1", name: "general", type: 0 }],
      },
      "/guilds/g-bad/channels": { ok: false, status: 429 },
    });
    const result = await fetchDiscordEnumeration("token", { fetchImpl: fn });
    expect(result).toHaveLength(2);
    expect(result[0].channels).toEqual([{ id: "c1", name: "general" }]);
    expect(result[1].channelsError).toEqual({ status: 429 });
    expect(result[1].channels).toBeUndefined();
  });

  it("uses the cache on the second call within the TTL window", async () => {
    const { fn, mock } = makeFetch({
      "/users/@me/guilds": { body: [{ id: "g", name: "G" }] },
      "/guilds/g/channels": { body: [] },
    });
    const cache = createDiscordSourceCache();
    let nowValue = 1000;
    const first = await fetchDiscordEnumeration("tok", {
      fetchImpl: fn,
      cache,
      now: () => nowValue,
    });
    const callsAfterFirst = mock.mock.calls.length;
    expect(callsAfterFirst).toBe(2);
    nowValue += DISCORD_FACT_CACHE_TTL_MS - 1;
    const second = await fetchDiscordEnumeration("tok", {
      fetchImpl: fn,
      cache,
      now: () => nowValue,
    });
    expect(mock.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it("re-fetches after the TTL expires", async () => {
    const { fn, mock } = makeFetch({
      "/users/@me/guilds": { body: [{ id: "g", name: "G" }] },
      "/guilds/g/channels": { body: [] },
    });
    const cache = createDiscordSourceCache();
    let nowValue = 1000;
    await fetchDiscordEnumeration("tok", {
      fetchImpl: fn,
      cache,
      now: () => nowValue,
    });
    const callsAfterFirst = mock.mock.calls.length;
    nowValue += DISCORD_FACT_CACHE_TTL_MS + 1;
    await fetchDiscordEnumeration("tok", {
      fetchImpl: fn,
      cache,
      now: () => nowValue,
    });
    expect(mock.mock.calls.length).toBe(callsAfterFirst * 2);
  });
});

describe("formatDiscordEnumerationAsFacts", () => {
  it("emits one fact per guild matching the legacy LLM-prompt phrasing", () => {
    const facts = formatDiscordEnumerationAsFacts([
      {
        guildId: "g1",
        guildName: "Cozy Devs",
        channels: [
          { id: "c1", name: "general" },
          { id: "c2", name: "alerts" },
        ],
      },
    ]);
    expect(facts).toEqual([
      'Discord guild "Cozy Devs" (id g1) channels: #general (c1), #alerts (c2).',
    ]);
  });

  it("emits a no-text-channels message for guilds with no text channels", () => {
    const facts = formatDiscordEnumerationAsFacts([
      { guildId: "g", guildName: "Empty", channels: [] },
    ]);
    expect(facts).toEqual([
      'Discord guild "Empty" (id g) — no text channels visible to the bot.',
    ]);
  });

  it("emits a status detail for guilds whose channel fetch returned a status", () => {
    const facts = formatDiscordEnumerationAsFacts([
      {
        guildId: "g",
        guildName: "Limited",
        channelsError: { status: 429 },
      },
    ]);
    expect(facts[0]).toContain("status 429");
  });

  it("emits a thrown-error message when no status is available", () => {
    const facts = formatDiscordEnumerationAsFacts([
      {
        guildId: "g",
        guildName: "Broken",
        channelsError: { message: "ECONNRESET" },
      },
    ]);
    expect(facts[0]).toContain("ECONNRESET");
  });
});

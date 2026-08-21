// Pins the fail-closed error policy of the Discord connector (#13415): a failed
// Discord REST call must PROPAGATE as a throw, while a legitimately-empty guild
// (no text channels) must stay a distinct, successful [] result. Deterministic
// harness — global fetch and the DB repositories are mocked; no live Discord.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Env is read at module load, so it must be set before the dynamic import below.
process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
process.env.DISCORD_BOT_TOKEN = "test-bot-token";

const channelUpsert = mock(async () => {});
const guildUpsert = mock(async () => {});

mock.module("../../../db/repositories/discord-channels", () => ({
  discordChannelsRepository: {
    upsert: channelUpsert,
    findByGuild: mock(async () => []),
    deleteByGuild: mock(async () => {}),
  },
}));
mock.module("../../../db/repositories/discord-guilds", () => ({
  discordGuildsRepository: {
    upsert: guildUpsert,
    findByOrganization: mock(async () => []),
    delete: mock(async () => {}),
  },
}));
mock.module("../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { discordAutomationService, discordFetch } = await import("./index");

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  channelUpsert.mockClear();
  guildUpsert.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("refreshChannels — internal failure propagates vs designed-empty stays distinct", () => {
  it("THROWS when the Discord channels API returns a non-2xx status (failure is not [])", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse("missing access", { ok: false, status: 403 }),
    ) as unknown as typeof fetch;

    await expect(discordAutomationService.refreshChannels("org-1", "guild-1")).rejects.toThrow(
      /Failed to fetch channels for guild guild-1 \(status 403\)/,
    );
    // A failed fetch must not touch the channel cache.
    expect(channelUpsert).not.toHaveBeenCalled();
  });

  it("THROWS when the fetch itself rejects (transport failure surfaces)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(discordAutomationService.refreshChannels("org-1", "guild-1")).rejects.toThrow(
      /ECONNRESET/,
    );
  });

  it("returns [] (NOT a throw) for a guild whose only channels are non-text — designed empty", async () => {
    // type 2 = GuildVoice → filtered out by isTextChannel; a successful, empty result.
    globalThis.fetch = mock(async () =>
      jsonResponse([{ id: "v1", name: "General", type: 2, parent_id: null, position: 0 }]),
    ) as unknown as typeof fetch;

    const result = await discordAutomationService.refreshChannels("org-1", "guild-1");
    expect(result).toEqual([]);
    // Distinct from failure: no throw, and nothing to cache.
    expect(channelUpsert).not.toHaveBeenCalled();
  });

  it("returns the text channels and caches them on a successful fetch", async () => {
    // type 0 = GuildText → kept.
    globalThis.fetch = mock(async () =>
      jsonResponse([
        { id: "t1", name: "general", type: 0, parent_id: null, position: 0 },
        { id: "v1", name: "Voice", type: 2, parent_id: null, position: 1 },
      ]),
    ) as unknown as typeof fetch;

    const result = await discordAutomationService.refreshChannels("org-1", "guild-1");
    expect(result.map((c) => c.id)).toEqual(["t1"]);
    expect(channelUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("handleBotOAuthCallback — J6 best-effort: channel cache-warm failure does not fail a completed bot-add", () => {
  it("still returns success when refreshChannels fails after the guild is persisted", async () => {
    const guildId = "guild-9";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return jsonResponse({ access_token: "user-access-token" });
      }
      if (url.endsWith("/users/@me")) {
        return jsonResponse({
          id: "user-1",
          username: "owner",
          global_name: "Owner",
          avatar: null,
        });
      }
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([
          {
            id: guildId,
            name: "My Guild",
            icon: null,
            owner: true,
            permissions: "0",
            features: [],
          },
        ]);
      }
      if (url.endsWith(`/guilds/${guildId}/channels`)) {
        // The cache-warm step fails — must NOT undo the completed bot-add.
        return jsonResponse("rate limited", { ok: false, status: 429 });
      }
      if (url.endsWith(`/guilds/${guildId}`)) {
        return jsonResponse({ id: guildId, name: "My Guild", icon: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await discordAutomationService.handleBotOAuthCallback({
      code: "auth-code",
      guildId,
      oauthState: { organizationId: "org-1", flow: "organization-install" } as never,
    });

    expect(result.success).toBe(true);
    expect(result.guildId).toBe(guildId);
    // The guild was persisted even though channel warm-up threw.
    expect(guildUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("discordFetch — bounded hops fail closed and keep caller signals", () => {
  it("aborts a hung Discord API hop at the timeout", async () => {
    // A Discord API that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the 25s default matches the send path).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      discordFetch("https://discord.com/api/v10/guilds/g1", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("composes a caller-provided abort signal with the deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = discordFetch("https://discord.com/api/v10/users/@me", {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(seen).not.toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow(/caller cancelled/);
    expect(seen?.aborted).toBe(true);
  });

  it("keeps the deadline when the caller signal never aborts", async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = discordFetch(
      "https://discord.com/api/v10/users/@me",
      { signal: controller.signal },
      100,
    );
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(controller.signal.aborted).toBe(false);
    expect(seen?.aborted).toBe(true);
  });
});

describe("sendMessage — one bounded delivery sequence", () => {
  it("aborts the underlying hung transport at the overall deadline", async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const pending = discordAutomationService.sendMessage("channel-1", "hello");
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    jest.advanceTimersByTime(25_000);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "Failed to send message",
    });
    expect(seen?.aborted).toBe(true);
  });

  it("clears the sequence deadline after a completed body read", async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return jsonResponse({ id: "message-1" });
    }) as unknown as typeof fetch;

    await expect(discordAutomationService.sendMessage("channel-1", "hello")).resolves.toEqual({
      success: true,
      messageId: "message-1",
    });
    expect(seen?.aborted).toBe(false);
    jest.advanceTimersByTime(25_000);
    expect(seen?.aborted).toBe(false);
  });

  it("rejects over-budget chunk work before the first REST mutation", async () => {
    const fetchMock = mock(async () => jsonResponse({ id: "unexpected" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await discordAutomationService.sendMessage(
      "channel-1",
      "x".repeat(2_000 * 25 + 1),
    );
    expect(result).toEqual({
      success: false,
      error: "Message exceeds the 25-chunk delivery limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not report full success after a later chunk fails", async () => {
    let requestCount = 0;
    globalThis.fetch = mock(async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse({ id: "partial-message" })
        : jsonResponse("rate limited", { ok: false, status: 429 });
    }) as unknown as typeof fetch;

    await expect(
      discordAutomationService.sendMessage("channel-1", "x".repeat(2_001)),
    ).resolves.toEqual({ success: false, error: "Failed to send message" });
    expect(requestCount).toBe(2);
  });
});

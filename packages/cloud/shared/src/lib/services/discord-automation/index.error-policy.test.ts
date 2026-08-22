// Pins the fail-closed error policy of the Discord connector (#13415): a failed
// Discord REST call must PROPAGATE as a throw, while a legitimately-empty guild
// (no text channels) must stay a distinct, successful [] result. Deterministic
// harness — global fetch and the DB repositories are mocked; no live Discord.
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

// Env is read at module load, so it must be set before the dynamic import below.
process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
process.env.DISCORD_BOT_TOKEN = "test-bot-token";

const channelUpsert = mock(async () => {});
const guildUpsert = mock(async () => {});

// This suite exercises Discord transport and persistence policy. Keep the
// unrelated Core Unicode helper hermetic so the focused test does not require
// a built @elizaos/core workspace package.
mock.module("@elizaos/core", () => ({
  ElizaError: class extends Error {
    readonly code: string;

    constructor(message: string, options: { code: string }) {
      super(message);
      this.code = options.code;
    }
  },
  truncateWellFormed: (value: string, maxUnits: number) => value.slice(0, maxUnits),
}));
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
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hungResponse(
  init?: RequestInit,
  onSignal?: (signal: AbortSignal | undefined) => void,
): Promise<Response> {
  onSignal?.(init?.signal ?? undefined);
  return new Promise<Response>((_resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error("test guard elapsed before Discord deadline")),
      2_000,
    );
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(guard);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

beforeEach(() => {
  channelUpsert.mockClear();
  guildUpsert.mockClear();
});

afterEach(() => {
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
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) =>
      hungResponse(init),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      discordFetch("https://discord.com/api/v10/guilds/g1", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("propagates a caller abort through the composed signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) =>
      hungResponse(init, (signal) => {
        seen = signal;
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
    expect(seen).not.toBe(controller.signal);
  });

  it("keeps the hop deadline when the caller signal never aborts", async () => {
    // The caller signal must not replace the bound: a caller holding a signal
    // it never fires would otherwise pin the worker forever.
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) =>
      hungResponse(init),
    ) as unknown as typeof fetch;

    const never = new AbortController();
    const start = Date.now();
    await expect(
      discordFetch("https://discord.com/api/v10/users/@me", { signal: never.signal }, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("sendMessage — shared Discord deadline boundary", () => {
  it("passes the shared deadline signal to the message transport", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return jsonResponse({ id: "message-1" });
    }) as unknown as typeof fetch;

    const result = await discordAutomationService.sendMessage("channel-1", "hello");

    expect(result).toEqual({ success: true, messageId: "message-1" });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("aborts the underlying hung transport at the overall deadline", async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const pending = discordAutomationService.sendMessage("channel-1", "hello");
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    jest.advanceTimersByTime(25_000);

    await expect(pending).resolves.toEqual({ success: false, error: "Failed to send message" });
    expect(seen?.aborted).toBe(true);
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

  it("bounds raw whitespace work before split normalization", async () => {
    const fetchMock = mock(async () => jsonResponse({ id: "unexpected" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await discordAutomationService.sendMessage(
      "channel-1",
      `${" ".repeat(2_000 * 25 + 1)}x`,
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

  it("clears the overall deadline after a completed multi-chunk send", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return jsonResponse({ id: `message-${signals.length}` });
    }) as unknown as typeof fetch;

    await expect(
      discordAutomationService.sendMessage("channel-1", "x".repeat(2_001)),
    ).resolves.toEqual({ success: true, messageId: "message-2" });
    jest.advanceTimersByTime(25_000);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });
});

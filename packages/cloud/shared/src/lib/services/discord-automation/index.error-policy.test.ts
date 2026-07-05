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

const { discordAutomationService } = await import("./index");

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

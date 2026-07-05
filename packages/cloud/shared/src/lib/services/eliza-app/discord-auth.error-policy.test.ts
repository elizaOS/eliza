// Pins the fail-closed error contract of discordAuthService.verifyOAuthCode:
// a genuine auth denial (Discord 400 invalid_grant, or a bot/system account)
// resolves to null, while every internal failure (unconfigured credentials,
// Discord 401/403/5xx, malformed response, transport error) throws so the route
// boundary surfaces a 5xx instead of masking a broken pipeline as "invalid code".
// Deterministic: real exported service driven through a mocked global fetch.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../utils/logger";
import { discordAuthService } from "./discord-auth";

const REDIRECT_URI = "https://app.example.com/auth/discord/callback";
const OK_USER = {
  id: "1234567890",
  username: "cooluser",
  discriminator: "0",
  global_name: "Cool User",
  avatar: "abc123",
};

type FetchHandlers = {
  token?: () => Response | Promise<Response>;
  user?: () => Response | Promise<Response>;
};

function installFetch(handlers: FetchHandlers) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/oauth2/token")) {
      if (!handlers.token) throw new Error("unexpected token fetch");
      return handlers.token();
    }
    if (url.includes("/users/@me")) {
      if (!handlers.user) throw new Error("unexpected user fetch");
      return handlers.user();
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const savedFetch = globalThis.fetch;
const savedAppId = process.env.ELIZA_APP_DISCORD_APPLICATION_ID;
const savedSecret = process.env.ELIZA_APP_DISCORD_CLIENT_SECRET;

beforeEach(() => {
  process.env.ELIZA_APP_DISCORD_APPLICATION_ID = "app-id-123";
  process.env.ELIZA_APP_DISCORD_CLIENT_SECRET = "client-secret-456";
  spyOn(logger, "error").mockImplementation(() => {});
  spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedAppId === undefined) delete process.env.ELIZA_APP_DISCORD_APPLICATION_ID;
  else process.env.ELIZA_APP_DISCORD_APPLICATION_ID = savedAppId;
  if (savedSecret === undefined) delete process.env.ELIZA_APP_DISCORD_CLIENT_SECRET;
  else process.env.ELIZA_APP_DISCORD_CLIENT_SECRET = savedSecret;
  mock.restore();
});

describe("verifyOAuthCode — designed auth-denial resolves to null", () => {
  test("Discord rejects the grant (HTTP 400) -> null, not a throw", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    const result = await discordAuthService.verifyOAuthCode("expired-code", REDIRECT_URI);
    expect(result).toBeNull();
  });

  test("bot/system account -> null after a valid token exchange", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      user: () => new Response(JSON.stringify({ ...OK_USER, bot: true }), { status: 200 }),
    });
    const result = await discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI);
    expect(result).toBeNull();
  });
});

describe("verifyOAuthCode — internal failure throws (distinct from null)", () => {
  test("unconfigured client credentials throw (was masked as null)", async () => {
    delete process.env.ELIZA_APP_DISCORD_APPLICATION_ID;
    delete process.env.ELIZA_APP_DISCORD_CLIENT_SECRET;
    // No fetch should even be attempted.
    installFetch({});
    await expect(discordAuthService.verifyOAuthCode("any-code", REDIRECT_URI)).rejects.toThrow(
      /not configured/,
    );
  });

  test("Discord token endpoint 5xx throws (outage, not a bad code)", async () => {
    installFetch({
      token: () => new Response("upstream boom", { status: 503 }),
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /status 503/,
    );
  });

  test("token endpoint 401 (our misconfigured client) throws, not null", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /status 401/,
    );
  });

  test("200 token response missing access_token throws (protocol violation)", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /missing access_token/,
    );
  });

  test("transport error during token exchange propagates", async () => {
    installFetch({
      token: () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /ECONNRESET/,
    );
  });

  test("user profile endpoint 5xx throws (valid token, internal failure)", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      user: () => new Response("nope", { status: 500 }),
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /status 500/,
    );
  });

  test("user response missing required fields throws (protocol violation)", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      user: () => new Response(JSON.stringify({ avatar: null }), { status: 200 }),
    });
    await expect(discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI)).rejects.toThrow(
      /missing required fields/,
    );
  });
});

describe("verifyOAuthCode — happy path (proves the success branch is real)", () => {
  test("valid token + valid human user -> DiscordUserData", async () => {
    installFetch({
      token: () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
      user: () => new Response(JSON.stringify(OK_USER), { status: 200 }),
    });
    const result = await discordAuthService.verifyOAuthCode("good-code", REDIRECT_URI);
    expect(result).toEqual({
      id: OK_USER.id,
      username: OK_USER.username,
      global_name: OK_USER.global_name,
      avatar: OK_USER.avatar,
    });
  });
});

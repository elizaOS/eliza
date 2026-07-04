/**
 * Tests `resolveDiscordExchange`, the server-side Discord Activity OAuth2 code →
 * user-id exchange: it fails closed (undefined) when the client id/secret are
 * unconfigured, round-trips a valid code through the two-step token+user fetch
 * (bearering the minted access token, never the secret), returns null on every
 * upstream failure/empty-payload/thrown path, and never logs the client secret.
 * Uses a sequenced fetch stub and a settings-backed fake runtime.
 */
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DiscordExchangeDeps,
  resolveDiscordExchange,
} from "./discord-exchange";

const CLIENT_ID = "app-123";
const CLIENT_SECRET = "super-secret-value-never-logged";
const TOKEN_URL = "https://discord.test/oauth2/token";
const USER_URL = "https://discord.test/users/@me";

function runtimeWith(settings: Record<string, string>) {
  return {
    getSetting: (key: string): unknown => settings[key],
  };
}

function jsonResponse(
  status: number,
  body: unknown,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A fetch stub that returns the token response then the user response. */
function sequencedFetch(
  responses: Array<Pick<Response, "ok" | "status" | "json"> | Error>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl: DiscordExchangeDeps["fetch"] = async (url, init) => {
    calls.push({ url, init });
    const next = responses[i++];
    if (next instanceof Error) throw next;
    if (!next) throw new Error(`unexpected fetch call #${i} to ${url}`);
    return next;
  };
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDiscordExchange", () => {
  it("returns undefined when the client id is unconfigured (fail closed)", () => {
    const exchange = resolveDiscordExchange(
      runtimeWith({ DISCORD_CLIENT_SECRET: CLIENT_SECRET }),
    );
    expect(exchange).toBeUndefined();
  });

  it("returns undefined when the client secret is unconfigured (fail closed)", () => {
    const exchange = resolveDiscordExchange(
      runtimeWith({ DISCORD_APPLICATION_ID: CLIENT_ID }),
    );
    expect(exchange).toBeUndefined();
  });

  it("accepts DISCORD_CLIENT_ID as a fallback client id", () => {
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_CLIENT_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
    );
    expect(exchange).toBeTypeOf("function");
  });

  it("verifies a valid Activity code → user id via the two-step exchange", async () => {
    const { fetchImpl, calls } = sequencedFetch([
      jsonResponse(200, { access_token: "access-abc", token_type: "Bearer" }),
      jsonResponse(200, { id: "discord-user-77", username: "owner" }),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(exchange).toBeTypeOf("function");

    const user = await exchange?.("oauth2-code-xyz");
    expect(user).toEqual({ id: "discord-user-77" });

    // Token request: POST form-encoded, carries the authorization-code grant.
    expect(calls[0].url).toBe(TOKEN_URL);
    expect(calls[0].init?.method).toBe("POST");
    const body = String(calls[0].init?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=oauth2-code-xyz");
    expect(body).toContain(`client_id=${CLIENT_ID}`);
    // The secret IS sent to Discord (that is the whole point of the exchange)…
    expect(body).toContain("client_secret=");

    // User request: bearer the freshly minted access token, never the secret.
    expect(calls[1].url).toBe(USER_URL);
    const authHeader = (calls[1].init?.headers as Record<string, string>)
      .Authorization;
    expect(authHeader).toBe("Bearer access-abc");
  });

  it("fails closed (null) when the token endpoint rejects", async () => {
    const { fetchImpl } = sequencedFetch([jsonResponse(401, { error: "bad" })]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed when the token response has no access_token", async () => {
    const { fetchImpl } = sequencedFetch([
      jsonResponse(200, { scope: "identify" }),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed when the user lookup rejects", async () => {
    const { fetchImpl } = sequencedFetch([
      jsonResponse(200, { access_token: "access-abc" }),
      jsonResponse(403, { message: "forbidden" }),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed when the user payload has no id", async () => {
    const { fetchImpl } = sequencedFetch([
      jsonResponse(200, { access_token: "access-abc" }),
      jsonResponse(200, { username: "no-id-here" }),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed when the token request throws", async () => {
    const { fetchImpl } = sequencedFetch([new Error("network down")]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed when the user request throws", async () => {
    const { fetchImpl } = sequencedFetch([
      jsonResponse(200, { access_token: "access-abc" }),
      new Error("socket reset"),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("code")).toBeNull();
  });

  it("fails closed for an empty code without calling Discord", async () => {
    const { fetchImpl, calls } = sequencedFetch([]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    expect(await exchange?.("")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never logs the client secret on any failure path", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { fetchImpl } = sequencedFetch([
      jsonResponse(500, { error: `leak-check ${CLIENT_SECRET}` }),
    ]);
    const exchange = resolveDiscordExchange(
      runtimeWith({
        DISCORD_APPLICATION_ID: CLIENT_ID,
        DISCORD_CLIENT_SECRET: CLIENT_SECRET,
      }),
      { fetch: fetchImpl, tokenUrl: TOKEN_URL, userUrl: USER_URL },
    );
    await exchange?.("code");
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain(CLIENT_SECRET);
  });
});

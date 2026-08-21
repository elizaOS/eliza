/**
 * Token-endpoint grant tests: authorization-code exchange (PKCE and
 * confidential), refresh-token grant, invalid_grant → revoked mapping,
 * malformed token payloads, and local-mode config resolution. Uses the
 * protocol-faithful fetch harness; no real network.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  exchangeAuthorizationCode,
  hasLocalConfig,
  readLocalConfig,
  refreshAccessToken,
  SPOTIFY_TOKEN_ENDPOINT,
} from "../auth";
import { jsonResponse, MockSpotify, tokenGrantBody } from "./mock-spotify";

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("Spotify auth", () => {
  it("exchanges an authorization code with PKCE (public client)", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(200, tokenGrantBody({ accessToken: "at", refreshToken: "rt" }))
    );
    const tokens = await exchangeAuthorizationCode(
      {
        clientId: "client-1",
        redirectUri: "https://app.example/callback",
        code: "auth-code",
        codeVerifier: "verifier",
      },
      mock.fetch
    );
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const body = new URLSearchParams(mock.requests[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_id")).toBe("client-1");
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("uses Basic auth for confidential clients and keeps the body secret-free", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(200, tokenGrantBody({ accessToken: "at" }))
    );
    await exchangeAuthorizationCode(
      {
        clientId: "client-1",
        clientSecret: "secret",
        redirectUri: "https://app.example/callback",
        code: "auth-code",
      },
      mock.fetch
    );
    const request = mock.requests[0];
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from("client-1:secret").toString("base64")}`
    );
    expect(request?.body).not.toContain("secret");
  });

  it("refreshes and preserves the refresh token when the grant omits it", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(200, tokenGrantBody({ accessToken: "new-at" }))
    );
    const tokens = await refreshAccessToken(
      { clientId: "c", clientSecret: "s", refreshToken: "rt-original" },
      mock.fetch
    );
    expect(tokens.accessToken).toBe("new-at");
    expect(tokens.refreshToken).toBe("rt-original");
    const body = new URLSearchParams(mock.requests[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-original");
  });

  it("maps invalid_grant to SPOTIFY_AUTH_REVOKED", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(400, { error: "invalid_grant", error_description: "Refresh token revoked" })
    );
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "rt" }, mock.fetch)
    ).rejects.toMatchObject({ code: "SPOTIFY_AUTH_REVOKED" });
  });

  it("rejects malformed token payloads as SPOTIFY_UPSTREAM_INVALID", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(200, { token_type: "Bearer" })
    );
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "rt" }, mock.fetch)
    ).rejects.toMatchObject({ code: "SPOTIFY_UPSTREAM_INVALID" });
  });

  it("maps other token-endpoint failures to SPOTIFY_UPSTREAM_FAILED", async () => {
    const mock = new MockSpotify().on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
      jsonResponse(500, { error: "server_error" })
    );
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "rt" }, mock.fetch)
    ).rejects.toMatchObject({ code: "SPOTIFY_UPSTREAM_FAILED" });
  });

  it("resolves local config only when all three settings are present", () => {
    const complete = runtimeWithSettings({
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_REFRESH_TOKEN: "rt",
    });
    expect(hasLocalConfig(complete)).toBe(true);
    expect(readLocalConfig(complete)).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "rt",
    });

    const partial = runtimeWithSettings({ SPOTIFY_CLIENT_ID: "id" });
    expect(hasLocalConfig(partial)).toBe(false);
    let caught: unknown;
    try {
      readLocalConfig(partial);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElizaError);
    expect((caught as ElizaError).code).toBe("SPOTIFY_CONFIG_MISSING");
  });
});

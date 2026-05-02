import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeHealthConnectorOAuth,
  HealthOAuthError,
  healthScopesToCapabilities,
  readStoredHealthToken,
  refreshStoredHealthToken,
  resolveHealthOAuthConfig,
  startHealthConnectorOAuth,
} from "./health-oauth.js";
import { isEncryptedTokenEnvelope } from "./token-encryption.js";

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;

function configureEnv(
  provider: "STRAVA" | "WITHINGS" | "FITBIT" = "STRAVA",
): void {
  process.env = {
    ...ORIGINAL_ENV,
    ELIZA_OAUTH_DIR: tmpDir,
    ELIZA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    [`ELIZA_${provider}_CLIENT_ID`]: `${provider.toLowerCase()}-client`,
    [`ELIZA_${provider}_CLIENT_SECRET`]: `${provider.toLowerCase()}-secret`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stateFrom(authUrl: string | null): string {
  if (!authUrl) {
    throw new Error("OAuth start did not return an authorization URL");
  }
  const state = new URL(authUrl).searchParams.get("state");
  if (!state) {
    throw new Error("OAuth authorization URL did not include state");
  }
  return state;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-health-oauth-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("health OAuth configuration", () => {
  it("resolves loopback local redirects and public remote redirects", () => {
    const local = resolveHealthOAuthConfig(
      "strava",
      new URL("http://127.0.0.1:31337/api/lifeops/connectors/health/status"),
      undefined,
      {
        ELIZA_STRAVA_CLIENT_ID: "client",
        ELIZA_STRAVA_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv,
    );
    expect(local).toMatchObject({
      provider: "strava",
      mode: "local",
      defaultMode: "local",
      configured: true,
      redirectUri:
        "http://127.0.0.1:31337/api/lifeops/connectors/health/strava/callback",
    });

    const remote = resolveHealthOAuthConfig(
      "strava",
      new URL("https://api.example.test/api/lifeops/connectors/health/status"),
      "remote",
      {
        ELIZA_STRAVA_CLIENT_ID: "client",
        ELIZA_STRAVA_CLIENT_SECRET: "secret",
        ELIZA_STRAVA_PUBLIC_BASE_URL: "https://public.example.test/",
      } as NodeJS.ProcessEnv,
    );
    expect(remote).toMatchObject({
      mode: "remote",
      defaultMode: "local",
      redirectUri:
        "https://public.example.test/api/lifeops/connectors/health/strava/callback",
    });
  });

  it("rejects local OAuth starts from non-loopback hosts", () => {
    configureEnv();

    expect(() =>
      startHealthConnectorOAuth({
        provider: "strava",
        agentId: "agent-1",
        side: "owner",
        mode: "local",
        requestUrl: new URL(
          "https://api.example.test/api/lifeops/connectors/health/strava/start",
        ),
      }),
    ).toThrow(HealthOAuthError);
  });

  it("generates Fitbit PKCE authorization URLs with health scopes", () => {
    configureEnv("FITBIT");

    const result = startHealthConnectorOAuth({
      provider: "fitbit",
      agentId: "agent-1",
      side: "owner",
      requestUrl: new URL("http://127.0.0.1:31337/api/lifeops"),
    });
    const url = new URL(result.authUrl ?? "");

    expect(url.origin).toBe("https://www.fitbit.com");
    expect(url.searchParams.get("scope")).toBe(
      "profile activity heartrate sleep weight",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.redirectUri).toBe(
      "http://127.0.0.1:31337/api/lifeops/connectors/health/fitbit/callback",
    );
  });

  it("maps Withings activity scope to activity and sleep capabilities", () => {
    expect(
      healthScopesToCapabilities("withings", ["user.metrics", "user.activity"]),
    ).toEqual([
      "health.activity.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ]);
  });
});

describe("health OAuth callback storage", () => {
  it("completes Strava OAuth, stores encrypted tokens, and refreshes expired tokens", async () => {
    configureEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "strava-access",
          refresh_token: "strava-refresh",
          token_type: "Bearer",
          expires_in: -60,
          scope: "read,activity:read_all",
          athlete: { id: 42, username: "runner" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "strava-access-refreshed",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read,activity:read_all",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const requestUrl = new URL(
      "http://127.0.0.1:31337/api/lifeops/connectors/health/strava/start",
    );
    const start = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-1",
      side: "owner",
      mode: "local",
      requestUrl,
    });
    const state = stateFrom(start.authUrl);

    const result = await completeHealthConnectorOAuth(
      new URL(
        `http://127.0.0.1:31337/api/lifeops/connectors/health/strava/callback?state=${state}&code=code-1`,
      ),
    );

    expect(result).toMatchObject({
      agentId: "agent-1",
      provider: "strava",
      side: "owner",
      mode: "local",
      identity: { username: "runner" },
      grantedCapabilities: ["health.activity.read", "health.workouts.read"],
      hasRefreshToken: true,
    });
    const filePath = path.join(tmpDir, "lifeops", "health", result.tokenRef);
    const raw = fs.readFileSync(filePath, "utf8");
    const onDisk = JSON.parse(raw) as unknown;
    expect(isEncryptedTokenEnvelope(onDisk)).toBe(true);
    expect(raw).not.toContain("strava-access");
    expect(raw).not.toContain("strava-refresh");
    expect(readStoredHealthToken(result.tokenRef)?.accessToken).toBe(
      "strava-access",
    );

    const refreshed = await refreshStoredHealthToken(result.tokenRef);

    expect(refreshed?.accessToken).toBe("strava-access-refreshed");
    expect(refreshed?.refreshToken).toBe("strava-refresh");
    const refreshedRaw = fs.readFileSync(filePath, "utf8");
    expect(refreshedRaw).not.toContain("strava-access-refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("unwraps Withings token exchange responses before storing tokens", async () => {
    configureEnv("WITHINGS");
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        status: 0,
        body: {
          access_token: "withings-access",
          refresh_token: "withings-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "user.metrics,user.activity",
          userid: 1234,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const start = startHealthConnectorOAuth({
      provider: "withings",
      agentId: "agent-1",
      side: "owner",
      mode: "local",
      requestUrl: new URL(
        "http://127.0.0.1:31337/api/lifeops/connectors/health/withings/start",
      ),
    });
    const state = stateFrom(start.authUrl);

    const result = await completeHealthConnectorOAuth(
      new URL(
        `http://127.0.0.1:31337/api/lifeops/connectors/health/withings/callback?state=${state}&code=code-1&userid=1234`,
      ),
    );

    expect(result.identity).toEqual({ userId: 1234 });
    expect(result.grantedCapabilities).toEqual([
      "health.activity.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ]);
    expect(readStoredHealthToken(result.tokenRef)?.accessToken).toBe(
      "withings-access",
    );
  });

  it("rejects callbacks without a pending OAuth session", async () => {
    await expect(
      completeHealthConnectorOAuth(
        new URL(
          "http://127.0.0.1:31337/api/lifeops/connectors/health/strava/callback?state=missing&code=code",
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "Unknown or expired health OAuth session.",
    });
  });
});

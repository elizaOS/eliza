import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  healthScopesToCapabilities,
  resolveHealthOAuthConfig,
  startHealthConnectorOAuth,
} from "./health-oauth.js";

describe("health OAuth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ELIZA_FITBIT_CLIENT_ID = "fitbit-client";
    process.env.ELIZA_FITBIT_CLIENT_SECRET = "fitbit-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("resolves local Strava OAuth callback from loopback requests", () => {
    const config = resolveHealthOAuthConfig(
      "strava",
      new URL("http://127.0.0.1:31337/api/lifeops"),
      undefined,
      {
        ELIZA_STRAVA_CLIENT_ID: "strava-client",
        ELIZA_STRAVA_CLIENT_SECRET: "strava-secret",
      } as NodeJS.ProcessEnv,
    );

    expect(config).toMatchObject({
      provider: "strava",
      mode: "local",
      defaultMode: "local",
      configured: true,
      redirectUri:
        "http://127.0.0.1:31337/api/lifeops/connectors/health/strava/callback",
    });
  });

  test("generates Fitbit PKCE authorization URL with health scopes", () => {
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

  test("maps Withings activity scope to activity and sleep capabilities", () => {
    expect(
      healthScopesToCapabilities("withings", [
        "user.metrics",
        "user.activity",
      ]),
    ).toEqual([
      "health.activity.read",
      "health.sleep.read",
      "health.body.read",
      "health.vitals.read",
    ]);
  });
});

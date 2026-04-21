import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  completeGoogleConnectorOAuth,
  startGoogleConnectorOAuth,
} from "../src/lifeops/google-oauth.js";

let oauthDir: string;
let env: NodeJS.ProcessEnv;

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function unsignedIdToken(claims: Record<string, unknown>): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart(claims)}.`;
}

function startOAuthCallback(): URL {
  const start = startGoogleConnectorOAuth({
    agentId: "google-oauth-test-agent",
    mode: "local",
    requestUrl: new URL("http://127.0.0.1:31337"),
    env,
  });
  const authUrl = new URL(start.authUrl);
  const state = authUrl.searchParams.get("state");
  if (!state) {
    throw new Error("Google OAuth start did not return state");
  }
  return new URL(
    `http://127.0.0.1:31337/api/lifeops/connectors/google/callback?state=${state}&code=test-code`,
  );
}

beforeEach(() => {
  oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-google-oauth-"));
  env = {
    ...process.env,
    ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID: "desktop-client-id",
    ELIZA_OAUTH_DIR: oauthDir,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(oauthDir, { recursive: true, force: true });
});

describe("Google OAuth callback identity", () => {
  test("rejects token exchange when neither ID token nor userinfo provides an email", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "access-token",
              expires_in: 3600,
              scope: "openid email profile",
              token_type: "Bearer",
            }),
            { status: 200 },
          );
        }
        if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
          return new Response(JSON.stringify({ name: "No Email" }), {
            status: 200,
          });
        }
        throw new Error(`Unexpected Google OAuth fetch: ${url}`);
      });

    await expect(
      completeGoogleConnectorOAuth({
        callbackUrl: startOAuthCallback(),
        env,
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: "Google identity payload did not include an email address.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uses email from ID token claims without calling userinfo", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (!url.includes("oauth2.googleapis.com/token")) {
          throw new Error(`Unexpected Google OAuth fetch: ${url}`);
        }
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
            id_token: unsignedIdToken({
              sub: "google-subject",
              email: "owner@example.com",
              name: "Owner",
            }),
            scope: "openid email profile",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      });

    const result = await completeGoogleConnectorOAuth({
      callbackUrl: startOAuthCallback(),
      env,
    });

    expect(result.identity).toMatchObject({
      email: "owner@example.com",
      name: "Owner",
      sub: "google-subject",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

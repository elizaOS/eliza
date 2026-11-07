/** Real HTTP and encrypted storage prove refresh-token rotation is single-flight. */

import fs from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeHealthConnectorOAuth,
  refreshStoredHealthToken,
  startHealthConnectorOAuth,
} from "../src/health-bridge/health-oauth.js";
import {
  resetHealthProviderRegistry,
  setHealthProviderSpec,
} from "../src/health-bridge/health-provider-registry.js";

const originalEnv = {
  oauthDir: process.env.ELIZA_OAUTH_DIR,
  clientId: process.env.ELIZA_STRAVA_CLIENT_ID,
  clientSecret: process.env.ELIZA_STRAVA_CLIENT_SECRET,
};

let oauthDir: string | undefined;
let server: Server | undefined;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

afterEach(async () => {
  resetHealthProviderRegistry();
  restoreEnv("ELIZA_OAUTH_DIR", originalEnv.oauthDir);
  restoreEnv("ELIZA_STRAVA_CLIENT_ID", originalEnv.clientId);
  restoreEnv("ELIZA_STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  if (oauthDir) {
    fs.rmSync(oauthDir, { recursive: true, force: true });
    oauthDir = undefined;
  }
});

describe("health OAuth refresh concurrency", () => {
  it("shares one rotating refresh and preserves an omitted scope", async () => {
    let refreshCalls = 0;
    server = createServer(async (request, response) => {
      const form = await readForm(request);
      response.setHeader("Content-Type", "application/json");
      if (form.get("grant_type") === "authorization_code") {
        response.end(
          JSON.stringify({
            access_token: "access-old",
            refresh_token: "refresh-once",
            expires_in: 0,
            scope: "activity:read",
          }),
        );
        return;
      }

      refreshCalls += 1;
      if (refreshCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        response.end(
          JSON.stringify({
            access_token: "access-new",
            refresh_token: "refresh-next",
            expires_in: 3600,
          }),
        );
        return;
      }
      response.writeHead(400);
      response.end(JSON.stringify({ error: "invalid_grant" }));
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    oauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-oauth-refresh-"));
    process.env.ELIZA_OAUTH_DIR = oauthDir;
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    setHealthProviderSpec({
      provider: "strava",
      envPrefix: "STRAVA",
      oauth: {
        authorizeUrl: "https://provider.example/authorize",
        tokenUrl,
        revokeUrl: null,
        defaultScopes: ["read", "profile:read_all", "activity:read_all"],
        scopeSeparator: "space",
        usePkce: false,
        tokenRequestStyle: "form",
      },
      apiBaseUrl: "https://provider.example/api",
      capabilities: ["health.activity.read"],
    });

    const started = startHealthConnectorOAuth({
      provider: "strava",
      agentId: "agent-1",
      side: "owner",
      mode: "local",
      requestUrl: new URL("http://127.0.0.1:31337/api"),
    });
    const state = new URL(started.authUrl).searchParams.get("state");
    const linked = await completeHealthConnectorOAuth(
      new URL(`http://127.0.0.1/callback?state=${state}&code=code`),
    );

    const refreshed = await Promise.all([
      refreshStoredHealthToken(linked.tokenRef),
      refreshStoredHealthToken(linked.tokenRef),
    ]);

    expect(refreshCalls).toBe(1);
    expect(refreshed.map((token) => token?.accessToken)).toEqual([
      "access-new",
      "access-new",
    ]);
    expect(refreshed.map((token) => token?.refreshToken)).toEqual([
      "refresh-next",
      "refresh-next",
    ]);
    expect(refreshed.map((token) => token?.grantedScopes)).toEqual([
      ["activity:read"],
      ["activity:read"],
    ]);
  });
});

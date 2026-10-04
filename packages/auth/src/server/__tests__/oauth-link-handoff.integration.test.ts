import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

test("link challenge returns allowlisted Google authorization with host-owned PKCE", async () => {
  const environment = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    GOOGLE_CLIENT_ID: "synthetic-link-client",
    GOOGLE_CLIENT_SECRET: "synthetic-link-secret",
  };
  const previous = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  const database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  try {
    const { tenants, tenantConfigs } = await import("../db/schema");
    const userId = "handoff-test-owner";
    const tenantId = `personal-${userId}`;
    const redirectUri = "https://eliza.app/link-callback";
    await database.db.insert(tenants).values({
      id: tenantId,
      name: "Synthetic test",
      apiKeyHash: randomBytes(32).toString("hex"),
    });
    await database.db
      .insert(tenantConfigs)
      .values({ tenantId, allowedRedirectUrls: [redirectUri] });
    const { userRoutes } = await import("../api/routes/user");
    const app = new Hono<{
      Variables: {
        userId: string;
        userSession: {
          userId: string;
          tenantId: string;
          mfaVerifiedAt: number;
        };
      };
    }>();
    app.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("userSession", { userId, tenantId, mfaVerifiedAt: Date.now() });
      await next();
    });
    app.route("/user", userRoutes);
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const response = await app.request(
      "/user/me/accounts/oauth/google/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    const url = new URL(body.data.authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("synthetic-link-client");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe(body.data.state);
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(JSON.stringify(body)).not.toContain("synthetic-link-secret");
    expect(body.data.codeVerifier).toBeUndefined();
  } finally {
    await database.client.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60_000);

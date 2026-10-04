import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { userRoutes } from "../api/routes/user";
import { oauthLinkChallenges } from "../api/services/account-link-stores";

const userId = "test-oauth-link-owner";
const tenantId = `personal-${userId}`;
const redirectUri = "https://eliza.app/callback";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
// Supply trusted middleware context; these tests exercise route admission, not JWT verification.
const app = new Hono<{
  Variables: {
    userId: string;
    userSession: { userId: string; tenantId: string; mfaVerifiedAt: number };
  };
}>();
app.use("*", async (c, next) => {
  c.set("userId", userId);
  c.set("userSession", { userId, tenantId, mfaVerifiedAt: Date.now() });
  await next();
});
app.route("/user", userRoutes);

function request(operation: string, body: object) {
  return app.request(`/user/me/accounts/oauth/google/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(extra: Record<string, unknown> = {}) {
  const state = randomUUID();
  await oauthLinkChallenges.setIfNotExists(
    `oauth-link:${userId}:${createHash("sha256").update(state).digest("hex")}`,
    JSON.stringify({
      userId,
      tenantId,
      providerName: "google",
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      ...extra,
    }),
  );
  return state;
}

test("route rejects malformed challenges before redirect/provider work", async () => {
  for (const body of [
    { codeChallenge: challenge, codeChallengeMethod: "plain" },
    { codeChallenge: challenge },
    { codeChallengeMethod: "S256" },
    { codeChallenge: `${challenge} `, codeChallengeMethod: "S256" },
  ]) {
    const result = await request("challenge", { redirectUri, ...body });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toBe(
      "OAuth link PKCE requires a valid S256 challenge",
    );
  }
});

test("route rejects mismatched verifier and consumes its challenge", async () => {
  const state = await seed();
  const body = {
    code: "synthetic-code",
    state,
    redirectUri,
    codeVerifier: "x".repeat(43),
  };
  const rejected = await request("token", body);
  expect(rejected.status).toBe(401);
  expect((await rejected.json()).error).toBe(
    "OAuth link code verifier mismatch",
  );
  const replay = await request("token", body);
  expect(replay.status).toBe(401);
  expect((await replay.json()).error).toBe(
    "Invalid or expired OAuth link state",
  );
});

test("route preserves tenant and provider bindings before verifier checks", async () => {
  for (const [extra, message] of [
    [{ tenantId: "another-tenant" }, "OAuth link state tenant mismatch"],
    [{ providerName: "github" }, "OAuth link state provider mismatch"],
  ] as const) {
    const state = await seed(extra);
    const result = await request("token", {
      code: "synthetic-code",
      state,
      redirectUri,
      codeVerifier: "x".repeat(43),
    });
    expect(result.status).toBe(401);
    expect((await result.json()).error).toBe(message);
  }
});

test("matching verifier reaches redirect validation, never bypasses it", async () => {
  const invalidRedirect = "javascript:untrusted";
  const state = await seed({ redirectUri: invalidRedirect });
  const result = await request("token", {
    code: "synthetic-code",
    state,
    redirectUri: invalidRedirect,
    codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  });
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body.ok).toBe(false);
  expect(body.error).toContain("redirect_uri");
});

test("bound route rejects missing and whitespace-modified verifiers", async () => {
  for (const codeVerifier of [
    undefined,
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk ",
  ]) {
    const state = await seed();
    const result = await request("token", {
      code: "synthetic-code",
      state,
      redirectUri,
      codeVerifier,
    });
    expect(result.status).toBe(401);
    expect((await result.json()).error).toBe(
      "OAuth link code verifier mismatch",
    );
  }
});

import { expect, test } from "bun:test";
import { OAuthClient } from "../auth/oauth";

const provider = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
  scopes: ["openid", "email", "profile"],
};
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const redirect = "https://eliza.app/link-callback";

test("caller-owned challenge is preserved for optional and mandatory PKCE providers", () => {
  for (const requiresPkce of [false, true]) {
    const client = new OAuthClient({ ...provider, requiresPkce });
    const result = client.generateAuthUrl("opaque-state", redirect, {
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(result.codeVerifier).toBeUndefined();
  }
});

test("internal required-PKCE generation remains available", () => {
  const result = new OAuthClient({
    ...provider,
    requiresPkce: true,
  }).generateAuthUrl("state", redirect);
  expect(result.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  expect(new URL(result.url).searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
});

test("malformed caller-owned challenge fails before authorization", () => {
  const client = new OAuthClient(provider);
  expect(() =>
    client.generateAuthUrl("state", redirect, {
      codeChallenge: "short",
      codeChallengeMethod: "S256",
    }),
  ).toThrow("valid S256");
});

test("optional-PKCE provider receives supplied verifier, with no real provider calls", async () => {
  const original = globalThis.fetch;
  const bodies: URLSearchParams[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return Response.json({
      access_token: "synthetic-token",
      token_type: "Bearer",
    });
  }) as typeof fetch;
  try {
    const client = new OAuthClient(provider);
    await client.exchangeCode("synthetic-code", redirect, verifier);
    expect(bodies[0]?.get("code_verifier")).toBe(verifier);
    expect(bodies[0]?.get("redirect_uri")).toBe(redirect);
    await client.exchangeCode("synthetic-code", redirect);
    expect(bodies[1]?.has("code_verifier")).toBe(false);
    await expect(client.exchangeCode("code", redirect, "bad")).rejects.toThrow(
      "Invalid PKCE",
    );
    await expect(
      new OAuthClient({ ...provider, requiresPkce: true }).exchangeCode(
        "code",
        redirect,
      ),
    ).rejects.toThrow("required");
    expect(bodies).toHaveLength(2);
  } finally {
    globalThis.fetch = original;
  }
});

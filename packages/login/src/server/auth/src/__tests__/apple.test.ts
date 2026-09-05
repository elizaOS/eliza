import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

// Apple verification reuses the shared OIDC JWKS transport. In production that
// transport performs DNS-based SSRF checks and a raw https GET; the test flag
// routes it through globalThis.fetch instead so we can mock Apple's JWKS. The
// flag is read at module-load time inside oidc.ts, so we set env vars FIRST and
// import the verifier dynamically (after) in beforeAll.
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW = process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH;

const CLIENT_ID = "com.example.service";

describe("verifyAppleIdToken", () => {
  let privateKey: CryptoKey | Uint8Array;
  let publicJwk: JWK;
  // A second, unrelated key whose public half is NOT published in the JWKS —
  // used to forge a token with a valid structure but an unverifiable signature.
  let attackerKey: CryptoKey | Uint8Array;
  let APPLE_ISSUER: string;
  let APPLE_JWKS_URI: string;
  let verifyAppleIdToken: typeof import("../apple").verifyAppleIdToken;
  let clearOidcJwksCacheForTests: typeof import("../oidc").clearOidcJwksCacheForTests;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH = "true";
    ({ APPLE_ISSUER, APPLE_JWKS_URI, verifyAppleIdToken } = await import(
      "../apple"
    ));
    ({ clearOidcJwksCacheForTests } = await import("../oidc"));

    const keyPair = await generateKeyPair("ES256");
    privateKey = keyPair.privateKey;
    publicJwk = (await exportJWK(keyPair.publicKey)) as JWK;
    publicJwk.kid = "apple-test-key";
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";

    const forged = await generateKeyPair("ES256");
    attackerKey = forged.privateKey;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === APPLE_JWKS_URI) return Response.json({ keys: [publicJwk] });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    // The JWKS set is cached by issuer; clear it so each test starts fresh.
    clearOidcJwksCacheForTests();
  });

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ALLOW === undefined)
      delete process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH;
    else process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH = ORIGINAL_ALLOW;
  });

  async function appleToken(
    overrides: {
      iss?: string;
      aud?: string;
      sub?: string;
      claims?: Record<string, unknown>;
      expiresIn?: string | number;
      issuedAt?: number;
      signWith?: CryptoKey | Uint8Array;
      kid?: string;
    } = {},
  ): Promise<string> {
    const builder = new SignJWT({
      email: "user@privaterelay.appleid.com",
      email_verified: "true",
      is_private_email: "true",
      ...overrides.claims,
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: overrides.kid ?? "apple-test-key",
      })
      .setIssuer(overrides.iss ?? APPLE_ISSUER)
      .setAudience(overrides.aud ?? CLIENT_ID)
      .setSubject(overrides.sub ?? "000123.abcdef.0001");
    if (overrides.issuedAt !== undefined)
      builder.setIssuedAt(overrides.issuedAt);
    else builder.setIssuedAt();
    builder.setExpirationTime(overrides.expiresIn ?? "5m");
    return builder.sign(overrides.signWith ?? privateKey);
  }

  // ─── Happy path ─────────────────────────────────────────────────────────────

  it("verifies a well-formed Apple id_token and normalizes claims", async () => {
    const token = await appleToken();
    const verified = await verifyAppleIdToken(token, { clientId: CLIENT_ID });
    expect(verified.subject).toBe("000123.abcdef.0001");
    expect(verified.email).toBe("user@privaterelay.appleid.com");
    // email_verified arrived as the string "true" — normalized to boolean true.
    expect(verified.emailVerified).toBe(true);
    expect(verified.isPrivateEmail).toBe(true);
  });

  it("normalizes a boolean email_verified claim", async () => {
    const token = await appleToken({
      claims: { email_verified: true, is_private_email: false },
    });
    const verified = await verifyAppleIdToken(token, { clientId: CLIENT_ID });
    expect(verified.emailVerified).toBe(true);
    expect(verified.isPrivateEmail).toBe(false);
  });

  it('treats a string "false" email_verified as not verified', async () => {
    const token = await appleToken({ claims: { email_verified: "false" } });
    const verified = await verifyAppleIdToken(token, { clientId: CLIENT_ID });
    expect(verified.emailVerified).toBe(false);
  });

  it("accepts a token with no email claim (Apple may omit it on re-auth)", async () => {
    const token = await appleToken({
      claims: { email: undefined, email_verified: undefined },
    });
    const verified = await verifyAppleIdToken(token, { clientId: CLIENT_ID });
    expect(verified.email).toBeUndefined();
    expect(verified.subject).toBe("000123.abcdef.0001");
  });

  // ─── Nonce binding ────────────────────────────────────────────────────────────

  it("accepts a matching nonce when one was issued", async () => {
    const token = await appleToken({ claims: { nonce: "login-nonce-123" } });
    const verified = await verifyAppleIdToken(token, {
      clientId: CLIENT_ID,
      expectedNonce: "login-nonce-123",
    });
    expect(verified.subject).toBe("000123.abcdef.0001");
  });

  it("fails closed when the nonce does not match", async () => {
    const token = await appleToken({ claims: { nonce: "attacker-nonce" } });
    await expect(
      verifyAppleIdToken(token, {
        clientId: CLIENT_ID,
        expectedNonce: "login-nonce-123",
      }),
    ).rejects.toThrow("nonce mismatch");
  });

  it("fails closed when a nonce was expected but the token carries none", async () => {
    const token = await appleToken();
    await expect(
      verifyAppleIdToken(token, {
        clientId: CLIENT_ID,
        expectedNonce: "login-nonce-123",
      }),
    ).rejects.toThrow("nonce mismatch");
  });

  // ─── Fail-closed verification corners ─────────────────────────────────────────

  it("rejects a token with the wrong issuer", async () => {
    const token = await appleToken({ iss: "https://evil.example.com" });
    await expect(
      verifyAppleIdToken(token, { clientId: CLIENT_ID }),
    ).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await appleToken({ aud: "com.other.service" });
    await expect(
      verifyAppleIdToken(token, { clientId: CLIENT_ID }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await appleToken({
      expiresIn: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      verifyAppleIdToken(token, { clientId: CLIENT_ID }),
    ).rejects.toThrow();
  });

  it("rejects a token signed by an unpublished key (bad signature)", async () => {
    const token = await appleToken({ signWith: attackerKey });
    await expect(
      verifyAppleIdToken(token, { clientId: CLIENT_ID }),
    ).rejects.toThrow();
  });

  it("rejects a token whose subject is missing", async () => {
    // Build a token without a `sub` claim.
    const token = await new SignJWT({ email: "x@privaterelay.appleid.com" })
      .setProtectedHeader({ alg: "ES256", kid: "apple-test-key" })
      .setIssuer(APPLE_ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyAppleIdToken(token, { clientId: CLIENT_ID }),
    ).rejects.toThrow("subject is missing");
  });

  it("rejects an empty id_token without performing any fetch", async () => {
    await expect(
      verifyAppleIdToken("", { clientId: CLIENT_ID }),
    ).rejects.toThrow("missing");
  });

  it("rejects when the client id is not configured", async () => {
    const token = await appleToken();
    await expect(verifyAppleIdToken(token, { clientId: "  " })).rejects.toThrow(
      "client id is not configured",
    );
  });
});

// ─── Apple through the OAuthClient (the path auth.ts actually uses) ────────────
//
// The standard OAuth callback does exchangeCode() then getUserInfo(access_token).
// For Apple (OIDC) the identity is the verified id_token captured during
// exchangeCode(); getUserInfo() ignores the access token and verifies the token.

describe("OAuthClient — Apple (OIDC id_token) provider", () => {
  const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
  const CLIENT = "com.example.service";

  let privateKey: CryptoKey | Uint8Array;
  let publicJwk: JWK;
  let OAuthClient: typeof import("../oauth").OAuthClient;
  let APPLE_ISSUER: string;
  let APPLE_JWKS_URI: string;
  let clearOidcJwksCacheForTests: typeof import("../oidc").clearOidcJwksCacheForTests;
  // Mutable id_token the mocked Apple token endpoint returns for the next call.
  let nextIdToken: string | null = "";

  function appleProvider() {
    return new OAuthClient({
      clientId: CLIENT,
      clientSecret: "apple-client-secret-jwt",
      authorizationUrl: "https://appleid.apple.com/auth/authorize",
      tokenUrl: APPLE_TOKEN_URL,
      userInfoUrl: APPLE_JWKS_URI,
      scopes: ["name", "email"],
      oidc: { issuer: APPLE_ISSUER, jwksUri: APPLE_JWKS_URI },
    });
  }

  async function makeIdToken(
    claims: Record<string, unknown> = {},
  ): Promise<string> {
    return new SignJWT({
      email: "relay@privaterelay.appleid.com",
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "apple-test-key" })
      .setIssuer(APPLE_ISSUER)
      .setAudience(CLIENT)
      .setSubject("000777.fedcba.0002")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH = "true";
    ({ OAuthClient } = await import("../oauth"));
    ({ APPLE_ISSUER, APPLE_JWKS_URI } = await import("../apple"));
    ({ clearOidcJwksCacheForTests } = await import("../oidc"));

    const keyPair = await generateKeyPair("ES256");
    privateKey = keyPair.privateKey;
    publicJwk = (await exportJWK(keyPair.publicKey)) as JWK;
    publicJwk.kid = "apple-test-key";
    publicJwk.alg = "ES256";
    publicJwk.use = "sig";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === APPLE_JWKS_URI) return Response.json({ keys: [publicJwk] });
      if (url.startsWith(APPLE_TOKEN_URL)) {
        const body: Record<string, unknown> = {
          access_token: "apple-access-token",
          token_type: "Bearer",
        };
        if (nextIdToken !== null) body.id_token = nextIdToken;
        return Response.json(body);
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    clearOidcJwksCacheForTests();
  });

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ALLOW === undefined)
      delete process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH;
    else process.env.STEWARD_ALLOW_INSECURE_OIDC_JWKS_FETCH = ORIGINAL_ALLOW;
  });

  it("verifies the id_token from exchangeCode and returns the normalized profile", async () => {
    nextIdToken = await makeIdToken();
    const client = appleProvider();
    const tokens = await client.exchangeCode("auth-code", "https://app.com/cb");
    expect(tokens.access_token).toBe("apple-access-token");
    const info = await client.getUserInfo(tokens.access_token);
    expect(info.id).toBe("000777.fedcba.0002");
    expect(info.email).toBe("relay@privaterelay.appleid.com");
    expect(info.verified_email).toBe(true);
  });

  it("binds verification to a login-request nonce", async () => {
    nextIdToken = await makeIdToken({ nonce: "the-login-nonce" });
    const client = appleProvider();
    await client.exchangeCode("auth-code", "https://app.com/cb");
    client.setExpectedNonce("the-login-nonce");
    const info = await client.getUserInfo("apple-access-token");
    expect(info.id).toBe("000777.fedcba.0002");
  });

  it("fails closed when the bound nonce does not match the id_token", async () => {
    nextIdToken = await makeIdToken({ nonce: "real-nonce" });
    const client = appleProvider();
    await client.exchangeCode("auth-code", "https://app.com/cb");
    client.setExpectedNonce("expected-different-nonce");
    await expect(client.getUserInfo("apple-access-token")).rejects.toThrow(
      "nonce mismatch",
    );
  });

  it("fails closed when the token response carries no id_token", async () => {
    nextIdToken = null; // omit id_token entirely
    const client = appleProvider();
    await expect(
      client.exchangeCode("auth-code", "https://app.com/cb"),
    ).rejects.toThrow("missing an id_token");
  });

  it("fails closed if getUserInfo runs before a successful exchangeCode", async () => {
    const client = appleProvider();
    await expect(client.getUserInfo("apple-access-token")).rejects.toThrow(
      "id_token unavailable",
    );
  });

  it("fails closed when the id_token has a bad signature", async () => {
    const forged = await generateKeyPair("ES256");
    nextIdToken = await new SignJWT({
      email: "x@privaterelay.appleid.com",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "ES256", kid: "apple-test-key" })
      .setIssuer(APPLE_ISSUER)
      .setAudience(CLIENT)
      .setSubject("000777.fedcba.0002")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(forged.privateKey);
    const client = appleProvider();
    await client.exchangeCode("auth-code", "https://app.com/cb");
    await expect(client.getUserInfo("apple-access-token")).rejects.toThrow();
  });
});

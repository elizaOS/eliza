/**
 * Tests `verifyBootstrapToken` fail-closed gates and the successful RS256
 * path: missing/whitespace env, short tokens, JWKS fetch and document
 * failures, claim/scope/container/expiry/replay rejections, store errors,
 * cached JWKS reuse, and a full claims round-trip. Mints real tokens with
 * `jose` and uses an in-memory `AuthStore` collaborator — the verifier itself
 * is never mocked.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthStore } from "../../services/auth-store";
import { type JwksKey, writeCachedJwks } from "../../services/cloud-jwks-store";
import {
  BOOTSTRAP_TOKEN_ALG,
  BOOTSTRAP_TOKEN_SCOPE,
  verifyBootstrapToken,
} from "./bootstrap-token";

const ISSUER = "https://cloud.test.example";
const CONTAINER_ID = "container-unit-1";

interface FakeAuthStore {
  seen: Set<string>;
  throwOnRecord: boolean;
  calls: Array<{ jti: string; now: number }>;
  recordJtiSeen(jti: string, now: number): Promise<boolean>;
}

function createFakeStore(): FakeAuthStore {
  const seen = new Set<string>();
  const calls: Array<{ jti: string; now: number }> = [];
  return {
    seen,
    throwOnRecord: false,
    calls,
    async recordJtiSeen(jti: string, now: number): Promise<boolean> {
      calls.push({ jti, now });
      if (this.throwOnRecord) throw new Error("store down");
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

function asAuthStore(store: FakeAuthStore): AuthStore {
  return store as unknown as AuthStore;
}

interface EnvHandle {
  env: {
    ELIZA_CLOUD_ISSUER?: string;
    ELIZA_CLOUD_CONTAINER_ID?: string;
    ELIZA_STATE_DIR: string;
  };
  stateDir: string;
}

const openHandles: string[] = [];

function openEnv(overrides: Partial<EnvHandle["env"]> = {}): EnvHandle {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-bootstrap-token-unit-"),
  );
  openHandles.push(stateDir);
  return {
    stateDir,
    env: {
      ELIZA_CLOUD_ISSUER: ISSUER,
      ELIZA_CLOUD_CONTAINER_ID: CONTAINER_ID,
      ELIZA_STATE_DIR: stateDir,
      ...overrides,
    },
  };
}

afterEach(() => {
  while (openHandles.length > 0) {
    const dir = openHandles.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

let privateKey: CryptoKey;
let publicJwk: JWK;
let attackerPrivateKey: CryptoKey;

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  const attacker = await generateKeyPair("RS256", { extractable: true });
  privateKey = real.privateKey as CryptoKey;
  attackerPrivateKey = attacker.privateKey as CryptoKey;
  publicJwk = await exportJWK(real.publicKey);
  publicJwk.kid = "unit-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function jwksFetch(
  body: unknown,
  status = 200,
  recorder?: string[],
): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    recorder?.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function okJwksFetch(recorder?: string[]): typeof fetch {
  return jwksFetch({ keys: [publicJwk] }, 200, recorder);
}

interface SignArgs {
  privateKey?: CryptoKey;
  iss?: string;
  sub?: string | null;
  containerId?: string | null;
  scope?: string | null;
  jti?: string | null;
  iat?: number;
  exp?: number;
  nbf?: number;
  kid?: string;
  alg?: "RS256" | "HS256";
}

async function sign(args: SignArgs = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {};
  if (args.sub !== null) claims.sub = args.sub ?? "user-1";
  if (args.containerId !== null) {
    claims.containerId = args.containerId ?? CONTAINER_ID;
  }
  if (args.scope !== null) claims.scope = args.scope ?? BOOTSTRAP_TOKEN_SCOPE;
  if (args.jti !== null) {
    claims.jti = args.jti ?? `jti-${Math.random().toString(36).slice(2)}`;
  }
  const jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: args.alg ?? "RS256",
      kid: args.kid ?? "unit-key",
    })
    .setIssuer(args.iss ?? ISSUER)
    .setIssuedAt(args.iat ?? now)
    .setExpirationTime(args.exp ?? now + 600);
  if (args.nbf !== undefined) jwt.setNotBefore(args.nbf);
  return jwt.sign(args.privateKey ?? privateKey);
}

describe("bootstrap-token constants", () => {
  it("pins RS256 and the bootstrap scope", () => {
    expect(BOOTSTRAP_TOKEN_ALG).toBe("RS256");
    expect(BOOTSTRAP_TOKEN_SCOPE).toBe("bootstrap");
  });
});

describe("verifyBootstrapToken env and token gates", () => {
  it("rejects when ELIZA_CLOUD_ISSUER is missing", async () => {
    const { env } = openEnv({ ELIZA_CLOUD_ISSUER: undefined });
    const result = await verifyBootstrapToken("token-long-enough", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_issuer_env" });
  });

  it("rejects a whitespace-only issuer after trim", async () => {
    const { env } = openEnv({ ELIZA_CLOUD_ISSUER: "   " });
    const result = await verifyBootstrapToken("token-long-enough", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_issuer_env" });
  });

  it("rejects when ELIZA_CLOUD_CONTAINER_ID is missing", async () => {
    const { env } = openEnv({ ELIZA_CLOUD_CONTAINER_ID: undefined });
    const result = await verifyBootstrapToken("token-long-enough", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_container_env" });
  });

  it("rejects a whitespace-only container id after trim", async () => {
    const { env } = openEnv({ ELIZA_CLOUD_CONTAINER_ID: " \t " });
    const result = await verifyBootstrapToken("token-long-enough", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_container_env" });
  });

  it("rejects an empty token as missing_token", async () => {
    const { env } = openEnv();
    const result = await verifyBootstrapToken("", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_token" });
  });

  it("rejects a token shorter than 8 characters as missing_token", async () => {
    const { env } = openEnv();
    const result = await verifyBootstrapToken("1234567", {
      env,
      authStore: asAuthStore(createFakeStore()),
    });
    expect(result).toEqual({ ok: false, reason: "missing_token" });
  });

  it("does not treat an 8-character token as missing_token", async () => {
    const { env } = openEnv();
    const result = await verifyBootstrapToken("12345678", {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: jwksFetch({ keys: [publicJwk] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("missing_token");
  });
});

describe("verifyBootstrapToken JWKS loading", () => {
  it("fails closed when the JWKS fetch throws", async () => {
    const { env } = openEnv();
    const token = await sign();
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: throwingFetch("network down"),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_fetch_failed" });
  });

  it("fails closed when the JWKS endpoint returns a non-OK status", async () => {
    const { env } = openEnv();
    const token = await sign();
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: jwksFetch({ keys: [publicJwk] }, 503),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_fetch_failed" });
  });

  it("fails closed when the JWKS body is not an object", async () => {
    const { env } = openEnv();
    const token = await sign();
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: jwksFetch(null),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_fetch_failed" });
  });

  it("fails closed when the JWKS keys field is not an array", async () => {
    const { env } = openEnv();
    const token = await sign();
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: jwksFetch({ keys: "nope" }),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_fetch_failed" });
  });

  it("fails closed when the JWKS document has an empty keys array", async () => {
    const { env } = openEnv();
    const token = await sign();
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: jwksFetch({ keys: [] }),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_fetch_failed" });
  });

  it("strips a trailing slash from the issuer only for the JWKS URL", async () => {
    const urls: string[] = [];
    const { env } = openEnv({
      ELIZA_CLOUD_ISSUER: `${ISSUER}/`,
    });
    // jwtVerify is given the unstripped issuer (`https://…/`). A token whose
    // `iss` omits the slash therefore fails closed as issuer_mismatch, even
    // though the JWKS fetch URL itself has the slash collapsed.
    const result = await verifyBootstrapToken(await sign({ iss: ISSUER }), {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(urls),
    });
    expect(result).toEqual({ ok: false, reason: "issuer_mismatch" });
    expect(urls).toEqual([`${ISSUER}/.well-known/jwks.json`]);
  });

  it("accepts a token whose iss matches a trailing-slash env issuer", async () => {
    const urls: string[] = [];
    const { env } = openEnv({
      ELIZA_CLOUD_ISSUER: `${ISSUER}/`,
    });
    const result = await verifyBootstrapToken(
      await sign({ iss: `${ISSUER}/` }),
      {
        env,
        authStore: asAuthStore(createFakeStore()),
        fetchImpl: okJwksFetch(urls),
      },
    );
    expect(result.ok).toBe(true);
    expect(urls).toEqual([`${ISSUER}/.well-known/jwks.json`]);
  });

  it("reuses a cached JWKS so a later fetch failure still verifies", async () => {
    const { env } = openEnv();
    const store = createFakeStore();
    const first = await verifyBootstrapToken(await sign({ jti: "cache-a" }), {
      env,
      authStore: asAuthStore(store),
      fetchImpl: okJwksFetch(),
    });
    expect(first.ok).toBe(true);

    const failing = throwingFetch("jwks offline after cache");
    const second = await verifyBootstrapToken(await sign({ jti: "cache-b" }), {
      env,
      authStore: asAuthStore(store),
      fetchImpl: failing,
    });
    expect(second.ok).toBe(true);
  });

  it("reads a pre-written JWKS cache without calling fetch", async () => {
    const { env } = openEnv();
    await writeCachedJwks(
      ISSUER,
      { keys: [publicJwk as JwksKey] },
      { env, now: Date.now() },
    );
    let fetchCalls = 0;
    const result = await verifyBootstrapToken(await sign(), {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: (async (input: Request | URL | string) => {
        fetchCalls += 1;
        throw new Error(`must not fetch ${String(input)}`);
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fetchCalls).toBe(0);
  });
});

describe("verifyBootstrapToken signature and claims", () => {
  it("accepts a valid RS256 token and returns the shaped claims", async () => {
    const { env } = openEnv();
    const store = createFakeStore();
    // jose validates `exp` against the system clock, not `options.now`.
    const nowMs = Date.now();
    const iat = Math.floor(nowMs / 1000) - 10;
    const exp = Math.floor(nowMs / 1000) + 600;
    const token = await sign({ jti: "accept-1", iat, exp });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(store),
      fetchImpl: okJwksFetch(),
      now: () => nowMs,
    });
    expect(result).toEqual({
      ok: true,
      claims: {
        iss: ISSUER,
        sub: "user-1",
        containerId: CONTAINER_ID,
        scope: "bootstrap",
        iat,
        exp,
        jti: "accept-1",
      },
    });
    expect(store.calls).toEqual([{ jti: "accept-1", now: nowMs }]);
  });

  it("trims padded issuer and container env before comparing claims", async () => {
    const { env } = openEnv({
      ELIZA_CLOUD_ISSUER: `  ${ISSUER}  `,
      ELIZA_CLOUD_CONTAINER_ID: `  ${CONTAINER_ID}  `,
    });
    const result = await verifyBootstrapToken(await sign(), {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a token signed by a different RS256 key", async () => {
    const { env } = openEnv();
    const token = await sign({ privateKey: attackerPrivateKey });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects an HS256 token as alg_not_allowed or signature_invalid", async () => {
    const { env } = openEnv();
    const now = Math.floor(Date.now() / 1000);
    const hsToken = await new SignJWT({
      sub: "user-x",
      containerId: CONTAINER_ID,
      scope: BOOTSTRAP_TOKEN_SCOPE,
      jti: "hs-jti",
    })
      .setProtectedHeader({ alg: "HS256", kid: "unit-key" })
      .setIssuer(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new Uint8Array(32).fill(9));
    const result = await verifyBootstrapToken(hsToken, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["alg_not_allowed", "signature_invalid"]).toContain(result.reason);
    }
  });

  it("rejects a compact JWT that is not a valid JWS", async () => {
    const { env } = openEnv();
    const result = await verifyBootstrapToken("not-a-valid-jws-token", {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["alg_not_allowed", "signature_invalid"]).toContain(result.reason);
    }
  });

  it("rejects a token whose issuer does not match the env issuer", async () => {
    const { env } = openEnv();
    const token = await sign({ iss: "https://other.example" });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "issuer_mismatch" });
  });

  it("rejects a token that jose already considers expired", async () => {
    const { env } = openEnv();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await sign({ iat: past - 60, exp: past });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a still-unexpired token when options.now is past exp", async () => {
    const { env } = openEnv();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60;
    const token = await sign({ iat, exp });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
      now: () => exp * 1000,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("maps a future nbf claim to claims_invalid", async () => {
    const { env } = openEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ nbf: now + 3600 });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "claims_invalid" });
  });

  it("rejects a verified token missing sub as claims_invalid", async () => {
    const { env } = openEnv();
    const token = await sign({ sub: null });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "claims_invalid" });
  });

  it("rejects a verified token missing jti as claims_invalid", async () => {
    const { env } = openEnv();
    const token = await sign({ jti: null });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "claims_invalid" });
  });

  it("rejects a verified token missing containerId as claims_invalid", async () => {
    const { env } = openEnv();
    const token = await sign({ containerId: null });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "claims_invalid" });
  });

  it("rejects a verified token with a non-bootstrap scope", async () => {
    const { env } = openEnv();
    const token = await sign({ scope: "admin" });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("rejects a verified token whose containerId does not match env", async () => {
    const { env } = openEnv();
    const token = await sign({ containerId: "container-other" });
    const result = await verifyBootstrapToken(token, {
      env,
      authStore: asAuthStore(createFakeStore()),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "container_mismatch" });
  });

  it("returns store_error when recordJtiSeen throws", async () => {
    const { env } = openEnv();
    const store = createFakeStore();
    store.throwOnRecord = true;
    const result = await verifyBootstrapToken(await sign(), {
      env,
      authStore: asAuthStore(store),
      fetchImpl: okJwksFetch(),
    });
    expect(result).toEqual({ ok: false, reason: "store_error" });
  });

  it("rejects a second presentation of the same jti as replay", async () => {
    const { env } = openEnv();
    const store = createFakeStore();
    const first = await verifyBootstrapToken(await sign({ jti: "once" }), {
      env,
      authStore: asAuthStore(store),
      fetchImpl: okJwksFetch(),
    });
    expect(first.ok).toBe(true);
    const second = await verifyBootstrapToken(await sign({ jti: "once" }), {
      env,
      authStore: asAuthStore(store),
      fetchImpl: okJwksFetch(),
    });
    expect(second).toEqual({ ok: false, reason: "replay" });
  });
});

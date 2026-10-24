/**
 * A cached JWKS written before the control plane rotated its signing key must
 * not reject a valid bootstrap token for the whole cache TTL. The verifier may
 * refetch the published set once, and only for a key id it does not hold.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCachedJwks } from "../../services/cloud-jwks-store";
import { verifyBootstrapToken } from "./bootstrap-token";

const ISSUER = "https://cloud.example";
const CONTAINER_ID = "container-1";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "eliza-jwks-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELIZA_STATE_DIR: stateDir,
    ELIZA_CLOUD_ISSUER: ISSUER,
    ELIZA_CLOUD_CONTAINER_ID: CONTAINER_ID,
  } as NodeJS.ProcessEnv;
}

async function keyPair(kid: string) {
  const pair = await generateKeyPair("RS256");
  return {
    privateKey: pair.privateKey,
    jwk: {
      ...(await exportJWK(pair.publicKey as CryptoKey)),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

async function bootstrapToken(privateKey: CryptoKey, kid: string, jti: string) {
  return new SignJWT({ containerId: CONTAINER_ID, scope: "bootstrap" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setSubject("user-1")
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function jwksServer(document: unknown, onFetch: () => void): typeof fetch {
  return (async () => {
    onFetch();
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const authStore = { recordJtiSeen: async () => true } as never;

describe("verifyBootstrapToken with a rotated signing key", () => {
  it("refetches the published JWKS once when the token names an unknown key", async () => {
    const oldKey = await keyPair("old-key");
    const newKey = await keyPair("new-key");
    // The volume holds a cache from before the rotation.
    await writeCachedJwks(ISSUER, { keys: [oldKey.jwk] }, { env: testEnv() });
    const token = await bootstrapToken(newKey.privateKey, "new-key", "jti-1");
    let fetches = 0;

    const result = await verifyBootstrapToken(token, {
      env: testEnv(),
      authStore,
      fetchImpl: jwksServer({ keys: [newKey.jwk] }, () => {
        fetches += 1;
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      claims: { iss: ISSUER, containerId: CONTAINER_ID, jti: "jti-1" },
    });
    expect(fetches).toBe(1);
  });

  it("still rejects a bad signature on a key it already holds, without refetching", async () => {
    const known = await keyPair("known-key");
    const attacker = await keyPair("known-key");
    await writeCachedJwks(ISSUER, { keys: [known.jwk] }, { env: testEnv() });
    const forged = await bootstrapToken(
      attacker.privateKey,
      "known-key",
      "jti-2",
    );
    let fetches = 0;

    const result = await verifyBootstrapToken(forged, {
      env: testEnv(),
      authStore,
      fetchImpl: jwksServer({ keys: [known.jwk] }, () => {
        fetches += 1;
      }),
    });

    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
    expect(fetches).toBe(0);
  });
});

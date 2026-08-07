/**
 * Unit coverage for the OIDC signing key ring against REAL generated keys and
 * the real jose import path — no mocks. Pins the two properties an OpenID
 * Provider cannot get wrong: element 0 is the signer, and every element stays
 * published so a rotation can overlap.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK, importJWK, jwtVerify, SignJWT } from "jose";

import {
  _resetOidcKeyCacheForTests,
  getOidcPublicJwks,
  getOidcSigner,
  getOidcSigningAlgorithms,
  getOidcVerificationKey,
  isOidcSigningConfigured,
} from "./keys";

function rsaJwk(kid: string): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...(privateKey.export({ format: "jwk" }) as object), kid, alg: "RS256" };
}

function ecJwk(kid: string): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...(privateKey.export({ format: "jwk" }) as object), kid, alg: "ES256" };
}

function setRing(keys: unknown[] | string): void {
  process.env.OIDC_SIGNING_JWKS = typeof keys === "string" ? keys : JSON.stringify(keys);
  _resetOidcKeyCacheForTests();
}

afterEach(() => {
  process.env.OIDC_SIGNING_JWKS = undefined;
  delete process.env.OIDC_SIGNING_JWKS;
  _resetOidcKeyCacheForTests();
});

describe("configuration", () => {
  test("reports unconfigured when the env var is absent", () => {
    delete process.env.OIDC_SIGNING_JWKS;
    _resetOidcKeyCacheForTests();
    expect(isOidcSigningConfigured()).toBe(false);
  });

  test("accepts base64-wrapped JSON, because Worker secrets travel badly with newlines", async () => {
    const ring = [rsaJwk("b64-key")];
    setRing(Buffer.from(JSON.stringify(ring), "utf8").toString("base64"));
    const signer = await getOidcSigner();
    expect(signer.kid).toBe("b64-key");
  });
});

describe("ring ordering", () => {
  test("element 0 signs and every element is published", async () => {
    setRing([rsaJwk("new-key"), rsaJwk("old-key")]);

    const signer = await getOidcSigner();
    expect(signer.kid).toBe("new-key");
    expect(signer.alg).toBe("RS256");

    const { keys } = await getOidcPublicJwks();
    expect(keys.map((key) => key.kid)).toEqual(["new-key", "old-key"]);
  });

  test("published keys carry no private material", async () => {
    setRing([rsaJwk("pub-check"), ecJwk("ec-check")]);
    const { keys } = await getOidcPublicJwks();
    for (const key of keys) {
      for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
        expect(key).not.toHaveProperty(member);
      }
      expect(key.use).toBe("sig");
    }
  });

  test("a token signed by a RETIRED key still verifies — the overlap that makes rotation safe", async () => {
    const outgoing = rsaJwk("outgoing");
    setRing([outgoing]);
    const outgoingSigner = await getOidcSigner();
    const token = await new SignJWT({ hello: "world" })
      .setProtectedHeader({ alg: "RS256", kid: outgoingSigner.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(outgoingSigner.key);

    // Rotate: new key first, outgoing key retained.
    setRing([rsaJwk("incoming"), outgoing]);
    expect((await getOidcSigner()).kid).toBe("incoming");

    const verificationKey = await getOidcVerificationKey("outgoing");
    expect(verificationKey).not.toBeNull();
    const { payload } = await jwtVerify(token, verificationKey as CryptoKey);
    expect(payload.hello).toBe("world");
  });

  test("an unknown kid resolves to no key rather than silently falling back to the signer", async () => {
    setRing([rsaJwk("only-key")]);
    expect(await getOidcVerificationKey("does-not-exist")).toBeNull();
  });

  test("advertised algorithms are computed from the ring, deduplicated", async () => {
    setRing([rsaJwk("r1"), rsaJwk("r2"), ecJwk("e1")]);
    expect(await getOidcSigningAlgorithms()).toEqual(["RS256", "ES256"]);
  });

  test("a published key verifies a token minted by the signer end to end", async () => {
    setRing([ecJwk("roundtrip")]);
    const signer = await getOidcSigner();
    const token = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: signer.alg, kid: signer.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer.key);

    const { keys } = await getOidcPublicJwks();
    const publicKey = await importJWK(keys[0], keys[0].alg);
    const { payload } = await jwtVerify(token, publicKey as CryptoKey);
    expect(payload.sub).toBe("u1");
  });
});

describe("fail-closed parsing", () => {
  test("a malformed ring throws instead of skipping to the next key", async () => {
    setRing("not json at all");
    await expect(getOidcSigner()).rejects.toThrow(/OIDC_SIGNING_JWKS/);
  });

  test("a symmetric key is refused — an RP must be able to verify from the public JWKS", async () => {
    setRing([{ kty: "oct", k: "c2VjcmV0", kid: "sym", alg: "HS256" }]);
    await expect(getOidcSigner()).rejects.toThrow(/symmetric/);
  });

  test("a public-only JWK is refused", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    setRing([{ ...(await exportJWK(publicKey)), kid: "pub-only", alg: "ES256" }]);
    await expect(getOidcSigner()).rejects.toThrow(/public key/);
  });

  test("duplicate kids are refused — a verifier could not tell the keys apart", async () => {
    setRing([rsaJwk("same"), rsaJwk("same")]);
    await expect(getOidcSigner()).rejects.toThrow(/duplicate kid/);
  });

  test("an empty ring is refused", async () => {
    setRing([]);
    await expect(getOidcSigner()).rejects.toThrow(/at least one/);
  });

  test("kid defaults to a JWK thumbprint when the operator omits it", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    setRing([{ ...(privateKey.export({ format: "jwk" }) as object) }]);
    const signer = await getOidcSigner();
    expect(signer.alg).toBe("ES256");
    expect(signer.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

/**
 * `alg` is operator-supplied and is published as
 * `id_token_signing_alg_values_supported`, so a value the key cannot actually
 * sign with would advertise a capability this provider does not have.
 */
describe("algorithm validation", () => {
  test("`alg: none` is refused", async () => {
    setRing([{ ...rsaJwk("unsigned"), alg: "none" }]);
    await expect(getOidcSigner()).rejects.toThrow(/alg "none"/);
    await expect(getOidcSigningAlgorithms()).rejects.toThrow(/alg "none"/);
  });

  test("a MAC algorithm on an asymmetric key is refused", async () => {
    setRing([{ ...rsaJwk("mac"), alg: "HS256" }]);
    await expect(getOidcSigner()).rejects.toThrow(/alg "HS256"/);
  });

  test("an encryption algorithm is refused", async () => {
    setRing([{ ...rsaJwk("enc"), alg: "RSA-OAEP" }]);
    await expect(getOidcSigner()).rejects.toThrow(/alg "RSA-OAEP"/);
  });

  test("an algorithm from the wrong curve is refused", async () => {
    // P-256 signs under ES256 alone; ES384 here would be advertised and then
    // fail at signing time, after the document was already cached by an RP.
    setRing([{ ...ecJwk("wrong-curve"), alg: "ES384" }]);
    await expect(getOidcSigner()).rejects.toThrow(/alg "ES384"/);
  });

  test("an RSA-PSS algorithm is accepted and advertised as itself", async () => {
    setRing([{ ...rsaJwk("pss"), alg: "PS256" }]);
    expect((await getOidcSigner()).alg).toBe("PS256");
    expect(await getOidcSigningAlgorithms()).toEqual(["PS256"]);
  });
});

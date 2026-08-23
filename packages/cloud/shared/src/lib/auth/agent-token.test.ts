/**
 * Covers agent token minting and the published JWKS.
 *
 * The property that matters most is negative: `getAgentTokenPublicJwk` exports
 * the signing key and must strip every private RSA parameter before publishing
 * it. Leaking `d` (or any CRT factor) from the JWKS endpoint would hand out the
 * key that mints agent tokens, so that stripping is asserted explicitly rather
 * than assumed.
 *
 * Beyond that: TTL is clamped to its documented window, agent ids are
 * validated before they reach the subject claim, and a minted token actually
 * verifies against the published JWK with the expected issuer/audience.
 *
 * Uses a real RSA keypair generated per suite — no stubbed crypto.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK, importJWK, jwtVerify } from "jose";

import {
  getAgentTokenJWKS,
  getAgentTokenKeyId,
  getAgentTokenPublicJwk,
  isAgentTokenSigningConfigured,
  mintAgentToken,
  normalizeAgentTokenTtl,
} from "./agent-token";

const PEM_ENV = "AGENT_TOKEN_PRIVATE_KEY_PEM";
const KID_ENV = "AGENT_TOKEN_KEY_ID";
const PRIVATE_PARAMS = ["d", "p", "q", "dp", "dq", "qi", "oth"] as const;

let previousPem: string | undefined;
let previousKid: string | undefined;

beforeAll(() => {
  previousPem = process.env[PEM_ENV];
  previousKid = process.env[KID_ENV];
  delete process.env[KID_ENV];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env[PEM_ENV] = privateKey as string;
});

afterAll(() => {
  if (previousPem === undefined) delete process.env[PEM_ENV];
  else process.env[PEM_ENV] = previousPem;
  if (previousKid === undefined) delete process.env[KID_ENV];
  else process.env[KID_ENV] = previousKid;
});

describe("normalizeAgentTokenTtl", () => {
  test("defaults to 15 minutes when no usable value is given", () => {
    for (const value of [undefined, null, "900", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizeAgentTokenTtl(value)).toBe(900);
    }
  });

  test("clamps to the documented 60s..3600s window", () => {
    expect(normalizeAgentTokenTtl(1)).toBe(60);
    expect(normalizeAgentTokenTtl(0)).toBe(60);
    expect(normalizeAgentTokenTtl(-9999)).toBe(60);
    expect(normalizeAgentTokenTtl(99_999)).toBe(3600);
    expect(normalizeAgentTokenTtl(60)).toBe(60);
    expect(normalizeAgentTokenTtl(3600)).toBe(3600);
  });

  test("floors a fractional TTL rather than rounding up", () => {
    expect(normalizeAgentTokenTtl(120.9)).toBe(120);
  });
});

describe("published JWKS", () => {
  test("reports signing as configured when a key is present", () => {
    expect(isAgentTokenSigningConfigured()).toBe(true);
  });

  test("never publishes private RSA parameters", async () => {
    const jwk = await getAgentTokenPublicJwk();
    for (const param of PRIVATE_PARAMS) {
      expect(jwk).not.toHaveProperty(param);
    }
    // Belt and braces: nothing private survives serialization either.
    const serialized = JSON.stringify(jwk);
    for (const param of PRIVATE_PARAMS) {
      expect(serialized).not.toContain(`"${param}":`);
    }
    expect(jwk.kty).toBe("RSA");
  });

  test("publishes the algorithm, use, and key id", async () => {
    const jwk = await getAgentTokenPublicJwk();
    expect(jwk.alg).toBe("RS256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe(await getAgentTokenKeyId());
  });

  test("derives a stable 16-character key id from the key itself", async () => {
    const first = await getAgentTokenKeyId();
    const second = await getAgentTokenKeyId();
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  test("wraps the public key in a single-entry JWKS", async () => {
    const jwks = await getAgentTokenJWKS();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toEqual(await getAgentTokenPublicJwk());
  });
});

describe("mintAgentToken", () => {
  test("mints a token that verifies against the published JWK", async () => {
    const { token } = await mintAgentToken("agent-1");
    const jwk = await getAgentTokenPublicJwk();
    const key = await importJWK(jwk, "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      issuer: "eliza-cloud",
      audience: "steward",
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(await getAgentTokenKeyId());
    expect(payload.sub).toBe("agent:agent-1");
    expect(payload.agent_id).toBe("agent-1");
    expect(payload.scope).toBe("agent");
    expect(payload.scopes).toEqual(["trade:order"]);
  });

  test("honours the clamped TTL in both exp and the reported expiry", async () => {
    const { token, expiresAt } = await mintAgentToken("agent-1", 60);
    const key = await importJWK(await getAgentTokenPublicJwk(), "RS256");
    const { payload } = await jwtVerify(token, key);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    expect(new Date(expiresAt).getTime()).toBe((payload.exp ?? 0) * 1000);
  });

  test("sets notBefore to the issue time", async () => {
    const key = await importJWK(await getAgentTokenPublicJwk(), "RS256");
    const { payload } = await jwtVerify((await mintAgentToken("agent-1")).token, key);
    expect(payload.nbf).toBe(payload.iat);
  });

  test("rejects an agent id outside the permitted character set", async () => {
    for (const agentId of ["", "   ", "bad id", "bad/id", "bad\nid", "a".repeat(129)]) {
      expect(mintAgentToken(agentId)).rejects.toThrow("invalid agentId");
    }
  });

  test("accepts the documented id characters and trims surrounding space", async () => {
    const key = await importJWK(await getAgentTokenPublicJwk(), "RS256");
    const { payload } = await jwtVerify((await mintAgentToken("  Agent_1.2:3-4  ")).token, key);
    expect(payload.agent_id).toBe("Agent_1.2:3-4");
  });

  test("does not verify against an unrelated key", async () => {
    const { token } = await mintAgentToken("agent-1");
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const foreign = await importJWK(await exportJWK(publicKey), "RS256");
    expect(jwtVerify(token, foreign)).rejects.toThrow();
  });
});

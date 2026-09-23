/**
 * Exercises real Ed25519 signing and verification of external dstack release
 * identity, including tampering, authority substitution and validity failures.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createDstackEvidenceProvider } from "./tee-dstack-evidence.ts";
import {
  DSTACK_RELEASE_SIGNATURE_DOMAIN,
  resolveDstackEvidenceConfiguration,
} from "./tee-dstack-release.ts";

const local = {
  socketPath: "/missing/guest.sock",
  verifierPath: "/verifier",
  verifierSha256: "aa".repeat(32),
  verifierConfigPath: "/verifier.toml",
  verifierConfigSha256: "bb".repeat(32),
  variant: "dstack-tdx",
};
function signedEnv(
  overrides: Record<string, unknown> = {},
  domain = DSTACK_RELEASE_SIGNATURE_DOMAIN,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity = {
    schemaVersion: 1,
    appId: "11".repeat(20),
    composeHash: "22".repeat(32),
    osImageHash: "33".repeat(32),
    variant: "dstack-tdx",
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(identity));
  return {
    ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
    ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify(local),
    ELIZA_DSTACK_RELEASE_PUBKEY: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    ELIZA_DSTACK_RELEASE_POLICY_JSON: JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(domain), payload]),
        privateKey,
      ).toString("base64"),
    }),
  };
}

describe("signed dstack deployment identity", () => {
  it("authenticates expected identity outside measured compose configuration", () => {
    const env = signedEnv();
    expect(
      JSON.parse(env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON).composeHash,
    ).toBeUndefined();
    const resolved = resolveDstackEvidenceConfiguration(env);
    expect(resolved.composeHash).toBe("22".repeat(32));
    expect(resolved.appId).toBe("11".repeat(20));
    expect(resolved.verifierSha256).toBe(local.verifierSha256);
  });
  it("rejects a modified identity with its original signature", () => {
    const env = signedEnv();
    const envelope = JSON.parse(env.ELIZA_DSTACK_RELEASE_POLICY_JSON);
    const body = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
    body.composeHash = "99".repeat(32);
    envelope.payload = Buffer.from(JSON.stringify(body)).toString("base64");
    env.ELIZA_DSTACK_RELEASE_POLICY_JSON = JSON.stringify(envelope);
    expect(() => resolveDstackEvidenceConfiguration(env)).toThrow(
      /Invalid dstack release/,
    );
  });
  it("rejects replacement authorities and signatures from another protocol", () => {
    const env = signedEnv();
    env.ELIZA_DSTACK_RELEASE_PUBKEY = signedEnv().ELIZA_DSTACK_RELEASE_PUBKEY;
    expect(() => resolveDstackEvidenceConfiguration(env)).toThrow();
    expect(() =>
      resolveDstackEvidenceConfiguration(signedEnv({}, "another-protocol")),
    ).toThrow();
  });
  it.each([
    "ELIZA_DSTACK_RELEASE_POLICY_JSON",
    "ELIZA_DSTACK_RELEASE_PUBKEY",
  ] as const)("requires %s under the CPU profile", (field) => {
    const env: Record<string, string | undefined> = signedEnv();
    delete env[field];
    expect(() => resolveDstackEvidenceConfiguration(env)).toThrow();
  });
  it.each([
    { expiresAt: new Date(0).toISOString() },
    { notBefore: new Date(Date.now() + 600_000).toISOString() },
    { variant: "dstack-nitro-enclave" },
    { unrecognizedPolicy: true },
  ])("rejects invalid signed release %j", (overrides) => {
    expect(() =>
      resolveDstackEvidenceConfiguration(signedEnv(overrides)),
    ).toThrow();
  });
  it("checks release expiration again on collection before opening any socket", async () => {
    const env = signedEnv({
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const provider = createDstackEvidenceProvider(
      resolveDstackEvidenceConfiguration(env),
    );
    await delay(1100);
    await expect(provider.collectEvidence()).rejects.toMatchObject({
      cause: {
        message: "Signed release identity is outside its validity interval",
      },
    });
  });
});

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRevocationBody,
  type TeeRevocationManifest,
} from "./tee-revocation.ts";
import { resolveTeeRuntimePolicy } from "./tee-runtime-config.ts";

describe("TEE runtime config", () => {
  it("loads an explicit policy from inline JSON and applies freshness env", async () => {
    await expect(
      resolveTeeRuntimePolicy({
        nowMs: 123,
        env: {
          ELIZA_TEE_POLICY_JSON: JSON.stringify({
            required: true,
            allowedKinds: ["dstack"],
          }),
          ELIZA_TEE_EXPECTED_NONCE: "nonce",
          ELIZA_TEE_MAX_AGE_MS: "60000",
        },
      }),
    ).resolves.toEqual({
      required: true,
      allowedKinds: ["dstack"],
      expectedNonce: "nonce",
      maxAgeMs: 60_000,
      nowMs: 123,
    });
  });

  it("builds policy from an OS release manifest path", async () => {
    await expect(
      resolveTeeRuntimePolicy({
        env: {
          ELIZA_TEE_RELEASE_MANIFEST_PATH: "/release.json",
          ELIZA_TEE_EXPECTED_NONCE: "nonce",
        },
        readText: async () =>
          JSON.stringify({
            tee: {
              enabled: true,
              providers: ["cove"],
              measurements: { agent: "sha256:abc" },
              requiredClaims: { secureBoot: true },
            },
          }),
      }),
    ).resolves.toMatchObject({
      required: true,
      allowedKinds: ["cove"],
      requiredMeasurements: { agent: "sha256:abc" },
      requiredClaims: { secureBoot: true },
      expectedNonce: "nonce",
    });
  });

  it("returns a fail-closed required policy when only ELIZA_TEE_REQUIRED is set", async () => {
    await expect(
      resolveTeeRuntimePolicy({
        env: { ELIZA_TEE_REQUIRED: "true" },
      }),
    ).resolves.toEqual({ required: true });
  });

  it("merges runtime revocations into release manifest policy", async () => {
    await expect(
      resolveTeeRuntimePolicy({
        env: {
          ELIZA_TEE_RELEASE_MANIFEST_JSON: JSON.stringify({
            tee: {
              enabled: true,
              providers: ["dstack"],
              measurements: {
                agent:
                  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
            },
          }),
          ELIZA_TEE_REVOCATIONS_JSON: JSON.stringify({
            schemaVersion: 1,
            revokedMeasurements: {
              agent: [
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              ],
            },
            revokedSecurityVersions: [1],
          }),
        },
      }),
    ).resolves.toMatchObject({
      required: true,
      allowedKinds: ["dstack"],
      revokedMeasurements: {
        agent: [
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
      },
      revokedSecurityVersions: [1],
    });
  });

  it("refuses an unsigned revocation manifest when a trusted authority pubkey is configured", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(
      resolveTeeRuntimePolicy({
        env: {
          ELIZA_TEE_REQUIRED: "true",
          ELIZA_TEE_REVOCATION_PUBKEY: pem,
          ELIZA_TEE_REVOCATIONS_JSON: JSON.stringify({
            schemaVersion: 1,
            revokedSecurityVersions: [1],
          }),
        },
      }),
    ).rejects.toThrow(/revocation manifest rejected: unsigned-manifest/);
  });

  it("merges a correctly signed revocation manifest under a configured authority", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest: TeeRevocationManifest = {
      schemaVersion: 1,
      authority: "eliza-revocation-authority",
      revokedSecurityVersions: [7],
    };
    const signature = sign(
      null,
      Buffer.from(canonicalizeRevocationBody(manifest), "utf8"),
      privateKey,
    ).toString("base64");
    await expect(
      resolveTeeRuntimePolicy({
        env: {
          ELIZA_TEE_REQUIRED: "true",
          ELIZA_TEE_REVOCATION_PUBKEY: pem,
          ELIZA_TEE_REVOCATION_AUTHORITY: "eliza-revocation-authority",
          ELIZA_TEE_REVOCATIONS_JSON: JSON.stringify({ ...manifest, signature }),
        },
      }),
    ).resolves.toMatchObject({
      required: true,
      revokedSecurityVersions: [7],
    });
  });
});

import { describe, expect, it } from "vitest";
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
});

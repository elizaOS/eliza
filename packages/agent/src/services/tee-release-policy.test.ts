import { describe, expect, it } from "vitest";
import { teePolicyFromReleaseManifest } from "./tee-release-policy.ts";

describe("TEE release manifest policy bridge", () => {
  it("builds an agent evidence policy from an OS release manifest TEE section", () => {
    const policy = teePolicyFromReleaseManifest(
      {
        tee: {
          enabled: true,
          providers: ["dstack", "tdx"],
          measurements: {
            boot: "sha256:aaa",
            os: "sha256:bbb",
            agent: "sha256:ccc",
            policy: "sha256:ddd",
          },
          requiredClaims: {
            debugDisabled: true,
            secureBoot: true,
            memoryEncrypted: true,
          },
          minSecurityVersion: 3,
        },
      },
      {
        expectedNonce: "nonce",
        maxAgeMs: 60_000,
        nowMs: 1_000,
      },
    );

    expect(policy).toEqual({
      required: true,
      allowedKinds: ["dstack", "tdx"],
      requiredMeasurements: {
        boot: "sha256:aaa",
        os: "sha256:bbb",
        agent: "sha256:ccc",
        policy: "sha256:ddd",
      },
      requiredClaims: {
        debugDisabled: true,
        secureBoot: true,
        memoryEncrypted: true,
      },
      minSecurityVersion: 3,
      expectedNonce: "nonce",
      maxAgeMs: 60_000,
      nowMs: 1_000,
    });
  });

  it("does not require TEE evidence when the release manifest has TEE disabled", () => {
    expect(
      teePolicyFromReleaseManifest({ tee: { enabled: false } }),
    ).toMatchObject({
      required: false,
    });
  });
});

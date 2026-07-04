/**
 * Covers mergeTeeRevocationsIntoPolicy folding a revocation manifest's revoked
 * measurements and security versions into an evidence policy (normalizing both
 * entry objects and bare values), and confirms evaluateTeeEvidencePolicy then
 * fails closed with reason "measurement-revoked" for a released artifact whose
 * digest was revoked. Deterministic, in-memory.
 */
import { describe, expect, it } from "vitest";
import { evaluateTeeEvidencePolicy } from "./tee-policy.ts";
import { mergeTeeRevocationsIntoPolicy } from "./tee-revocation.ts";

describe("TEE revocation manifest", () => {
  it("merges revoked measurements and security versions into an evidence policy", () => {
    const policy = mergeTeeRevocationsIntoPolicy(
      {
        required: true,
        requiredMeasurements: {
          agent:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      {
        schemaVersion: 1,
        authority: "eliza-tee-security",
        revokedMeasurements: {
          agent: [
            {
              value:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              reason: "superseded agent image",
              revokedAt: "2026-05-20T00:00:00.000Z",
            },
          ],
          os: [
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ],
        },
        revokedSecurityVersions: [{ value: 2 }, 4],
      },
    );

    expect(policy.revokedMeasurements).toEqual({
      agent: [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      os: [
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
    });
    expect(policy.revokedSecurityVersions).toEqual([2, 4]);
  });

  it("makes policy evaluation fail closed for revoked released artifacts", () => {
    const policy = mergeTeeRevocationsIntoPolicy(
      {
        required: true,
        requiredMeasurements: {
          agent:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      {
        schemaVersion: 1,
        revokedMeasurements: {
          agent: [
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ],
        },
      },
    );

    expect(
      evaluateTeeEvidencePolicy(
        {
          kind: "dstack",
          measurements: {
            agent:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
        policy,
      ),
    ).toMatchObject({
      trusted: false,
      reason: "measurement-revoked",
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clearTeeBootGateState,
  setTeeBootGateState,
} from "./tee-boot-gate-state.ts";
import type { TeeEvidence, TeeEvidenceProvider } from "./tee-evidence.ts";
import { LocalTeeKeyReleaseClient } from "./tee-key-release.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";
import {
  openSealedVolumeMetadata,
  STATE_VOLUME_KEY_ID,
  sealVolumeMetadata,
  unsealStateVolumeKey,
} from "./tee-sealed-volume.ts";

// A shared host master secret models dstack's KMS-side material: deterministic
// per measured identity, but the agent never holds it host-readably. Reusing
// one secret across clients proves the binding is to the MEASUREMENTS, not to a
// per-instance random secret.
const MASTER_SECRET_HEX = "11".repeat(32);

const TRUSTED_MEASUREMENTS = {
  agent: "sha256:agent-golden",
  policy: "sha256:policy-golden",
  device: "sha256:device-golden",
} as const;

function evidenceWith(measurements: Record<string, string>): TeeEvidence {
  return {
    kind: "tdx",
    provider: "dstack",
    hardwareVendor: "intel",
    securityVersion: 7,
    measurements,
    freshness: {
      nonce: "n1",
      timestamp: "2026-05-20T12:00:00.000Z",
      verifier: "intel-pcs",
    },
    claims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      productionLifecycle: true,
    },
  };
}

function providerFor(evidence: TeeEvidence): TeeEvidenceProvider {
  return {
    id: "fixture",
    collectEvidence: async () => evidence,
  };
}

function clientFor(
  evidence: TeeEvidence,
  masterSecretHex = MASTER_SECRET_HEX,
): LocalTeeKeyReleaseClient {
  return new LocalTeeKeyReleaseClient({
    evidenceProvider: providerFor(evidence),
    masterSecretHex,
  });
}

function policy(): TeeEvidencePolicy {
  return {
    required: true,
    allowedKinds: ["tdx"],
    nowMs: Date.parse("2026-05-20T12:00:05.000Z"),
    maxAgeMs: 60_000,
    requiredMeasurements: {
      agent: "sha256:agent-golden",
      policy: "sha256:policy-golden",
      device: "sha256:device-golden",
    },
    requiredClaims: { debugDisabled: true },
  };
}

afterEach(() => {
  clearTeeBootGateState();
});

describe("TEE sealed state-volume key release", () => {
  it("releases a 32-byte volume key on trusted evidence", async () => {
    const result = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
      policy: policy(),
      context: "milady-state",
    });
    expect(result.decision.trusted).toBe(true);
    expect(result.keyMaterialHex).toMatch(/^[a-f0-9]{64}$/);
  });

  it("derives a DIFFERENT key for a different agent/policy measurement (proves binding)", async () => {
    const golden = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
      policy: policy(),
    });

    // A tampered agent yields different evidence + a policy that gates it; the
    // SAME host master secret derives a different key, so the volume mounted
    // under the golden key cannot be opened.
    const tamperedMeasurements = {
      ...TRUSTED_MEASUREMENTS,
      agent: "sha256:agent-tampered",
    };
    const tamperedPolicy = policy();
    if (tamperedPolicy.requiredMeasurements) {
      tamperedPolicy.requiredMeasurements.agent = "sha256:agent-tampered";
    }
    const tampered = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(evidenceWith(tamperedMeasurements)),
      policy: tamperedPolicy,
    });

    expect(tampered.decision.trusted).toBe(true);
    expect(tampered.keyMaterialHex).not.toBe(golden.keyMaterialHex);
  });

  it("round-trips volume metadata with the right key and FAILS with a key from tampered evidence", async () => {
    const passphrase = Buffer.from("luks2-passphrase-secret-value", "utf8");

    const golden = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
      policy: policy(),
    });
    const sealed = sealVolumeMetadata({
      metadata: passphrase,
      keyMaterialHex: golden.keyMaterialHex,
    });

    // Same measured identity -> same released key -> metadata round-trips.
    const opened = openSealedVolumeMetadata(sealed, golden.keyMaterialHex);
    expect(opened.equals(passphrase)).toBe(true);

    // Tampered identity -> different released key -> GCM auth-tag failure: the
    // volume passphrase is unrecoverable, so the volume will not decrypt.
    const tamperedPolicy = policy();
    if (tamperedPolicy.requiredMeasurements) {
      tamperedPolicy.requiredMeasurements.device = "sha256:device-tampered";
    }
    const tampered = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(
        evidenceWith({
          ...TRUSTED_MEASUREMENTS,
          device: "sha256:device-tampered",
        }),
      ),
      policy: tamperedPolicy,
    });
    expect(tampered.keyMaterialHex).not.toBe(golden.keyMaterialHex);
    expect(() =>
      openSealedVolumeMetadata(sealed, tampered.keyMaterialHex),
    ).toThrow();
  });

  it("refuses release when teeBootGateBlocksSecrets() is true", async () => {
    setTeeBootGateState({
      policy: policy(),
      teeConfigured: true,
      required: true,
      productionProfile: true,
      decision: {
        trusted: false,
        reason: "measurement-mismatch",
        detail: "boot evidence not trusted",
      },
      secretsEnabled: false,
    });
    await expect(
      unsealStateVolumeKey({
        keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
        policy: policy(),
      }),
    ).rejects.toThrow(/TEE boot gate blocks secrets/);
  });

  it("refuses release when the policy decision is untrusted (measurement mismatch)", async () => {
    await expect(
      unsealStateVolumeKey({
        keyReleaseClient: clientFor(
          evidenceWith({
            ...TRUSTED_MEASUREMENTS,
            agent: "sha256:agent-tampered",
          }),
        ),
        // Policy still demands the golden agent digest, so the tampered
        // evidence is rejected and no key is released.
        policy: policy(),
      }),
      // The key-release client rejects the evidence and no key is released;
      // the refusal surfaces as the client's policy-rejection error.
    ).rejects.toThrow(/measurement "agent" does not match policy/);
  });

  it("surfaces an untrusted decision (not a thrown client error) as a denial", async () => {
    // A client that RETURNS an untrusted decision instead of throwing (the
    // shape a remote KMS uses) must still be refused by unsealStateVolumeKey.
    await expect(
      unsealStateVolumeKey({
        keyReleaseClient: {
          releaseKey: async (request) => ({
            keyId: request.keyId,
            keyMaterialHex: "",
            decision: {
              trusted: false,
              reason: "measurement-mismatch",
              detail: "device digest mismatch",
            },
          }),
        },
        policy: policy(),
      }),
    ).rejects.toThrow(/state-volume key release denied/);
  });

  it("refuses when the policy does not gate every required measurement", async () => {
    const weakPolicy = policy();
    delete weakPolicy.requiredMeasurements?.device;
    await expect(
      unsealStateVolumeKey({
        keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
        policy: weakPolicy,
      }),
    ).rejects.toThrow(
      /state-volume policy does not gate required measurements: device/,
    );
  });

  it("uses the dedicated state-volume key id", () => {
    expect(STATE_VOLUME_KEY_ID).toBe("state-volume");
  });

  it("fails closed when opening metadata with a corrupted envelope", async () => {
    const golden = await unsealStateVolumeKey({
      keyReleaseClient: clientFor(evidenceWith({ ...TRUSTED_MEASUREMENTS })),
      policy: policy(),
    });
    const sealed = sealVolumeMetadata({
      metadata: Buffer.from("luks2-passphrase", "utf8"),
      keyMaterialHex: golden.keyMaterialHex,
    });
    const corrupt = Buffer.from(sealed.ciphertextBase64, "base64");
    corrupt[0] ^= 0xff;
    expect(() =>
      openSealedVolumeMetadata(
        { ...sealed, ciphertextBase64: corrupt.toString("base64") },
        golden.keyMaterialHex,
      ),
    ).toThrow();
  });
});

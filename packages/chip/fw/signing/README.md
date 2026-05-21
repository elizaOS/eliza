# Firmware signing — Eliza chip

This directory contains the tooling scaffold for signing and verifying
Eliza chip firmware. **No firmware blob is signed automatically.** The
human-in-loop release process below produces a signed bundle a chip can
boot via secure boot.

SOC2 mapping: **CC6.1** (logical access — only authorized engineers can
trigger signing), **CC6.8** (firmware integrity), **CC8.1** (change
management — every signed firmware is tied to a build commit).

## Tooling

| File                  | Role                                                    |
| --------------------- | ------------------------------------------------------- |
| ``sign-firmware.sh``  | Sign a vetted firmware blob with the chip-firmware key. |
| ``verify-firmware.sh``| Verify a firmware blob + signature record.              |
| ``README.md``         | This file — attestation chain + open TODOs.             |

Both scripts shell out to the existing
``packages/security/scripts/kms-sign.ts`` /
``packages/security/scripts/kms-verify.ts`` shims. The KMS is currently
the LocalKmsAdapter (HKDF-derived Ed25519 over a passphrase root key).

## Algorithm choice

- **Default:** Ed25519. Compact (64-byte signatures, 32-byte public key)
  and fast to verify in a constrained boot ROM.
- **Alternative:** RSA-PSS-SHA256 with a 4096-bit key. Use when the
  silicon secure-boot ROM expects RSA (some vendor ROMs only support
  RSA-PKCS#1 / RSA-PSS).

Pick the algorithm at fab-time based on the boot ROM's hardware verify
support. Document the choice in ``packages/chip/AGENTS.md``.

## Attestation chain

The intended chain is:

```
[ Root of trust ]   - hardware-fused public key in the silicon mask ROM
        |
        v
[ Platform key ]    - signed by root; embedded in the immutable bootloader
        |
        v
[ Firmware key ]    - signed by platform; the key sign-firmware.sh uses
        |
        v
[ Firmware blob ]   - signed by firmware key; what verify-firmware.sh checks
```

Today only the **firmware key** step is wired up. The root-of-trust and
platform-key steps are open items:

  - The root public key needs to be embedded in the boot ROM mask;
    this is a tape-out concern that must be planned with the foundry.
  - The platform key needs to be provisioned on first boot and burned
    into one-time-programmable (OTP) fuses.

## Key rotation

- **Firmware key:** rotate every 365 days, or immediately on
  compromise. Rotation via ``KmsClient.rotateKey(systemKey('chip-firmware'))``.
- **Platform key:** rotate only at major-product-line revision (per
  tape-out). Cannot be rotated in the field without re-fusing.
- **Root key:** never rotated; failure mode is silicon respin.

Every rotation event must be recorded in the
``packages/training/SECURITY.md`` rotation log AND in the chip release
notes.

## Human-in-loop signing flow

1. Build the firmware blob deterministically from a known commit.
   Record the commit SHA and a SHA-256 of the blob.
2. Run static analysis + the on-device tests one final time. Block on
   any failures — the signing key must never sign untested firmware.
3. A release engineer with KMS passphrase access runs
   ``./sign-firmware.sh --in firmware.bin --out firmware.bin.sig``.
4. The signed bundle (``firmware.bin``, ``firmware.bin.sig``,
   ``firmware.bin.sig.json``, and the build metadata JSON) is uploaded
   to the release-artifact bucket; the signing operator notes the
   release in the security log.
5. The flasher tool runs ``./verify-firmware.sh`` against the bundle
   before writing to the device.

## Open TODOs (chip security)

  - [ ] Burn the root-of-trust public key into a silicon mask ROM
        revision and document the fingerprint.
  - [ ] Implement the platform-key OTP-fuse flow in the bootloader.
  - [ ] Wire ``verify-firmware.sh`` into the host-side flasher tool.
  - [ ] Implement on-device hardware verify (the boot ROM check) that
        mirrors the off-device check this scaffold exposes.
  - [ ] Move the firmware signing key from LocalKmsAdapter to a
        hardware-backed KMS (HSM or Steward-managed HSM-backed key).
  - [ ] Define the recovery flow for a compromised firmware key
        (revocation list, force re-pair to a new key version).

# E1 DICE Measurement Chain

Implements the TCG DICE / Open DICE Compound Device Identifier (CDI) ladder for
the Eliza E1 Root of Trust. The CDI math is real and known-answer validated; it
is not a stub. The one physical dependency is the silicon entropy that backs the
UDS — see [dice-rot-binding.md](dice-rot-binding.md) and §6 below.

Source: `fw/dice/cdi.{c,h}`, `fw/dice/ed25519_sign.{c,h}`. Tests:
`fw/dice/tests/test_cdi_chain.c`. Build: `fw/dice/Makefile`. Gate:
`dice-measurement-chain-check` (`scripts/check_dice_measurement_chain.py`).

This realizes the ladder specified in
[../../../security/tee-plan/02-root-of-trust.md](../../../security/tee-plan/02-root-of-trust.md)
§3 (measured boot chain) and §5 (DICE).

## 1. Ladder

```
 UDS  (32 B, key-manager-derived; never software-visible)
   |  CDI_BL1     = HKDF-SHA256(IKM=UDS,     salt=H(BL1),     info="E1-DICE-CDI-L0/BL1")
   v
 CDI_BL1
   |  CDI_BL2     = HKDF-SHA256(IKM=CDI_BL1, salt=H(BL2),     info="E1-DICE-CDI-BL2")
   v
 CDI_BL2
   |  CDI_monitor = HKDF-SHA256(IKM=CDI_BL2, salt=H(monitor), info="E1-DICE-CDI-MONITOR")
   v
 CDI_monitor
   |  DeviceID = Ed25519(seed = HKDF(IKM=CDI_monitor, info="E1-DICE-DeviceID-Ed25519"))
   |  Alias    = Ed25519(seed = HKDF(IKM=CDI_monitor, info="E1-DICE-Alias-Ed25519"))
   v
 X.509 cert chain:  DeviceID cert (creator-signed)  ->  Alias cert (per-boot)
```

Each transition is `CDI_next = HKDF-SHA256(IKM = CDI_prev, salt = stage
measurement, info = layer-domain-string)` (RFC 5869). Placing the stage
measurement in the HKDF *salt* and using a distinct *info* per layer means:

- **Determinism.** The same `(UDS, H(BL1), H(BL2), H(monitor))` always yields the
  same `CDI_monitor`, hence the same DeviceID and Alias keys. This is what lets a
  verifier predict the device's expected identity from a known-good firmware set.
- **Tamper divergence.** A single flipped bit in any measurement forks every
  downstream CDI and therefore every derived key. An attacker who swaps BL2
  cannot reproduce the per-device secrets — the cryptographic binding the prior
  static-key placeholder (`DEVICE_KEY_PLACEHOLDER`) could not provide.
- **Domain separation.** The per-layer `info` string prevents a CDI from one
  layer being substituted for another even if measurements collided.

## 2. Primitives

| Primitive | Implementation | Validation |
|---|---|---|
| SHA-256 | `fw/boot-rom/secure/sha256.c` (FIPS 180-4, freestanding, shared with the mask ROM) | exercised through HMAC/HKDF KATs |
| HMAC-SHA256 | `fw/dice/cdi.c` `hmac_sha256` (FIPS 198-1) | RFC 4231 test case 2 |
| HKDF-SHA256 | `fw/dice/cdi.c` `hkdf_sha256_{extract,expand}` (RFC 5869) | RFC 5869 test cases 1, 2, 3 (PRK and OKM) |
| Ed25519 keygen + deterministic sign | `fw/dice/ed25519_sign.c` (RFC 8032; SHA-512 included) | RFC 8032 §7.1 TEST 1 (public key and signature) |

The Ed25519 signer is a freestanding port of the public-domain TweetNaCl
sign/keypair path; the mask-ROM verifier (`fw/boot-rom/secure/ed25519_ct.h`) is
verify-only, so the signing side needed for cert issuance lives in the DICE
module. Both keypair derivation and signing were cross-checked against OpenSSL
and the `cryptography` library in addition to the RFC vector.

## 3. API

```c
/* CDI ladder */
int dice_derive_cdi(const uint8_t prev[32], const uint8_t measurement[32],
                    enum dice_layer layer, uint8_t next[32]);
int dice_walk_boot_chain(const uint8_t uds[32], const uint8_t h_bl1[32],
                         const uint8_t h_bl2[32], const uint8_t h_monitor[32],
                         struct dice_chain *out);

/* Identity keys (from CDI_monitor) */
int dice_derive_device_id(const uint8_t cdi_monitor[32],
                          uint8_t pubkey[32], uint8_t privkey[64]);
int dice_derive_alias(const uint8_t cdi_monitor[32],
                      uint8_t pubkey[32], uint8_t privkey[64]);
```

All functions are fail-closed: a NULL argument zeroes the output buffer and
returns `-1`; no path emits an undefined or partially-derived CDI/key. The
expanded Ed25519 private key is `seed(32) || pubkey(32)`; `ed25519_sign`
re-derives the clamped scalar from the seed and produces a deterministic
RFC 8032 signature suitable for signing X.509 TBS bytes.

## 4. Certificate chain shape

- **DeviceID certificate** — subject public key = DeviceID; created and signed
  once during manufacturing by the creator/AVB key
  (`docs/security/key-ceremony.md` §5: ATE requests a per-device attestation key
  signed by AVB key A). Stable for the life of the device.
- **Alias certificate** — subject public key = per-boot Alias key; issued each
  boot, signed by DeviceID. Because the Alias key is derived from `CDI_monitor`
  (which folds H(monitor)), the Alias cert attests the exact running monitor.
- Both are Ed25519 (RFC 8032) certificates. The chain `Alias <- DeviceID <-
  creator/AVB` is the `quote` / `certificatePem` of the attestation evidence.

## 5. Layer measurements

| Stage | Measurement | Source |
|---|---|---|
| BL1 | H(BL1) = SHA-256 of the verified BL1 image | mask ROM, after Ed25519 verify (02 §3) |
| BL2 | H(BL2) | BL1, after verify |
| monitor | H(monitor) = SHA-256 of the OpenSBI/confidential-domain monitor | BL2, after verify |

Measurements arrive already computed by the verified boot stages; the ladder
treats them as opaque 32-byte digests. The binding shim that wires the RoT key
manager and these measurements into the ladder is documented in
[dice-rot-binding.md](dice-rot-binding.md).

## 6. What feeds TeeEvidence, and the physical dependency

The Alias cert chain and the per-stage measurements populate the normalized
`TeeEvidence` shape (`packages/agent/src/services/tee-evidence.ts`), per 02 §6:
`measurements.boot` = SHA-256 of the concatenated boot digests,
`measurements.device` = DeviceID SPKI hash, `quote` / `certificatePem` = the
Alias cert chain.

The CDI/KDF/Ed25519 math above is complete and validated in software. The single
remaining dependency is physical: **UDS is rooted in silicon entropy** (SRAM PUF
/ OTP device secret, surfaced through the OpenTitan-class key manager and never
exported to software). On pre-silicon hosts the UDS is a supplied test value;
the ladder is identical, but a hardware-rooted UDS — and therefore a
hardware-unique DeviceID — is available only on real silicon. That dependency is
an entropy/keymgr property, not a gap in the CDI implementation.

## 7. Reproduce

```
source tools/env.sh
make -C fw/dice run        # host KATs + determinism + divergence; exit 0 on PASS
make -C fw/dice target     # freestanding riscv64-unknown-elf objects
python3 scripts/check_dice_measurement_chain.py   # regenerate the gate report
```

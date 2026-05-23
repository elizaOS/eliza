# DICE ↔ RoT Binding Shim

How the Eliza E1 Root of Trust feeds the DICE CDI ladder
([dice-chain.md](dice-chain.md)). This is the seam between the RTL-side RoT
(`docs/security/tee-plan/02-root-of-trust.md`) and the software CDI module
(`fw/dice/`): the RoT supplies one secret (UDS) and three measurements; the
ladder produces the CDIs and the DeviceID/Alias key material that populate
`TeeEvidence`.

## 1. Inputs the RoT must supply

| Input | Width | Producer | Path into the ladder |
|---|---|---|---|
| UDS | 32 B | Key manager (rooted in SRAM-PUF / OTP device secret) | `dice_walk_boot_chain(uds, …)` IKM for layer 0 |
| H(BL1) | 32 B | Mask ROM, SHA-256 of the Ed25519-verified BL1 image | salt for CDI_BL1 |
| H(BL2) | 32 B | BL1, SHA-256 of the verified BL2 image | salt for CDI_BL2 |
| H(monitor) | 32 B | BL2, SHA-256 of the verified OpenSBI/monitor | salt for CDI_monitor |

The ladder consumes these as opaque 32-byte values. It does not parse images,
verify signatures, or read OTP; those are the boot-stage responsibilities
defined in 02 §3. The shim's only job is to deliver the four values, in order,
without leaking the UDS.

## 2. UDS provenance — never exported

```
 SRAM-PUF helper data (OTP device_uid_parity)  +  OTP CreatorRootKey
        |
        v
   OpenTitan-class key manager  (keymgr)
        |  derives UDS inside the key-manager boundary
        v
   UDS  --(sideband, not a software-readable register)-->  dice_walk_boot_chain
```

- UDS is **derived inside the key manager** from the device-unique secret and is
  presented to the DICE ladder over a sideband, never through an AP- or
  software-readable register. This matches the SEP / Knox Vault "fused UID never
  exposed" model (02 §1, §5).
- On pre-silicon hosts there is no PUF, so the UDS is a supplied test vector
  (see `fw/dice/tests/test_cdi_chain.c`). The ladder code is identical; only the
  entropy source differs. A hardware-unique UDS — and therefore a
  hardware-unique DeviceID — exists only on real silicon. This is the single
  physical dependency of the DICE lane.
- Because the key manager advances its own ladder per stage (02 §3), the UDS
  fed here is the creator-stage secret; owner-stage separation
  (OwnerIntermediateKey/OwnerKey) is handled by keymgr upstream and does not
  change the CDI math.

## 3. Per-stage flow

```
 mask ROM:  verify(BL1); H(BL1)=SHA256(BL1); keymgr advance -> UDS available
            dice_derive_cdi(UDS,       H(BL1),     DICE_LAYER0)        -> CDI_BL1
 BL1:       verify(BL2); H(BL2)=SHA256(BL2)
            dice_derive_cdi(CDI_BL1,   H(BL2),     DICE_LAYER_BL2)     -> CDI_BL2
 BL2:       verify(monitor); H(monitor)=SHA256(monitor)
            dice_derive_cdi(CDI_BL2,   H(monitor), DICE_LAYER_MONITOR) -> CDI_monitor
            dice_derive_device_id(CDI_monitor, …)   -> DeviceID keypair
            dice_derive_alias(CDI_monitor, …)       -> per-boot Alias keypair
```

Each stage hands its CDI forward to the next. A failed verify halts the boot
(02 §3, fail-closed) before any CDI is derived for that stage — there is no
unsigned/unmeasured fallback, so the ladder never advances past a stage that did
not authenticate.

## 4. Populating TeeEvidence

The Alias key, the DeviceID cert, and the measurements map onto
`packages/agent/src/services/tee-evidence.ts` (02 §6):

| `TeeEvidence` field | Bound from |
|---|---|
| `measurements.boot` | `sha256:` of (rom_ctrl digest ‖ H(BL1) ‖ H(BL2)) |
| `measurements.monitor` | H(monitor) (the value folded into CDI_monitor) |
| `measurements.device` | DeviceID public-key (SPKI) hash |
| `quote` / `certificatePem` | Alias cert (subject = Alias pubkey) signed by DeviceID; chained to the creator/AVB cert |
| `freshness.nonce` | CSRNG nonce bound to `boot_counter` (RoT-side) |
| `claims.monitorMeasured` | true — H(monitor) is folded into CDI_monitor, so the Alias key cannot be reproduced for an unmeasured monitor |
| `claims.secureBoot` | true only when the §3 verify chain completed end-to-end (set by the RoT, not by this shim) |

`scripts/check_tee_attestation_evidence.py` validates the resulting evidence
shape. The Alias cert is per-boot and bound to the running monitor; the DeviceID
cert is the stable, creator-signed device identity
(`docs/security/key-ceremony.md` §5).

## 5. Boundary

This shim and the CDI ladder it drives are software, complete, and KAT-validated
(see [dice-chain.md](dice-chain.md) §2). The hardware obligations that remain are
RTL/silicon, not software:

- The key manager (`keymgr`) and its UDS derivation are RTL (02 §1, W1).
- The SRAM PUF and `device_uid_parity` helper data are silicon entropy.
- The CSRNG-drawn freshness nonce is RTL.

No secure-boot or hardware-rooted-identity claim is made from software alone;
this document defines the contract the RTL must satisfy to make those claims
true, and the exact ladder the RTL feeds.

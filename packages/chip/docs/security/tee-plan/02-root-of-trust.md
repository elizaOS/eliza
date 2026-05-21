# 02 — Root of Trust, Secure Boot, Provisioning & Lifecycle

Status: pre-silicon architecture plan. This document is a buildable plan, not
evidence of a working RoT. No claim of secure boot, hardware-backed key
storage, device identity, anti-rollback, or secure debug may be made from the
current tree (see `../arch/security.md`, `../security/secure-boot-lifecycle-evidence.md`).
Every milestone below fails closed against a named `make` gate; `BLOCKED`
means an artifact (RTL, firmware, sim, or lab) has not landed, not that a
feature regressed.

This is the foundation lane for the Eliza E1 TEE. It is consumed by:

- `01-tee-core-architecture.md` — confidential-domain monitor, ePMP/Smepmp,
  measured launch; depends on the boot-time measurements and key ladder
  defined here.
- `03-secure-io-iommu-npu.md` — IOPMP/IOMMU source-ID gating; depends on the
  RoT-owned device-assignment policy and key manager sideband keys.
- `04-side-channel-physical-hardening.md` — alert handler escalation, key/nonce
  scrubbing, masked crypto; refines the primitives selected here.
- `06-os-on-tee-software.md` — OpenSBI/monitor handoff, KeyMint/RPMB, AVB; the
  software consumer of this boot chain.

The agent-side normalized attestation shape is `TeeEvidence`
(`packages/agent/src/services/tee-evidence.ts`); §6 defines exactly which
fields this RoT populates.

---

## 0. Critical assessment of the current state

| Surface | Current artifact | Honest status |
|---|---|---|
| Mask boot ROM | `fw/boot-rom/reset.S`, `rtl/bootrom/e1_bootrom.sv` | Identity/contract ROM. Sets `mtvec`, jumps to a hardcoded `0x8000_0000` handoff word. No parse, no hash, no signature, no measurement. |
| Secure-boot firmware | `fw/pmc/src/secure_boot.c` | `pmc_secure_boot_verify()` is `return 0;` — accept-all stub. |
| Lifecycle RTL | `rtl/security/e1_lifecycle.sv` | 2-bit state machine. Debug auth is `challenge ^ DEVICE_KEY_PLACEHOLDER` (32-bit XOR with `0xA5A5_5A5A`). Challenge is an LFSR latched once. No OTP, no signature, no real entropy. |
| Image format / key ladder | `../security/boot-image-format.md` | Specified (Ed25519 + SHA-256, key ladder, rollback). Zero implementation. |
| OTP / fuse map | `../security/otp-fuse-map.md` | 4 kbit budget specified; no macro, no shadow registers, no write controller. |
| DICE | `build/reports/gate-dice-measurement-chain-check.json` (PASS) references `fw/dice/cdi.{c,h}`, `fw/dice/tests/test_cdi_chain.c`, `docs/sw/security/dice-chain.md` | A parallel lane owns the CDI ladder. Those source files are not yet on disk in this checkout; the prebuilt `build/dice/test_cdi_chain` binary exists. This plan binds to that lane's CDI contract rather than re-implementing it. |

Three structural defects dominate, and the rest of this plan exists to remove
them:

1. **No trust anchor.** Nothing in silicon is rooted in an immutable secret or
   an immutable public-key hash. The "device key" is a Verilog constant.
2. **No authenticated handoff.** Every stage transfer (ROM→firmware,
   firmware→OpenSBI) is an unconditional jump.
3. **Placeholder crypto.** XOR stands in for a MAC; an LFSR stands in for a
   CSRNG; a static word stands in for a key-manager-derived secret.

---

## 1. RoT integration decision

### Options

| Option | TCB | Effort | Risk |
|---|---|---|---|
| **A. Integrate OpenTitan Earl Grey-class Ibex secure subsystem as a discrete RoT block** | Ibex (RV32) + ROM + OTP ctrl + key manager + KMAC/HMAC/AES/OTBN + CSRNG/EDN/entropy_src + alert handler + lifecycle ctrl — a large but *audited, taped-out* TCB | High integration, low invention | Bus/clock-domain integration into the E1 SoC; tracking upstream; area/power of a second core |
| **B. From-scratch minimal RoT** | Small, but unaudited and unproven | Very high invention | Re-deriving constant-time crypto, masked AES, lifecycle, and entropy correctness — the exact mistakes OpenTitan already fixed |
| **C. Hybrid: OpenTitan crypto/OTP/lifecycle/key-manager IP blocks, reuse the E1 PMC (`fw/pmc`) as the security-CPU host instead of adding a second Ibex** | Medium TCB; PMC becomes security-critical | Medium | PMC currently runs DVFS/thermal/PMIC duties — coupling power management to the RoT widens the security boundary and is a bad split |

### Recommendation: **Option A — integrate an OpenTitan Earl Grey-class Ibex secure subsystem as a discrete RoT block.**

Rationale:

- The threat model (`../security/threat-model.md`) names bus-probe (T4),
  storage-replacement (T3), and lost/stolen (T5) adversaries and requires
  M1 (chained signature), M2 (rollback), M8 (debug auth), M10 (OTP write
  lock), M12 (RMA scrub). OpenTitan implements *exactly* this mitigation set
  in silicon-proven RTL (lifecycle in OTP, key manager key ladder, CSRNG,
  alert handler escalation with key/nonce scrubbing). Re-deriving it (Option B)
  multiplies invention against an already-large surface for no security gain.
- A *discrete* block (not the PMC) keeps the RoT TCB minimal and physically
  separable, matching the Apple SEP / Samsung Knox Vault integration model:
  dedicated processor, own boot chain, fused UID never exposed, anti-replay
  storage. Folding the RoT into the PMC (Option C) drags DVFS/PMIC/thermal
  firmware into the TCB — rejected.
- OpenTitan is open (Apache-2.0), RISC-V, and CLI-buildable with the toolchain
  already vendored (`scripts/bootstrap_ibex.sh` exists), so it fits the
  native-over-Docker rule and the "no unproven crypto claims" bar.

### Topology relative to CVA6 application cores and the PMC

```
                +-------------------------------------------------+
                |              E1 SoC (CVA6 AP cluster)           |
                |   app harts (Smepmp), DRAM, NPU, display, USB   |
                +---------------------+---------------------------+
                                      | TL-UL / mailbox + IOPMP src-IDs
        +-----------------------------+-----------------------------+
        |                E1-RoT (OpenTitan Earl Grey-class)         |
        |  Ibex (RV32IMC) | mask ROM | OTP ctrl+macro | lifecycle   |
        |  key manager | KMAC/HMAC | AES | OTBN | CSRNG/EDN/entropy |
        |  alert handler+escalation | flash/RPMB ctrl | DICE        |
        +-----------------------------+-----------------------------+
                                      | reset/measurement/secrets sideband
                +---------------------+---------------------------+
                |   PMC (fw/pmc)  — power/DVFS/thermal only,       |
                |   NOT in the RoT TCB; held in reset by RoT until |
                |   RoT releases the platform.                     |
                +-------------------------------------------------+
```

- **RoT holds the platform in reset.** On cold boot only the RoT Ibex runs its
  mask ROM. It verifies and measures BL1/BL2, programs IOPMP source-ID policy
  (feeds `03-secure-io-iommu-npu.md`), then releases the CVA6 cluster and the
  PMC from reset. This makes the RoT the single root that everything else
  stands on.
- **Mailbox, not shared memory, is the AP↔RoT interface.** A TL-UL mailbox
  carries attestation requests, key-release requests (KeyMint), and RMA
  commands. No AP-visible path to RoT internal SRAM, OTP secrets, or the key
  manager.
- **PMC is a client.** The RoT replaces `fw/pmc/src/secure_boot.c`'s role:
  the PMC no longer "verifies" anything; it receives an attested,
  RoT-authenticated DVFS table and runs unprivileged w.r.t. secrets.

---

## 2. Replace placeholder crypto

The XOR-hash / static-key / LFSR triad is removed wholesale and replaced with
OpenTitan-reused RTL plus an Ed25519+SHA-256 verifier in the mask ROM.

| Need | Placeholder today | Target primitive | Source |
|---|---|---|---|
| Image hash | XOR-fold (none in ROM) | SHA-256 | `kmac`/`hmac` SHA-256 mode; ROM software fallback for cold path |
| Image signature | none | Ed25519 verify (RFC 8032) per `boot-image-format.md` §1 | OTBN Ed25519 routine (constant-time); software ref in ROM for first-stage if OTBN not yet released |
| Symmetric integrity / KDF | none | KMAC-256 / HMAC-SHA256, HKDF-SHA256 | OpenTitan `kmac`, `hmac` |
| Bulk confidentiality (RPMB/storage wrap) | none | AES-256 (GCM/XTS) | OpenTitan `aes` (masked) |
| Entropy / nonces / challenge | 32-bit Galois LFSR | CSRNG ⇐ EDN ⇐ entropy_src (CTR_DRBG, health-tested) | OpenTitan `csrng`/`edn`/`entropy_src` |
| Device secret / key ladder | `DEVICE_KEY_PLACEHOLDER` constant | Key manager key ladder rooted in OTP `CreatorRootKey` + device-unique UID | OpenTitan `keymgr` |
| Lifecycle/secret scrubbing | none | Alert handler escalation → key/nonce wipe | OpenTitan `alert_handler` (refined in `04-side-channel-physical-hardening.md`) |

What is **reused as-is** from OpenTitan: `aes`, `hmac`, `kmac`, `csrng`,
`edn`, `entropy_src`, `keymgr`, `otp_ctrl`, `lc_ctrl`, `alert_handler`,
`rom_ctrl`. What is **E1-specific and must be written**: the mask-ROM image
parser/verifier for the `OPNPHN01` container (`boot-image-format.md` §2), the
TL-UL mailbox glue to the CVA6/PMC domains, and the IOPMP-policy programming
sequence. Masking/DPA hardening of `aes`/`kmac` is owned by
`04-side-channel-physical-hardening.md`; v0 keeps T9 (DPA/EM) an explicit
non-goal per the threat model.

OTBN-vs-software Ed25519 is a sequencing choice, not a correctness one: the
mask ROM must contain a constant-time software Ed25519 verifier so first-stage
verification has no dependency on OTBN being released from reset; OTBN
acceleration is an optimization for later stages.

---

## 3. Boot chain (measured + authenticated)

Each transition authenticates the next stage against a key chained to the OTP
root hash (M1) and extends a measurement register before transferring control.
This realizes the key ladder of `boot-image-format.md` §3 and produces the
measurements `01-tee-core-architecture.md` and §6 consume.

```
 RoT mask ROM (immutable)
   - read OTP: lifecycle, root_key_hash, debug_auth_pubkey_hash, rollback slots
   - if lifecycle == SCRAP -> halt (HALT: code=LIFECYCLE_SCRAP)
   - 2-of-3 majority-vote OTP read; parity fail -> HALT: code=OTP_PARITY
   - parse BL1 OPNPHN01 header; SHA-256(payload) == header.payload_sha256
   - SHA-256(sig.pubkey) == OTP.root_key_hash  (M1)
   - Ed25519 verify(sig over header||payload)
   - reject if header.rollback_index < OTP.rollback[slot]   (M2)
   - reject if key_id in OTP.revoked_key_bitmap
   - reject if lifecycle < header.min_lifecycle_state
   - keymgr: advance ladder with measurement(BL1) -> CreatorRootKey stage
   - extend boot measurement reg with H(BL1)
        | authenticated handoff (no fallback to unsigned)
        v
 BL1  -> verifies BL2 the same way; pin next_stage_pubkey_hash from BL1 header
       keymgr advance with measurement(BL2); extend measurement reg
        |
        v
 BL2  -> verifies OpenSBI/monitor payload (fw/opensbi-payloads/e1-smode,
         01-tee-core-architecture.md monitor); AVB vbmeta per avb-a-b-ota.md
       keymgr advance -> OwnerIntermediateKey/OwnerKey stages
       extend measurement reg; release CVA6 cluster + PMC from reset
        |
        v
 OpenSBI / confidential-domain monitor  (01 / 06)
```

- **Bind to device key.** At each `keymgr` advance the derived stage key is a
  function of (OTP `CreatorRootKey`, device-unique UID, the stage measurement).
  A tampered or downgraded image yields a *different* key ladder, so an
  attacker who swaps an image cannot reproduce the per-device secrets that
  unlock KeyMint blobs or attestation keys — this is the cryptographic binding
  the current static key cannot provide.
- **Measurements feed attestation.** The accumulated measurement register
  (`rom_ctrl` digest + keymgr-bound H(BL1), H(BL2), H(monitor)) is exported via
  the mailbox to populate `TeeEvidence.measurements.boot` (§6).
- **Fail-closed.** Every reject path halts hard and emits the 32-byte UART halt
  record of `boot-image-format.md` §6. No "secure mode bypass," no unsigned
  fallback. This is the negative evidence the gates in §7 require.

---

## 4. OTP / lifecycle / fuse map reconciliation

The plan adopts the richer `../security/otp-fuse-map.md` and
`../security/boot-image-format.md` §5 model and **deprecates the 2-bit encoding
in `rtl/security/e1_lifecycle.sv`** (which has only UNLOCKED/LOCKED/RMA/INVALID
and an XOR debug auth). Mapping the old block onto the canonical model:

| Canonical (otp-fuse-map.md) | Old `e1_lifecycle.sv` | Resolution |
|---|---|---|
| 8-bit one-hot BLANK/DEV/MFG/LOCKED/RMA/SCRAP | 2-bit UNLOCKED/LOCKED/RMA/INVALID | Replace with OpenTitan `lc_ctrl` states mapped to the 6 product states; old 2-bit field retired |
| `root_key_hash` @ bit 0 (256b) | none | OTP-backed; read by mask ROM |
| `debug_auth_pubkey_hash` @ 512 (256b) | `DEVICE_KEY_PLACEHOLDER` constant | OTP-backed Ed25519 pubkey hash; XOR auth replaced by signed challenge (`debug-policy.md` §4) |
| `rollback_*` unary counters @ 832.. | none | OTP monotonic, advance-only (M2) |
| `tamper_counter`, `boot_counter` | none | HW-driven, saturating |
| `device_uid_parity` @ 1024 (SRAM PUF) | static device key | Key manager + DICE UDS source |

- **Creator vs owner identity.** `root_key_hash` (creator) and the owner key
  set chained through `keymgr` (OwnerIntermediateKey/OwnerKey) implement
  OpenTitan creator/owner separation, which is what enables ownership transfer
  without re-fusing the creator root.
- **Anti-rollback.** Unary OTP counters per image_type; ROM/BL refuses
  `rollback_index < OTP.rollback[slot]` and advances fuses only after a
  verified successful boot (`boot-image-format.md` §4).
- **Write lock.** After MFG→LOCKED the one-time write window closes; only
  advance-only / HW-driven / signed-auth fields remain writable (M10,
  `otp-fuse-map.md` §4).
- **ECC/parity.** 2-of-3 majority on every security-critical field; mismatch is
  a hard fault before any signature uses the value.

---

## 5. DICE

This lane does **not** re-implement the CDI ladder; it binds to the existing
DICE lane (`build/dice/test_cdi_chain`, gate
`gate-dice-measurement-chain-check`, and the lane's `fw/dice/cdi.{c,h}` +
`docs/sw/security/dice-chain.md`). The RoT supplies the inputs that ladder
needs:

```
 SRAM-PUF / OTP device secret  --(keymgr, never exported)-->  UDS
        |
        | DICE: CDI_layer0 = KDF(UDS, H(BL1))
        v
   CDI_BL1  --> CDI_BL2 = KDF(CDI_BL1, H(BL2))
        |
        v
   CDI_monitor = KDF(CDI_BL2, H(monitor))   --> DeviceID / Alias key pair
        |
        v
   X.509 cert chain: DeviceID cert (creator-signed) -> Alias cert (per-boot)
```

- **UDS source.** Device-unique UID from SRAM PUF (with OTP `device_uid_parity`
  helper data), fed into `keymgr` so the UDS is never software-visible —
  matching SEP fused-UID-never-exposed model.
- **What feeds `TeeEvidence`.** The Alias cert chain plus the per-stage
  measurements become the `quote`/`certificatePem` and `measurements` of the
  attestation evidence (§6), consumed by `01-tee-core-architecture.md`'s
  attestation lane and validated against the agent shape by
  `scripts/check_tee_attestation_evidence.py`.

---

## 6. `TeeEvidence` population contract

The RoT/monitor must emit evidence that normalizes to
`packages/agent/src/services/tee-evidence.ts`. Concrete field mapping (kind is
the E1 keystone-class RISC-V RoT):

| `TeeEvidence` field | E1 RoT source |
|---|---|
| `kind` | `"keystone"` (RISC-V confidential-compute family; closest existing `TeeKind`) |
| `hardwareVendor` / `platformVersion` | `"elizaos-e1"` / RoT ROM + lifecycle version |
| `securityVersion` | max programmed rollback index across boot slots |
| `measurements.boot` | `sha256:` of (rom_ctrl digest ‖ H(BL1) ‖ H(BL2)) |
| `measurements.os` | H(OpenSBI/monitor) + kernel/initramfs digests (`06-os-on-tee-software.md`) |
| `measurements.agent` / `npuFirmware` | agent image + NPU fw digests (`03-secure-io-iommu-npu.md`) |
| `measurements.device` | DeviceID cert SPKI hash |
| `claims.secureBoot` | true only when the §3 chain verified end-to-end |
| `claims.debugDisabled` | true only when lifecycle==LOCKED and debug ports gated (`debug-policy.md` §2) |
| `claims.productionLifecycle` | true only when lifecycle==LOCKED |
| `claims.ioProtected` | true only when IOPMP source-ID policy programmed (`03`) |
| `freshness.nonce` | CSRNG-drawn nonce bound to `boot_counter` |
| `quote` / `certificatePem` | DICE Alias cert chain (§5) |

`scripts/check_tee_attestation_evidence.py` requires `boot/os/agent/policy/device`
measurements and true `debugDisabled/secureBoot/ioProtected` claims; this RoT
is the only component that may legitimately set those true.

---

## 7. Provisioning, RMA, and debug lockdown

- **Key ceremony / provisioning** follow `../security/key-ceremony.md` §3, §5
  unchanged: offline HSM root R (Ed25519), online HSM for A/V/O/debug-auth/RMA,
  ATE programs `root_key_hash`, `debug_auth_pubkey_hash`, initial rollback
  indices, `device_uid_parity`; MFG→LOCKED only after functional test pass.
- **Debug lockdown** follows `../security/debug-policy.md`. The XOR auth in
  `e1_lifecycle.sv` is replaced by the signed challenge-response of §4 there
  (Ed25519 over `"OPDBGv1" ‖ device_uid ‖ nonce ‖ caps`, nonce bound to
  `boot_counter`). LOCKED devices cannot be debugged directly.
- **RMA scrubs secrets before unlock.** `LOCKED→RMA` requires an OEM-signed
  authorization (`rma_key_hash`); programming the RMA bit triggers
  hardware-driven `keymgr`/storage scrub of KeyMint keyslots, user-data
  wrapping material, and attestation blobs; `rma_wipe_done` gates debug
  re-enable. This is the OpenTitan/Knox-style "destroy production secrets
  before unlock" RMA flow — there is no service unlock that preserves user
  data.

---

## 8. Work items

NEW files only. Effort in person-months (PM). Each ties to a fail-closed gate;
`BLOCKED` until the artifact lands. Existing gates referenced:
`bootrom-check`, `boot-security-chain-contract-check`,
`security-lifecycle-scope-check`, `dice-measurement-chain-check`,
`tee-attestation-evidence` (`scripts/check_tee_attestation_evidence.py`).

| # | Deliverable (NEW path) | Effort | Risk | Gate |
|---|---|---|---|---|
| W1 | `rtl/security/rot/` — OpenTitan Earl Grey-class subsystem integration wrapper (Ibex + rom_ctrl + otp_ctrl + lc_ctrl + keymgr + kmac/hmac/aes + csrng/edn/entropy_src + alert_handler) and TL-UL mailbox to CVA6/PMC | 8 PM | High (cross-domain integration) | new `rot-integration-check` (RTL elaboration + reset-release sequence) |
| W2 | `fw/boot-rom/secure/verify.c` + `ed25519_ct.c` + `sha256.c` — mask-ROM `OPNPHN01` parser, constant-time Ed25519 verify, SHA-256, fail-closed halt records | 3 PM | Med (constant-time correctness) | `bootrom-check`, `boot-security-chain-contract-check` |
| W3 | `fw/boot-rom/secure/measure.c` — measurement register extend + keymgr advance per stage; export to mailbox | 1.5 PM | Med | `boot-security-chain-contract-check` |
| W4 | `rtl/security/otp/e1_otp_map.sv` + `scripts/check_otp_fuse_map.py` — OTP shadow registers, 2-of-3 majority read, write controller per `otp-fuse-map.md` §4, parity-fault halt | 3 PM | Med | new `otp-fuse-map-check` |
| W5 | `rtl/security/lc/e1_lc_ctrl.sv` — replace 2-bit `e1_lifecycle.sv` with 6-state one-hot lc_ctrl mapping; signed debug-auth challenge | 2.5 PM | Med (retires existing block — coordinate with owners) | `security-lifecycle-scope-check` |
| W6 | `fw/dice/` integration shim (binds RoT UDS/measurements to the existing CDI lane; no re-impl) + `docs/sw/security/dice-rot-binding.md` | 1 PM | Low | `dice-measurement-chain-check` |
| W7 | `tests/security/negative/` — unsigned / tampered / wrong-key / corrupt / rollback rejection vectors + debug-locked transcript (the threat-model M1/M2/M8 negative evidence) | 2 PM | Low | `boot-security-chain-contract-check` (negative-evidence requirement) |
| W8 | `docs/spec-db/tee-attestation-evidence.e1-rot.json` — RoT-produced `TeeEvidence` fixture per §6 | 0.5 PM | Low | `tee-attestation-evidence` |
| W9 | `fw/provisioning/e1_provision.py` — ATE OTP programming + readback-verify per `key-ceremony.md` §5; RMA scrub sequence | 2 PM | Med | new `provisioning-readback-check` |

Total ≈ 23.5 PM. W2/W3/W4/W5 are the critical path that removes the three
structural defects in §0; W1 is the long-pole integration. Until W1–W3 and W7
land, `secure-boot-lifecycle-evidence.md` stays `BLOCKED` and no secure-boot
claim is permitted.

### Negative-evidence requirement (non-negotiable)

Per `../security/threat-model.md` §6 and `secure-boot-lifecycle-evidence.md`,
the first "development secure boot prototype" claim is gated on W7 producing
reproducible rejection transcripts for: unsigned image, tampered payload,
wrong key, corrupt header, rollback downgrade, and a debug-locked device
proving unlock denial + key erasure. A passing positive boot alone is
insufficient.

---

## 9. Cross-references

- `01-tee-core-architecture.md` — monitor, measured launch, attestation lane.
- `03-secure-io-iommu-npu.md` — IOPMP source-ID policy programmed by the RoT.
- `04-side-channel-physical-hardening.md` — masking, alert escalation, scrubbing.
- `06-os-on-tee-software.md` — OpenSBI/monitor handoff, KeyMint/RPMB, AVB.
- `../security/threat-model.md`, `../security/boot-image-format.md`,
  `../security/otp-fuse-map.md`, `../security/key-ceremony.md`,
  `../security/debug-policy.md`, `../security/secure-boot-lifecycle-evidence.md`,
  `../security/confidential-domain.md`, `../arch/security.md`.

# Security Path for E1 — Ranked Recommendations

Date: 2026-05-19

This document compiles the actionable recommendations from
`02_analysis/root_of_trust_landscape.md`,
`02_analysis/secure_boot_avb_otp.md`,
`02_analysis/pqc_and_crypto_accel.md`,
`02_analysis/tee_and_confidential_compute.md`, and
`02_analysis/side_channel_and_tamper.md` into a ranked implementation
plan tied to specific files under `docs/security/` and `docs/arch/security.md`.

Confidence levels follow the AGENTS.md convention:

- **HIGH** — externally validated by mature open IP / spec; the chip
  team owns only integration and DV work; recommended for v0.
- **MEDIUM** — clear direction, but requires non-trivial chip-team
  work (porting, new RTL, vendor IP licensing); plan for v1.
- **LOW** — research-grade or speculative; revisit in v2+ planning.

No recommendation below is implemented in repo today. The repository
state is the identity / contract ROM (`docs/arch/security.md`), the
pre-silicon specifications in `docs/security/*.md`, and the
fail-closed work order
`docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`.
All claims movement remains gated on the TC-* transcripts in
`docs/security/test-plan.md`.

## HIGH confidence (v0 / next chip generation; do these)

### H1. Adopt OpenTitan IP for the security core boot supervisor

**Source:** `02_analysis/root_of_trust_landscape.md` §2.

**Action:** Replace the identity-only `rtl/bootrom/e1_bootrom.sv` and
the absent OTP / lifecycle / key manager blocks with instantiations
of:

- OpenTitan `rom_ctrl` (SHA-3-scrambled ROM with integrity check)
- OpenTitan `lc_ctrl` (lifecycle controller; one-hot fault-resilient FSM)
- OpenTitan `otp_ctrl` (OTP controller with scrambling, ECC, partitions)
- OpenTitan `keymgr` (versioned key derivations)
- OpenTitan `aes` (masked first-order AES-256)
- OpenTitan `hmac` (SHA-2 family)
- OpenTitan `entropy_src` + `csrng` + `edn` (SP 800-90A/B compliant TRNG)
- Stock Ibex core for the security MCU
- Tock OS as the security-core firmware OS

**Why HIGH:** Apache-2.0 open IP, multiple silicon tape-outs through
the lowRISC program, DV grade tracked publicly per block. The team's
remaining work is integration with our TileLink bus and our specific
OTP fuse-map allocation; we do not have to re-design RoT primitives
from scratch.

**Docs touched:**

- `docs/arch/security.md` — replace "no security boundary" language
  with the OpenTitan integration plan; preserve the "identity ROM
  only today" disclaimer until RTL lands.
- `docs/security/boot-image-format.md` — §6 ROM halt behavior keeps
  its halt codes; add `TRNG_FAILED`, `ROM_INTEGRITY_FAILED`.
- `docs/security/otp-fuse-map.md` — note that the physical OTP layer
  becomes OpenTitan `otp_ctrl` semantics (scrambling per partition,
  ECC, token-gated lifecycle transitions). The current allocation
  table maps onto `otp_ctrl` partitions cleanly.
- `docs/security/debug-policy.md` — derived enable signals become
  mubi (multi-bit boolean) outputs from `lc_ctrl`.
- `docs/security/secure-boot-lifecycle-evidence.md` — most BLOCKED
  rows become unblocked when these RTL blocks land.

### H2. AVB 2.0 with libavb in BL2

**Source:** `02_analysis/secure_boot_avb_otp.md` §1.

**Action:** Implement BL2 as a libavb-driven verifier:

- Implement five `AvbOps` callbacks (`read_from_partition`,
  `get_unique_guid_for_partition`, `read_rollback_index`,
  `write_rollback_index`, `read_is_device_unlocked`).
- Wire `read_rollback_index` / `write_rollback_index` to the
  OpenTitan `otp_ctrl` rollback partition per `docs/security/otp-fuse-map.md`
  §1 offsets 832-944.
- Use Ed25519 for v0 signing; reserve `header_version=2` slot in
  `docs/security/boot-image-format.md` §2.1 for a future hybrid.
- Pass `androidboot.verifiedbootstate=green/yellow/orange/red` to kernel
  cmdline per `docs/security/avb-a-b-ota.md` §2.

**Why HIGH:** libavb is the AOSP reference. The chain partition
descriptors in `docs/security/avb-a-b-ota.md` §1 already encode the
expected layout. The work is well-scoped C and integration testing.

**Docs touched:** `docs/security/avb-a-b-ota.md`, `docs/security/boot-image-format.md`.
Test cases TC-BOOT-001 .. TC-BOOT-008, TC-ROLLBACK-001 .. TC-ROLLBACK-003,
TC-OTA-001 .. TC-OTA-004 become achievable in simulator-level transcripts.

### H3. Ed25519 verify on OTBN; SHA-256 via hardware HMAC

**Source:** `02_analysis/pqc_and_crypto_accel.md` §2.1, §2.4.

**Action:** Use OpenTitan's published OTBN Ed25519 verify program in
the boot path; use the `hmac` IP for SHA-256 image hashing. No
software-only crypto on the boot path.

**Why HIGH:** Verified reference code; constant-time; OTBN has masked
execution mode that gives free DPA-mitigation headroom without yet
claiming full SCA resistance.

**Docs touched:** `docs/security/boot-image-format.md` §1 algorithm
table — no change in algorithm names, but a note that the IP is OTBN +
HMAC, not software.

### H4. AVB hashtree + dm-verity for system / vendor / product

**Source:** `02_analysis/secure_boot_avb_otp.md` §1, §3.

**Action:** Standard AOSP `avbtool add_hashtree_footer` with FEC
enabled; mount with `restart_on_corruption`. `CONFIG_DM_VERITY` and
`CONFIG_DM_VERITY_FEC` in kernel.

**Why HIGH:** This is the AOSP default; the chip team only needs to
make sure the dm-verity hashtree fits within the BL2 verification
budget (system partition can be ~5 GB, so the hashtree is ~50 MB;
fits comfortably).

**Docs touched:** `docs/security/avb-a-b-ota.md` §1 (table already
specifies "yes (hashtree)").

### H5. ePMP/Smepmp + IOPMP across the SoC

**Source:** `02_analysis/tee_and_confidential_compute.md` §2, §3.

**Action:**

- Enable Smepmp on every RV hart (security core Ibex and AP cores).
- Place an IOPMP at the interconnect; every DMA-mastering peripheral
  (USB, eMMC/UFS, NPU, ISP, modem) sits behind an IOPMP entry.
- Default IOPMP policy: deny-by-default.

**Why HIGH:** Both are ratified RISC-V standards. ePMP is a build-time
configuration of the core; IOPMP is open IP available from the
RISC-V International reference.

**Docs touched:** `docs/security/threat-model.md` §4 — M5 (two-stage
OTA) and indirectly M3, M4 gain a hardware backstop. `docs/security/avb-a-b-ota.md`
§5 gains explicit IOPMP enforcement for staging.

### H6. SP 800-90B TRNG with halt-on-failure

**Source:** `02_analysis/pqc_and_crypto_accel.md` §4.

**Action:** Adopt OpenTitan `entropy_src` + `csrng` + `edn`. ROM
refuses to release control to BL1 if TRNG startup or continuous
health tests fail; add a new halt code `TRNG_FAILED` to
`docs/security/boot-image-format.md` §6.

**Why HIGH:** SP 800-90A/B is the relevant standard; OpenTitan IP is
compliant; adopting it removes the need to write SP 800-90B health
tests from scratch.

### H7. DICE / Open DICE measurement chain

**Source:** `02_analysis/tee_and_confidential_compute.md` §9.

**Action:** Each boot stage performs a DICE CDI derivation rooted in
the PUF-derived UDS (stored as `device_uid_parity` per
`docs/security/otp-fuse-map.md` §1). Use Google's Open DICE library;
emit attestation certificates in COSE_Sign1 format.

**Why HIGH:** Open DICE is small (~1500 LOC), Apache-2.0; the
attestation primitive is well-specified by TCG; KeyMint attestation
chain at the top of the DICE chain is the AOSP-standard pattern.

**Docs touched:** `docs/security/key-ceremony.md` §5 — note that the
per-device attestation key is derived from PUF + DICE chain rather
than provisioned independently.

### H8. Synthetic OTP / fuse model for Sky130 prototype

**Source:** `02_analysis/secure_boot_avb_otp.md` §6.

**Action:** For any Sky130 / OpenLane prototype run, model the OTP as
a deterministic "fuse RAM" backed by simulator state, with a clear
non-production label in the RTL header. This unblocks the test plan
(TC-BOOT-*, TC-ROLLBACK-*, TC-DEBUG-*) at simulator granularity
without claiming a production OTP.

**Why HIGH:** Necessary because no Sky130-compatible OTP macro exists
in the open PDK. The synthetic model has to land alongside H1
regardless.

**Docs touched:** `docs/arch/security.md` — add a section explicitly
labeling the OpenLane prototype OTP as synthetic.

## MEDIUM confidence (v1; design now, ship in next generation)

### M1. Move to an intermediate node for production OTP

**Source:** `02_analysis/secure_boot_avb_otp.md` §6.

**Action:** Production E1 (LOCKED-capable) targets an intermediate node
(TSMC N12 / N6, GF22FDX) where a vendor OTP macro is available. Sky130
prototype remains for bring-up only; cannot ship to consumers.

**Why MEDIUM:** Process selection has wider implications (PD, package,
EMC, BOM cost). The decision spans more than just security.

**Docs touched:** `docs/architecture-optimization/compute-silicon.md`,
`docs/risks/risk-register.md`.

### M2. PQC verify in OTBN firmware (ML-DSA-65)

**Source:** `02_analysis/pqc_and_crypto_accel.md` §3.2.

**Action:** Add an OTBN firmware program for ML-DSA-65 (FIPS 204)
verify. Update `docs/security/boot-image-format.md` §2.1 to accept
`header_version=2` images carrying both Ed25519 and ML-DSA-65
signatures (hybrid). BL1/BL2 verify both; ROM remains Ed25519-only
until v2.

**Why MEDIUM:** PQC firmware-signing has not yet been adopted by
AOSP. We can ship it ourselves but the larger PQ ecosystem (AVB 3.0,
KeyMint, Play Integrity) isn't there yet. Hybrid is the safe
intermediate.

**Docs touched:** `docs/security/boot-image-format.md`, `docs/security/key-ceremony.md`
(HSM must hold ML-DSA-65 keys alongside Ed25519).

### M3. OP-TEE or Keystone for KeyMint TEE

**Source:** `02_analysis/tee_and_confidential_compute.md` §4, §11.

**Action:** Choose between:

- **Keystone** (smaller TCB, RV-native, OpenSBI-integrated SM, no
  KeyMint TA today).
- **OP-TEE** (larger TCB, KeyMint TA available, RV port experimental).

Recommended path: Keystone + custom KeyMint TA implementation in Rust
(reusing AOSP-libkmsteward or writing a small TA against KeyMint HAL).

**Why MEDIUM:** KeyMint TA implementation is non-trivial (multi-month
effort for full AOSP compliance), but the foundation (Keystone SM) is
mature.

**Docs touched:** `docs/security/threat-model.md` (§5 KeyMint TEE-only
becomes concrete: the TA implementation), `docs/security/debug-policy.md`
§5 (RMA wipe touches KeyMint key blobs).

### M4. OpenTitan masked AES + glitch detectors on security core

**Source:** `02_analysis/side_channel_and_tamper.md` §3.2, §3.4, §9.

**Action:** When migrating to the production node, adopt:

- OpenTitan `aes` masked AES core (first-order DPA mitigation).
- OpenTitan analog wrapper (Vcc OVP/UVP, clock glitch, temperature).
- Mubi-encoded state machines for boot-decision points.

**Why MEDIUM:** Requires the production analog flow, which is process-
dependent and not available on Sky130. The IP is open; the flow is
the constraint.

**Docs touched:** `docs/security/threat-model.md` moves T9 (DPA/EM)
from non-goal to in-scope, with citations of the IP.

### M5. RISC-V H-extension + AIA on the AP for TEE

**Source:** `02_analysis/tee_and_confidential_compute.md` §7.

**Action:** Build Rocket with Hypervisor + Smaia/Ssaia/Sscofpmf enabled.
Required for Keystone-VM and any path forward to CoVE.

**Why MEDIUM:** All upstream Rocket; no new IP. Costs perf-counter
budget and an interrupt-controller change. Cross-cuts with
`research/cpu_subsystem_2026/`.

**Docs touched:** `docs/arch/cpu-subsystem.md`, `docs/arch/linux-capable-cpu-contract.md`.

### M6. LPDDR controller with TRR/RFM (RowHammer mitigation)

**Source:** `02_analysis/side_channel_and_tamper.md` §5.

**Action:** LPDDR5 / LPDDR5X controller selection must support TRR
and RFM. Cross-cuts `research/memory_subsystem_2026/`.

**Docs touched:** memory-subsystem spec, not security spec directly.

### M7. SPDM for off-chip device attestation

**Source:** `02_analysis/tee_and_confidential_compute.md` §10.

**Action:** Embed an SPDM responder/requester library (e.g.,
spdm-rs, libspdm) in the security core firmware, ready to negotiate
attested sessions with future external devices (modem, external NPU).
Inactive in v0 (no external attested devices) but the code path is
present for v1.

**Why MEDIUM:** Useful only when an external attested device exists.
Adding it pre-emptively means less firmware churn at v1.

## LOW confidence (v2+; research and watch)

### L1. CHERIoT-Ibex as security MCU

**Source:** `02_analysis/root_of_trust_landscape.md` §5.

**Action:** Migrate security core from stock Ibex to CHERIoT-Ibex once
CHERIoT silicon track is more mature.

**Why LOW:** Research-grade today; OpenTitan IP would need integration
work against the CHERI load/store changes.

### L2. RISC-V CoVE confidential VMs

**Source:** `02_analysis/tee_and_confidential_compute.md` §5.

**Action:** Track CoVE spec ratification; plan for MPT (memory
protection tree) RTL once CoVE is ratified.

**Why LOW:** CoVE itself is not ratified; mainline Rocket / BOOM lack
MPT. v2+.

### L3. Inline LPDDR memory encryption

**Source:** `02_analysis/tee_and_confidential_compute.md` §8,
`02_analysis/side_channel_and_tamper.md` §6.

**Action:** Add AES-XTS inline encryption in the memory controller.

**Why LOW:** Requires confidential-VM use cases (CoVE), which we do
not have in v0/v1. Adding inline encryption without CoVE is high
cost for low return (cold boot is the only attack it blocks).

### L4. SLH-DSA hybrid root key

**Source:** `02_analysis/pqc_and_crypto_accel.md` §3.3.

**Action:** Root signing ceremony emits an Ed25519 + SLH-DSA-128s
hybrid root. The SLH-DSA part appears only in the root-rotation OTA.

**Why LOW:** Long-term hedging; the SLH-DSA signature size (~7 kB)
costs OTA bandwidth even if amortized. Adopt only when Ed25519 is
under genuine cryptanalytic pressure.

### L5. Active mesh on top metal

**Source:** `02_analysis/side_channel_and_tamper.md` §7.

**Action:** Add an active mesh layer over the security core top
metal; expose a tamper-detect input to `lc_ctrl`.

**Why LOW:** Requires custom back-end-of-line work; expensive in
mask cost and tool flow. Justified only against decap-class T8
threats, which v0 explicitly accepts as out-of-scope.

### L6. CHERI on the application CPU

**Source:** `02_analysis/tee_and_confidential_compute.md` §12.

**Action:** Migrate main AP to CHERI-RISC-V.

**Why LOW:** Userland ABI implications dwarf the chip-side work;
Android does not have a CHERI ABI target today.

## Sequencing against the existing work-order

`docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`
defines a fail-closed work order. The HIGH-confidence recommendations
align with that work order as follows:

| Work-order forbidden claim | Recommendation that unblocks (with caveats) |
|---|---|
| "secure boot" | H1 (RoT IP) + H2 (libavb) + H3 (OTBN Ed25519) + H8 (synthetic OTP for simulator transcripts) |
| "verified boot" | H2 + H4 (dm-verity) |
| "rollback protected" | H2 (libavb rollback) + H1 (`otp_ctrl` rollback partition) |
| "debug locked" | H1 (`lc_ctrl`) + the debug-auth Ed25519 verify already specified in `docs/security/debug-policy.md` §4 |
| "KeyMint backed" | requires M3 (KeyMint TEE work) — explicitly v1, not v0 |
| "StrongBox" | excluded forever in v0; out of scope per `docs/security/threat-model.md` §5 |
| "PQ-safe" | requires M2 (OTBN ML-DSA verify) |
| "SCA-protected" | requires M4 (masked AES + glitch detectors) |
| "Common Criteria / FIPS 140 / GP TEE certified" | explicit non-goal per threat-model §5 |

For each HIGH recommendation, the test-plan transcripts under
`docs/security/test-plan.md` define the evidence schema. Producing
real transcripts is the gating step before the work order's forbidden
claims can be unblocked.

## What this packet does not commit

This is a research and planning packet. Adoption of any open IP
(OpenTitan, libavb, Open DICE, Keystone, Tock, etc.) requires its
own work order, its own LICENSE accounting (Apache-2.0 inheritance),
and its own DV evidence. The chip-team owns:

- Integration RTL.
- DV against the existing `verify/cocotb/test_e1_lifecycle.py` patterns.
- Synthesis and PD evidence on the chosen process node.
- The TC-* transcript files in `docs/security/test-plan.md` schema.

None of those exist today. The repository state at packet date remains
the identity / contract ROM described in `docs/arch/security.md`.

## Cross-references

- `docs/arch/security.md` — current scaffold status.
- `docs/security/threat-model.md` — assets, adversaries, mitigations.
- `docs/security/boot-image-format.md` — image container + key ladder.
- `docs/security/otp-fuse-map.md` — OTP allocation + ECC + write auth.
- `docs/security/avb-a-b-ota.md` — AVB chain + A/B + OTA failure matrix.
- `docs/security/debug-policy.md` — lifecycle-gated JTAG and RMA flow.
- `docs/security/key-ceremony.md` — HSM roles, ceremony script, audit.
- `docs/security/usb-pd-spec.md` — USB-PD sink-only policy.
- `docs/security/test-plan.md` — TC-* evidence schema.
- `docs/security/secure-boot-lifecycle-evidence.md` — BLOCKED rows.
- `docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`
  — fail-closed work order forbidden_claims.
- `02_analysis/root_of_trust_landscape.md`,
  `02_analysis/secure_boot_avb_otp.md`,
  `02_analysis/pqc_and_crypto_accel.md`,
  `02_analysis/tee_and_confidential_compute.md`,
  `02_analysis/side_channel_and_tamper.md` —
  the source analyses behind each recommendation.
- `01_sources/source_inventory.yaml` — provenance.

# Open Secure Subsystem, Root of Trust, Secure Boot, TEE, Side Channel — Research Packet

Date: 2026-05-19

This packet records a source-backed survey of open hardware and software
resources relevant to designing a phone-class secure subsystem for the
Eliza E1 SoC: a discrete or integrated Root of Trust (RoT), a fail-closed
secure boot chain, OTP/eFuse-backed key storage and lifecycle, a TEE
slice for KeyMint and protected services, post-quantum and classical
crypto acceleration, hardware RNG / PUF / DICE-style attestation, and
side-channel/anti-tamper posture. It maps the existing pre-silicon
contract documents (`docs/security/threat-model.md`,
`docs/security/boot-image-format.md`, `docs/security/otp-fuse-map.md`,
`docs/security/avb-a-b-ota.md`, `docs/security/debug-policy.md`,
`docs/security/key-ceremony.md`, `docs/security/usb-pd-spec.md`,
`docs/security/test-plan.md`, `docs/arch/security.md`) onto open IP and
specifications that can fill the gaps that those documents currently
declare BLOCKED.

## Files

- `01_sources/source_inventory.yaml` — provenance, URLs, captured points,
  and claim boundaries. Same schema as
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/root_of_trust_landscape.md` — OpenTitan, Caliptra
  (0.x/1.x/2.x), Microsoft Pluton-class analogs, CHERIoT, Tock OS for
  security cores; fit for E1's currently identity-only boot ROM.
- `02_analysis/secure_boot_avb_otp.md` — AVB 2.0/3.0, U-Boot Verified
  Boot, EDK2 secure boot, OpenSBI signed payloads, dm-verity / fs-verity,
  A/B + rollback, OTP/eFuse macros for Sky130/GF180/advanced nodes, and
  the LOCKED/RMA lifecycle dance.
- `02_analysis/pqc_and_crypto_accel.md` — open AES/ChaCha20-Poly1305,
  SHA-2/3, Curve25519/Ed25519, NIST PQC (FIPS 203/204/205) HW accelerators,
  RISC-V Zk crypto extensions, TRNG and SRAM/RO PUFs.
- `02_analysis/tee_and_confidential_compute.md` — Keystone, Penglai,
  Sanctum, MultiZone, IOPMP, CHERI / CHERIoT, RISC-V CoVE (AP-TEE),
  RISC-V Smaia/Ssaia AIA, Sscofpmf, Hypervisor 1.0, DICE / Open DICE,
  IETF RATS, SPDM, Caliptra DPE.
- `02_analysis/side_channel_and_tamper.md` — Spectre/Meltdown class on
  RV (XiangShan + leakage studies), constant-time/masked crypto, fault
  injection (voltage/EM/laser), RowHammer mitigation, memory encryption
  (TDX, SEV-SNP, ARM CCA, RISC-V CoVE memory protection), active mesh and
  package tamper.
- `03_implementation/security_path_for_e1.md` — High/Med/Low confidence
  steps tying the open RoT and TEE options to the existing pre-silicon
  contract files in `docs/security/` and `docs/arch/security.md`, plus
  the OTP/lifecycle/debug evidence gates already encoded in the
  fail-closed work order.

## Claim Boundary

This packet is research and implementation-planning evidence. Project
README claims, vendor pages, and public specifications are treated as
directional guidance only. The repository state today is the identity /
contract ROM described in `docs/arch/security.md`. No claim of secure
boot, verified boot, debug lock, anti-rollback, KeyMint TEE, attestation,
PQC compliance, FIPS 140 certification, or side-channel resistance may
be made from this packet alone. Movement of any such claim requires the
specific TC-* evidence files listed in `docs/security/test-plan.md` and
the JSON transcript schema referenced there.

## Relationship to existing chip research packets

This packet sits alongside the prior 2026-05-19 packets:

- `research/cpu_subsystem_2026/` — open RISC-V cores, RVV, RVH, AIA.
  Security cross-cuts via PMP/ePMP, IOPMP, Smaia/Ssaia/Sscofpmf, and
  potential Sanctum/Penglai/Keystone deployment on Rocket or BOOM.
- `research/npu_accelerator_2026/` — open NPU options. Security
  cross-cuts via accelerator confidential compute (CoVE-IO equivalents,
  IOPMP-mediated DMA isolation, attested model loading).
- `research/memory_subsystem_2026/` — memory controller / LPDDR options.
  Security cross-cuts via memory encryption, RowHammer mitigation,
  on-die ECC interactions with confidential VM memory.
- `research/compiler_runtime_2026/` — host runtime and compiler stack.
  Security cross-cuts via signed model containers, attested loaders,
  DICE-derived runtime keys.
- `research/pd_eda_2026/` — open PD/EDA. Security cross-cuts via OTP
  macro selection on the chosen process node (Sky130 fuse macros vs.
  intermediate-node antifuse vs. GF22FDX / TSMC N6 OTP).

## Date

`captured_date: "2026-05-19"` matches the rest of the packet set and the
`docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`
work order timestamp.

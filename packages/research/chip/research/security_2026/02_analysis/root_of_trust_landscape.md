# Open Root of Trust Landscape — OpenTitan, Caliptra, CHERIoT, Tock

Date: 2026-05-19

This note surveys open silicon and firmware projects that can fill the
"production secure boot ROM, OTP/eFuse, lifecycle controller, key
manager, and crypto coprocessor" role currently declared BLOCKED in
`docs/arch/security.md` and `docs/security/secure-boot-lifecycle-evidence.md`.
None of these projects is adopted in the repository today; the
identity-only `rtl/bootrom/e1_bootrom.sv` remains the authoritative
boot ROM contract, and no fuse macro, key manager, or lifecycle FSM is
in RTL.

The pre-silicon spec already names the assets (`docs/security/threat-model.md`
§1), required mitigations (§4 M1, M2, M8, M10, M14), the OTP allocation
plan (`docs/security/otp-fuse-map.md`), the key ladder (`docs/security/boot-image-format.md`
§3), and the lifecycle states (`docs/security/boot-image-format.md` §5,
`docs/security/debug-policy.md` §2). The question this note answers is
which open IP best implements those abstractions.

## 1. Design space

A phone-class RoT can sit in one of three roles:

1. **Boot supervisor (in-package, M-mode peer).** Same package, separate
   small hart that holds keys, fuses, debug controller, and the boot
   sequencer. Application CPU(s) only run after the supervisor releases
   them. This is what `docs/security/threat-model.md` M1 (verify next-
   stage signature with key chained to OTP root hash before transfer of
   control) implicitly assumes.
2. **Measurement-only RoT (RoT-M).** Sits in-package or on-die but
   only measures and reports; the application cores still run the
   actual signature checks. Matches Caliptra's role.
3. **Discrete secure element (SE).** External chip on a hardened bus.
   StrongBox-class (`docs/security/threat-model.md` §5: "No StrongBox /
   discrete secure element in v0 (KeyMint TEE-only is the ceiling)").
   Explicitly excluded from v0; included here for completeness only.

For v0, role 1 (boot supervisor) is the implicit target. Role 2 is the
natural next step once measurement and attestation become a product
requirement (Caliptra DPE + IETF RATS verifier).

## 2. OpenTitan (lowRISC)

**Repo**: https://github.com/lowRISC/opentitan — Apache-2.0.

**What it gives us (mapped to docs/security):**

| OpenTitan block | Replaces / implements in our spec |
|---|---|
| `rom_ctrl` (SHA-3-scrambled ROM with integrity check) | `docs/security/boot-image-format.md` §6 ROM halt behavior + `docs/arch/security.md` "no production ROM code today" |
| `lc_ctrl` (Lifecycle Controller, 7-state, token-authorized transitions) | `docs/security/otp-fuse-map.md` §2 lifecycle one-hot FSM + `docs/security/debug-policy.md` §2 per-lifecycle matrix |
| `otp_ctrl` (OTP controller with ECC, scrambling, partitions) | `docs/security/otp-fuse-map.md` §3 ECC/parity, §4 write authorization |
| `keymgr` (Key Manager with versioned key derivations) | `docs/security/boot-image-format.md` §3 key ladder for any post-root derivation (HKDF) |
| `aes` (masked AES-256) | AVB / FDE primitive |
| `kmac` (Keccak-based KMAC / SHA-3) | optional successor to SHA-256 image hash |
| `hmac` (SHA-2) | matches our SHA-256 image hash; HMAC-SHA-256 for KDF |
| `otbn` (Big Number coprocessor) | Ed25519 verify (RFC 8032), ECDSA P-256/P-384, future PQC primitives |
| `csrng` + `entropy_src` (SP 800-90A/B compliant) | TRNG required for KeyMint, KeyMaster attestation, RMA challenge nonces |
| `sram_ctrl` (scrambled SRAM with integrity) | KeyMint key blob staging memory |

**Maturity:** OpenTitan Earl Grey top has had multiple silicon tape-
outs through the lowRISC program; the DV grade per block is publicly
tracked. ROM, lifecycle, OTP, and key manager are at the highest DV
levels.

**Footprint:** Earl Grey is ~750k gates on a 16 nm-class target,
dominated by OTBN and CSRNG. A trimmed boot-supervisor configuration
(ROM_ctrl + lc_ctrl + otp_ctrl + keymgr + AES + HMAC + Ibex; no OTBN,
no KMAC, no peripheral USB/SPI) fits well below 300 kGE.

**Adoption recommendation (deferred to `03_implementation/`):** The
likely production path is to instantiate OpenTitan's `rom_ctrl`,
`lc_ctrl`, `otp_ctrl`, `keymgr`, `aes`, `hmac`, `csrng`, `entropy_src`
as IP, around a CHERIoT-Ibex or stock Ibex security core, in lieu of
designing these blocks fresh. This is the cleanest realization of
`docs/security/threat-model.md` mitigations M1, M2, M8, M10, M14, with
the smallest implementation risk because the blocks already have
extensive DV.

**Risks:** OpenTitan integration assumes the project's bus is TileLink
or that we adapt to AXI; the rest of the e1-chip currently uses
TileLink (Chipyard / Rocket), so this aligns. OpenTitan ROM is SHA-3-
scrambled, which is heavier than our current SHA-2 plan; either we
swap to SHA-3 image hashing (touching `docs/security/boot-image-format.md`
§1) or retain SHA-2 at the next stage while keeping SHA-3 for ROM
integrity only.

## 3. Caliptra (OCP)

**Repo**: https://github.com/chipsalliance/Caliptra — Apache-2.0.

**Caliptra at a glance.** Caliptra is the Open Compute Project's
reference Root of Trust for Measurement (RoT-M) for data-center
silicon. Caliptra 1.x has been ratified by OCP; Caliptra 2.x extends
the core spec with PQC support (ML-DSA-87 attestation), SHA-3, AES-GCM,
ECC P-384, and a richer DPE.

**Core:** RISC-V Veer-EL2 (a small in-order RV32 core from Western
Digital's open IP set), running Caliptra firmware that signs
firmware-image measurements and exports an attestation report.

**What it gives us:**

| Caliptra block | Maps to docs/security |
|---|---|
| DPE (DICE Protection Environment) | Attestation chain originating in `docs/security/key-ceremony.md` §5 board identity provisioning, with CDI rotation in flight |
| Mailbox + SPDM | Attested transport between Caliptra and host firmware; informs how a measurement RoT speaks to BL2 |
| Recovery protocol | SPDM-based firmware recovery; complements `docs/security/avb-a-b-ota.md` §6 recovery partition policy |

**Role vs OpenTitan:** Caliptra is fundamentally a *measurement* RoT.
It signs measurements; it does not by itself implement the chained
verification of BL1 -> BL2 -> vbmeta described in our boot-image-format.
For E1, OpenTitan's role-1 (boot supervisor) model is a closer fit;
Caliptra is the better fit if E1 ever needs an OCP-style attestation
compliance story (data-center adjacency, server class) — which is not
v0 scope.

**Possible blend.** A Caliptra-style DPE *firmware module* running on
an OpenTitan-derived security core would give us the best of both:
OpenTitan IP for the boot supervisor + Open DICE for measurement
exports. Caliptra-DPE source is reusable as a firmware library
(`caliptra-dpe`).

## 4. Microsoft Pluton and open analogs

Pluton ships in commercial CPUs (AMD Ryzen mobile, some Intel SKUs,
Qualcomm SoCs). Its RTL is closed; its behavior is documented
(TPM-like services, FIDO2, Microsoft-signed FW updates with HVCI
attestation).

For E1, the open analog is: OpenTitan as the boot supervisor + Caliptra-
style DPE for measurement + Tock OS or seL4 as the firmware OS on the
security core. This stack provides the same product surface (signed
firmware update, attested boot, hardware-backed key store) without a
closed RTL dependency.

## 5. CHERIoT (Microsoft / lowRISC)

**Repo**: https://github.com/microsoft/cheriot-ibex.

**CHERIoT-Ibex** adds CHERI capabilities (fat pointers carrying bounds
and permissions, with hardware tag bits) to the Ibex 32-bit RV core.
The Sonata board (lowRISC) is a public CHERIoT FPGA platform.

**Why it matters for E1.** A boot supervisor and a KeyMint TA both live
in C / Rust at a small TCB. CHERI capabilities turn out-of-bounds and
type-confusion bugs into deterministic exceptions at hardware speed.
The security MCU is the smallest TCB on the chip; running CHERIoT-Ibex
there yields the best return on a small area increment.

**Status note.** CHERIoT-Ibex is research-grade; not all OpenTitan IP
adapts to a CHERI core without source modifications (the load/store
unit changes, register width changes for capabilities). For a v0 chip
that already declares production secure boot BLOCKED, CHERIoT is a
strong direction for a v1 security core. For v0, stock Ibex inside an
OpenTitan Earl Grey configuration is the lower-risk choice.

## 6. Tock OS

**Repo**: https://github.com/tock/tock — Rust-first OS for memory-
constrained MCUs.

**Why it matters.** OpenTitan Earl Grey runs Tock as the application OS
on top of Ibex. Tock provides:

- PMP-mediated process isolation between firmware tasks.
- Rust kernel + Rust drivers (capsules) for low TCB count.
- Userspace processes can be signed and updated independently.

This is the right OS for the security core if we adopt OpenTitan. The
alternative — MultiZone (commercial) or Zephyr (LTS support, mature
ecosystem, but C-based) — gives less safety for more compatibility.

For an even more conservative choice, seL4 has a verified RV port and
could host KeyMint and a small attestation service. seL4 changes the
firmware engineering model significantly (capability-based design,
manual policy authoring) and is a v1 candidate, not v0.

## 7. ROM scrambling and integrity

Two specific architectural choices come up here that intersect with
`docs/security/boot-image-format.md`:

- **ROM scrambling vs cleartext mask ROM.** OpenTitan scrambles ROM
  content with SHA-3-derived per-word keystream; the ROM_ctrl block
  computes a cumulative digest as it descrambles and refuses to release
  control unless the digest matches an OTP-stored expected digest. This
  defeats simple decap-and-photograph reads of mask-ROM content. Our
  spec mentions "boot ROM published with cryptographic hash" (M14) but
  not scrambling. Adopting OpenTitan ROM_ctrl is the easy way to get
  both properties.
- **Mask-ROM size budget.** Our boot-image-format key ladder needs
  Ed25519 verify + SHA-256 hash + AVB header parser + signature blob
  parser + structured halt-record formatter. Total ~6-8 kB compiled
  for Ibex. Within OpenTitan ROM size budget (16-32 kB).

## 8. Lifecycle FSM realization

Our `docs/security/otp-fuse-map.md` §2 defines a 6-state lifecycle
encoded as a one-hot fuse field with explicit allowed transitions
(`BLANK -> DEV`, `BLANK -> MFG`, `MFG -> LOCKED`, `LOCKED -> RMA`,
`* -> SCRAP`). OpenTitan's `lc_ctrl` implements a richer 7+ state FSM
with token-gated transitions, but the structural pattern (OR-only
fuses + monotonic transitions + tamper counter increment on illegal
attempts) is identical. Adopting `lc_ctrl` directly satisfies M10
(OTP write logic disables programming of lifecycle, root, and rollback
fuses after lifecycle transition to LOCKED) with formally-verified
state encodings.

If we keep our 6-state model, we should at minimum borrow OpenTitan's
formal proof harness for lifecycle state encoding (publicly available
in the repository), per `02_analysis/side_channel_and_tamper.md`'s
discussion of fault-injection-resilient state machines.

## 9. Open questions

- **Which target node for v0?** Sky130 lacks vendor OTP IP, so a Sky130
  prototype using OpenLane will have to supply OTP externally (mask
  ROM + simulated fuse RAM for bring-up); a real fuse macro requires a
  paid third-party IP or an intermediate node (TSMC N6 / GF22FDX).
  This is the largest single risk against any "shipped LOCKED device"
  claim.
- **Discrete SE vs. integrated.** `docs/security/threat-model.md` §5
  states v0 ceiling is KeyMint TEE-only. If E1 ever moves to StrongBox-
  class, an external SE is the natural answer; OpenTitan can also run
  as an external SE chip on a hardened bus, which keeps the IP choice
  consistent across packaging strategies.
- **Caliptra DPE on a security core that is not Veer.** Caliptra
  firmware is portable C; running `caliptra-dpe` on Ibex or CHERIoT-
  Ibex is feasible but unverified upstream. Either we maintain a port,
  or we use Open DICE (smaller, simpler) and forgo OCP compliance.

## 10. Cross-references

- `docs/arch/security.md` — current identity-only ROM status.
- `docs/security/secure-boot-lifecycle-evidence.md` — list of artifacts
  blocking any "secure boot prototype" claim. Adopting OpenTitan blocks
  closes many entries.
- `docs/security/boot-image-format.md` §3, §5, §6 — key ladder, lifecycle
  states, ROM halt behavior; constrains which RoT IP we can adopt.
- `docs/security/otp-fuse-map.md` §1, §2, §3, §4 — OTP layout, ECC,
  write-authorization; OpenTitan `otp_ctrl` is the reference implementation.
- `docs/security/threat-model.md` mitigations M1, M2, M8, M10, M14.
- `02_analysis/secure_boot_avb_otp.md` for the AVB chain on top of this RoT.
- `02_analysis/tee_and_confidential_compute.md` for what the RoT exposes
  to the application CPU and KeyMint TA.
- `03_implementation/security_path_for_e1.md` for ranked recommendations.

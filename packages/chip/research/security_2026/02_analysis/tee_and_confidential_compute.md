# TEE Designs, IOPMP, RISC-V Hypervisor, CoVE, DICE Attestation

Date: 2026-05-19

This note covers everything that runs on the application CPU after
secure boot releases control: the TEE (Trusted Execution Environment)
slice that hosts KeyMint and per-app key blobs; the memory protection
primitives that isolate the TEE from the normal OS and from peripheral
DMA; the hypervisor / confidential VM extensions; and the
DICE / RATS / SPDM attestation surfaces. The starting contract is
`docs/security/threat-model.md` §1 assets A10 (user data, KeyMint key
blobs) and A11 (per-device identity, attestation key), and the v0 §5
non-goal that StrongBox is out of scope and KeyMint TEE-only is the
ceiling.

## 1. The TEE problem on RISC-V

ARM SoCs get TrustZone for free (S-EL0 / S-EL1 / S-EL2 / S-EL3
hardware). RISC-V has no built-in TrustZone equivalent; production
TEEs on RV are built from a combination of:

- M-mode security monitor (the smallest TCB).
- PMP / ePMP (Physical Memory Protection / enhanced PMP) for physical-
  address isolation.
- IOPMP at the interconnect for DMA isolation.
- H-extension (RISC-V Hypervisor 1.0) for two-stage translation.
- AIA (Smaia/Ssaia) for secure interrupt routing.
- Optionally: CHERI capabilities, SecureCells, or sPMP/MPT for
  scaling beyond PMP-slot count.
- Optionally: CoVE (Confidential VM Extension) for full confidential-VM
  guarantees.

Open frameworks that compose these pieces:

- **Keystone** (Berkeley/MIT) — minimal PMP-based enclaves, OpenSBI-
  integrated security monitor (SM), Eyrie runtime, remote attestation.
- **Penglai** (SJTU) — adds sPMP/MPT for scaling enclave count;
  Penglai-VM for confidential VMs on RV.
- **Sanctum** — academic; adds cache-partitioning and PMP changes
  to defeat cache side channels.
- **MultiZone** (Hex Five) — commercial Apache-2 runtime, smaller TCB.
- **OP-TEE RV port** — experimental; would give KeyMint TA portability
  from existing ARM platforms.

## 2. PMP / ePMP foundations

Standard PMP gives an M-mode-controlled list of 16 (or 64) physical-
address regions with RWX permissions. ePMP adds the M-mode-only "L"
bit and the "Smepmp" extension (Machine Mode Static Permission), which
turns PMP into a real isolation primitive (without ePMP, PMP rules
default to "M-mode has full access regardless," which defeats the
TEE story for code that goes wrong in M-mode).

**E1 commitment:** Whichever main CPU we pick (Rocket per
`research/cpu_subsystem_2026`), the build must include Smepmp /
ePMP. PMP-region count: 16 minimum (Keystone single-enclave) or 32 if
we want multiple concurrent enclaves without falling back to MPT.

## 3. IOPMP at the interconnect

`docs/security/threat-model.md` surface S2 (SPI/eMMC boot read path)
and S6 (recovery sideload) both involve DMA from peripherals. Without
IOPMP, a malicious USB/eMMC device could DMA over the security
core's memory once the application CPU is up.

RISC-V IOPMP (ratified for the non-ISA track) provides this. Each
DMA master gets an IOPMP source ID; IOPMP entries map source ID +
physical address region to permissions. This is the SoC-interconnect
analog of PMP.

**E1 commitment:** Every DMA-mastering block (USB controller, eMMC/
UFS controller, NPU DMA, ISP DMA, modem if present) must sit behind
an IOPMP entry. Default policy: deny-by-default; explicit grants only.
This realizes M5 (two-stage OTA: download to staging) at the hardware
level (the OTA client process gets DMA access only to its staging
buffer, not to the inactive boot slot).

## 4. Keystone vs Penglai vs Sanctum

| Property | Keystone | Penglai | Sanctum |
|---|---|---|---|
| Year | 2017+ | 2020+ | 2016 |
| Isolation | PMP | sPMP + MPT (memory protection tree) | PMP + cache partitioning |
| Enclave count ceiling | PMP slot count (16) | Hundreds | PMP slot count |
| Cache SC mitigation | No | No (Penglai-VM adds some) | Yes (page-coloring + PMP) |
| Attestation | SM-signed report (Ed25519) | SM-signed; SPDM-compatible | SM-signed |
| Linux integration | Eyrie runtime + linux-keystone driver | Penglai SDK | Academic |
| Maturity | Multi-year deployment in research, FPGA, real RV chips | Active; Linux upstream patches | Mostly research |

**Recommendation for E1:** Start with Keystone. It is the most mature
open RV TEE, has a clean OpenSBI-integrated security monitor, and the
Eyrie runtime is small enough to audit. Move to Penglai (or Penglai-VM)
in a future generation if either:

(a) we need >16 concurrent isolation domains (KeyMint, sensor TA,
biometric TA, DRM TA, ... is plausibly ~6-8 in steady state — Keystone
suffices);

(b) we adopt RISC-V CoVE for full confidential VMs.

Sanctum's cache-partitioning ideas should be folded into the v1 plan,
but Sanctum's modifications to PMP are not directly compatible with
upstream RV ePMP — its lessons would inform a microarch choice on the
AP rather than a runtime choice.

## 5. RISC-V CoVE (AP-TEE)

The RISC-V Confidential VM Extension (CoVE) defines a TEE-Security-
Manager (TSM) running in M-mode (or HS-mode equivalent), TVMs
(Trusted VMs) running confidential workloads, attestation, and memory
confidentiality. CoVE is a peer to Intel TDX, AMD SEV-SNP, and ARM CCA.

For E1, CoVE is a v1+ ambition:

- CoVE assumes RISC-V H-extension (hypervisor) + MPT (memory
  protection tree, akin to AMD RMP). Rocket has H-extension via
  configuration; MPT/RMP equivalent is not in Rocket today.
- CoVE-IO defines the corresponding device-side story (TEE Device
  Interface, attested confidential DMA via SPDM). For an NPU/ISP that
  handles user data, this matters; for v0 it is out of scope.

The reason CoVE is on this packet's map at all is that any RoT
architecture we commit to (OpenTitan + DICE) is forward-compatible
with CoVE attestation: the same DICE-derived attestation root key
signs CoVE Realm/TVM attestation reports.

## 6. CHERI and CHERIoT in the TEE story

CHERI capabilities are an orthogonal isolation primitive: every
pointer carries hardware-checked bounds, permissions, and a 1-bit
tag. CHERI-RISC-V (Cambridge / SRI) and CHERIoT (Microsoft) implement
this on RV.

For a phone-class SoC, CHERI's place is:

- The security MCU and the KeyMint TA: small TCB, high-value, exactly
  the workloads where CHERI's memory-safety wins justify the area
  and ecosystem cost.
- Not the main application CPU (yet): CHERI requires a recompile of
  the entire userland; the Android ABI implications are large.

E1 v1 candidate: CHERIoT-Ibex as the security MCU; stock RV main AP
without CHERI. v0: stock Ibex on the security MCU.

## 7. Interrupts and timing: Smaia/Ssaia, Sscofpmf

Two extensions tighten the TEE story:

- **Smaia / Ssaia** (RISC-V AIA) define APLIC + IMSIC interrupt
  controllers with per-hart, per-mode counters. Without AIA, an
  attacker-controlled IRQ flood can leak TEE timing.
- **Sscofpmf** standardizes performance-counter overflow as a
  delegated interrupt; the security monitor can mask it for the TEE.

Both are mature and supported in upstream Linux. The Rocket build for
E1 should enable them (cross-ref `research/cpu_subsystem_2026/02_analysis/coherency_and_interconnect.md`
for the bus-side implications).

## 8. Memory encryption

For v0, no on-chip memory encryption (in-line LPDDR encryption). For
v1, the options are:

- **Inline LPDDR memory encryption** (AES-XTS over the DDR bus). The
  memory controller becomes the encryption point. Intel TDX, AMD SEV-
  SNP, and ARM CCA all do this in their respective server cores; RISC-V
  CoVE assumes it.
- **Per-page encryption gated by IOPMP/PMP** — software model, more
  flexible, less robust against bus-probing attacks (which `threat-
  model.md` T4 acknowledges).

Recommendation: leave inline memory encryption as a v1 ambition.
Adopting it requires the memory controller team to expose an AES-XTS
core with per-key support; that intersects with `research/memory_subsystem_2026/`.

## 9. DICE / Open DICE / DPE attestation chain

Even without CoVE, a working attestation chain is achievable in v0:

```
OTP.UDS  (Unique Device Secret, 256 bits; partitioned from PUF response
          via helper-data extraction)
   |
   v
ROM stage CDI = HKDF(UDS, ROM_measurement || "L0")
   |
   v
BL1 stage CDI = HKDF(L0 CDI, BL1_measurement || "L1")
   |
   v
BL2 stage CDI = HKDF(L1 CDI, BL2_measurement || "L2")
   |
   v
TEE stage  CDI = HKDF(L2 CDI, TEE_measurement || "L3")
                  |
                  +-- derives AttestationSigningKey (Ed25519) per stage
                  +-- exports certificate chain via X.509 or CBOR/COSE
```

This is the TCG DICE pattern. Google's Open DICE provides a small
reference C library. Each stage's CDI is dead by the time the next
stage runs (the keymgr clears it after derivation), so a compromise
at runtime cannot recover earlier stages' secrets.

**Cross-reference to docs/security:**

- The DICE chain's UDS comes from the PUF derivation that
  `docs/security/otp-fuse-map.md` §1 sketches with `device_uid_parity`.
- Per-stage measurements (`ROM_measurement`, `BL1_measurement`, ...)
  are the SHA-256 digests already computed by the boot path per
  `docs/security/boot-image-format.md` §2.1 `payload_sha256`.
- KeyMint attestation root chains into the final TEE-stage CDI's
  signing key.

## 10. SPDM, RATS, and the verifier side

**IETF RATS (RFC 9334)** defines roles: Attester (E1 phone), Verifier
(Eliza Cloud back-end or third-party), Relying Party (the app that
trusts the attestation). The Attester emits Evidence (CBOR Web Token or
COSE_Sign1 typically); the Verifier returns an Attestation Result.

**DMTF SPDM** defines device-to-device attested communication. It is
overkill for v0 (E1 talks to its own peripherals over IOPMP-gated
buses), but if we ever bring a confidential modem or confidential
external NPU into the picture, SPDM is the lingua franca. Caliptra's
SPDM Recovery is a worked example.

**TPM 2.0** behavioral target: PCR-based measured boot, key sealing,
attestation quotes. We do not need to ship a TPM in v0; KeyMint's
attestation surface already covers the equivalent for Android
applications.

## 11. KeyMint TEE-only as the v0 ceiling

`docs/security/threat-model.md` §5 makes "KeyMint TEE-only is the
ceiling" explicit. Concretely this means:

- KeyMint TA runs in the TEE (Keystone enclave or OP-TEE TA).
- KeyMint key blobs are wrapped by a TEE-derived key (HBK from
  `keymgr`).
- Attestation root key is per-device, derived from PUF UDS through
  DICE, signed by the Android attestation root at provisioning time
  (the certificate goes into device storage; the private key never
  leaves the TEE).
- StrongBox class is *not* claimed.

For Play Integrity API, this is acceptable for most use cases.
StrongBox is required only for the highest-tier app classes (some
banking apps).

## 12. CHERI and SecureCells as "next-gen" PMP

If E1 ever hits the wall of 16 PMP slots while needing dozens of
isolation domains, options are:

- **MPT (memory protection tree)** — Penglai's approach; logarithmic
  permission lookup; adopted by CoVE as the underlying mechanism.
- **SecureCells** (EPFL) — cell-based memory protection with scalable
  permissions; RV prototype.
- **CHERI capabilities** — per-pointer; orthogonal to PMP/MPT.

These all live in v1+. For v0, ePMP with 16 slots is sufficient.

## 13. Where TEE meets the boot chain

The boot chain in `02_analysis/secure_boot_avb_otp.md` §9 ends at "init
/ KeyMint TA". The actual wiring:

1. BL2 passes verified-boot state to the kernel cmdline (`androidboot.verifiedbootstate=green`).
2. BL2 also passes the TEE image (signed under the same key ladder)
   to the security monitor at a fixed PMP-protected memory region.
3. M-mode SM (OpenSBI + Keystone monitor extensions) verifies the TEE
   image and launches it into S-mode (or into an enclave context).
4. KeyMint TA inside the TEE registers with init via the keystore HAL.

This realizes the chain from `docs/security/boot-image-format.md` §3
through to the runtime KeyMint surface.

## 14. Open questions / forward work

- **Penglai vs Keystone selection.** Mostly decided by enclave-count
  pressure. If KeyMint + biometric TA + sensor TA + IPC-bridge TA fit
  into 4-6 enclaves, Keystone wins on TCB size. If we add per-app
  enclaves (which CoVE-style apps would need), Penglai wins.
- **OP-TEE RV port adoption.** Adopting OP-TEE gives us a ready KeyMint
  TA implementation but a much larger TCB. Worth re-evaluating once the
  RV port is upstream and certified.
- **CHERIoT for security MCU.** v1 candidate; no v0 commitment.

## 15. Cross-references

- `docs/security/threat-model.md` assets A10, A11; mitigation M7
  (KeyMint key erase on unlock).
- `docs/security/debug-policy.md` §5 RMA wipes KeyMint keys.
- `docs/security/key-ceremony.md` §5 per-device attestation key.
- `02_analysis/root_of_trust_landscape.md` for the keymgr / RoT that
  seeds the DICE chain.
- `02_analysis/secure_boot_avb_otp.md` §9 ends at the TEE handoff.
- `02_analysis/side_channel_and_tamper.md` for the cache/timing
  channels that PMP/CoVE alone do not cover.
- `03_implementation/security_path_for_e1.md` for the ranked
  recommendations.

# Side Channels, Fault Injection, RowHammer, and Anti-Tamper Posture

Date: 2026-05-19

This note inventories the side-channel and fault-injection surfaces
that any phone-class chip must reason about, and maps them against the
v0 non-goals declared in `docs/security/threat-model.md` (T8 decap /
FIB, T9 DPA/EM, T10 supply-chain trojan) and the implicit non-goals
inside `docs/security/usb-pd-spec.md` (no DPA on PD policy) and
`docs/security/boot-image-format.md` (ROM halts on signature failure,
but no glitch detection in v0). The note is forward-looking: the
recommendations described here are mostly v1 work.

## 1. Side-channel attack surfaces

| Class | Attack | Cost | Defense locus |
|---|---|---|---|
| Cache timing (L1/L2/LLC) | Prime+Probe, Flush+Reload | software | constant-time crypto; cache partitioning; PMP-aware cache flush |
| Branch predictor | Spectre v1/v2/v4 | software | BPU isolation, fence.t, sw mitigations (retpoline) |
| Speculation memory | Meltdown, Foreshadow, LVI | software | TLB permission checks, KPTI/KAISER, in-order verify path |
| Power analysis | DPA, CPA | $100 (ChipWhisperer) | masked crypto, randomized scheduling, balanced logic |
| EM emanation | EM-DPA, EM-CPA | $1k (near-field probe) | shielding, masking, asynchronous logic |
| Voltage glitching | Vcc dropout / spike at signature compare | $100 (ChipWhisperer) | redundant compare, glitch detector, watchdog |
| Clock glitching | Off-frequency edge | $100 | PLL lock detector, glitch detector |
| Laser fault | Focused photon flips registers | $10k-$1M | active mesh, anti-laser detectors |
| EM fault | Pulsed EM injection | $1k | shielding, redundant compare |
| RowHammer | Pattern-driven DRAM bit flips | software | TRR/RFM in DRAM controller; secure refresh |
| Cold boot | Freeze + read DRAM | $100 | memory encryption; key zeroization on reset |
| Optical (ROM photograph) | Decap + microscope | $1k | ROM scrambling (OpenTitan-style) |

## 2. What `docs/security/threat-model.md` already says

- T8 (decap/FIB/e-beam): **out of scope for v0** — explicit non-goal.
  Mitigated only by foundry contract + ROM hash publication.
- T9 (DPA/EM): **out of scope for v0** — explicit non-goal.
- T10 (supply-chain trojan): out of scope, mitigated by foundry
  contract + ROM hash publication.

For v0, the document is honest about not defending these surfaces.
This note explains what defending them in v1+ entails.

## 3. SCA on signature verification

The most directly exploitable SCA vector on a phone is leakage during
boot-time signature verification (M1 in threat-model). If an attacker
can extract the signing private key from chip leakage, they can sign
arbitrary firmware. The defenses are:

### 3.1 Constant-time discipline

Ed25519 reference implementations are constant-time by construction
(the addition formula on Curve25519 has no branches dependent on
secret data). OpenTitan's OTBN Ed25519 program is constant-time and
verified.

For SHA-256, all standard implementations are constant-time.

For AES, only masked implementations are SCA-resistant; OpenTitan's
masked AES core takes this on.

### 3.2 Masking AES against DPA

First-order masking splits intermediate values into two shares,
making single-trace power analysis useless. Higher-order DPA can
still defeat first-order masking with more traces; OpenTitan's
production deployment uses first-order masking with continuous mask
refresh from the CSRNG/EDN entropy network.

**Cost:** ~50% area increase over an unmasked AES core (OpenTitan
publishes this in the AES IP spec).

**E1 commitment (v1):** Adopt OpenTitan `aes` masked core on the
security core. Cross-ref `02_analysis/pqc_and_crypto_accel.md` §2.2.

### 3.3 Randomized signing

For sign operations, deterministic Ed25519 (RFC 8032) is intentionally
deterministic — the nonce is computed from `SHA512(secret || message)`.
This makes deterministic Ed25519 vulnerable to *fault* attacks (if you
can fault one bit during one execution and observe the signature, you
can solve for the private key). The mitigation is randomized Ed25519
(RFC 8032 §5.1.6 variant) or hedged signing (add fresh randomness
into the nonce).

**E1 commitment (v1):** Sign operations (HSM-side; not on chip) should
use hedged Ed25519. On-chip Ed25519 is verify-only, which is not
fault-attack-leakable in the same way.

### 3.4 Verify-side fault attacks

A glitch during `if (signature_valid) jump bl1` can flip the branch,
bypassing the check. Defenses:

- **Redundant compare:** verify the signature twice with different
  code paths; require both to return success.
- **Glitch detector:** dedicated analog block that pulls the chip into
  reset if Vcc / clock falls outside spec; OpenTitan ships these as
  part of the analog wrapper.
- **State machine encoding:** boot-success state encoded as a one-hot
  mubi value (e.g., `0xA5_5A_A5_5A`), not a single bit, so a single
  fault cannot transition state.

**E1 commitment (v1):** All boot-decision state machines in RTL
encoded as mubi values per OpenTitan convention. Glitch detector IP
added to the analog subsystem.

## 4. Spectre / Meltdown class on RISC-V

XiangShan is the most advanced open RV out-of-order core. Public
discussion of Spectre-class concerns notes that:

- Speculative load + cache observable forms the basis of all variants.
- Mitigations split into hardware (BPU partitioning, fence.t,
  speculation barriers) and software (LFENCE-equivalent, retpoline-
  equivalent).

Rocket is in-order, so it has a narrower speculative window than
BOOM/XiangShan, but it still has a non-trivial pipeline that
speculation can ride.

**For E1 v0:** Rocket in-order. Spectre-class risk is narrow but
non-zero. We should:

- Disable BPU sharing across PMP regions (PMP-aware BPU flushes; this
  is a Rocket configuration knob).
- Document explicitly that v0 does not claim Spectre-resistance for
  the TEE.
- For KeyMint TA, ensure constant-time crypto and avoid secret-
  dependent control flow inside the TEE.

**For v1:** if we move to BOOM or XiangShan for performance,
re-evaluate; speculative SCA mitigations become a significant area
and frequency cost.

## 5. RowHammer and DRAM

`docs/security/threat-model.md` §3 surface S2 covers SPI/eMMC, not
DRAM, but DRAM is implicit in the OTA staging area (M5) and KeyMint
key blob handling (A10). LPDDR5 with target row refresh (TRR) and
refresh management (RFM) is the standard mitigation.

**E1 commitment:** The LPDDR controller selection (cross-ref
`research/memory_subsystem_2026/`) must enable TRR and RFM. ECC on
DRAM is highly recommended but adds a small power cost; mobile parts
typically use on-die ECC inside the DRAM die itself, which is
sufficient.

## 6. Memory encryption (forward reference)

Per `02_analysis/tee_and_confidential_compute.md` §8, v0 has no
on-chip memory encryption. The v1 path is an inline AES-XTS encryption
block in the LPDDR controller, with per-realm keys for CoVE-style
confidential VMs.

The relevant references (`01_sources/source_inventory.yaml`) include
Intel TDX, AMD SEV-SNP, ARM CCA, and RISC-V CoVE.

## 7. Active mesh and package tamper

Active mesh is a fine-pitch metal mesh in the top routing layers,
driven by random signals; if the mesh is cut or probed, the chip
detects the impedance change and zeroizes secrets. This is the
canonical defense against decapsulation + FIB / e-beam attacks (T8
in threat model).

**E1 v0:** no active mesh. The chip uses standard back-end-of-line
metal stack and a standard plastic package.

**v1+:** add an active mesh on the security core's top metal; expose
a tamper-detect input to the lifecycle controller; programmatic
response is to OR-set lifecycle SCRAP bit and clear keymgr internal
state.

## 8. Fault injection on USB-PD and external buses

USB-PD itself is a relatively low-bandwidth control plane (4-Mbps BMC
over CC), so PD-side fault injection is not a primary concern. The
larger USB attack surface is the data path (S8 in threat model), which
the IOPMP isolation per `02_analysis/tee_and_confidential_compute.md`
§3 handles.

`docs/security/usb-pd-spec.md` §5 already mandates VBUS OVP at 6 V (5 V
mode) / 14 V (PD), OCP at 3.5 A, and eFuse with auto-retry inhibit. The
"BadPower" class of attacks (malicious PD source firmware forcing
unsafe voltages on naive sinks) is structurally defeated by hardware
OVP, regardless of PD policy bugs.

## 9. Glitch detectors and analog monitors

The minimum analog tamper / fault posture for any v1 secure chip:

- Vcc OVP/UVP monitor (digital output to lifecycle controller).
- Clock glitch detector (PLL unlock detector + ring-oscillator-based
  frequency monitor).
- Temperature monitor (chip refuses to boot above/below operating range
  to defeat thermal-induced fault injection).
- Light sensor on top metal (defeats some decap attacks).

OpenTitan's analog wrapper specifies these; we should import them
along with the digital IP.

## 10. Side-channel resistance for OTP reads

A specific subtle issue: `docs/security/otp-fuse-map.md` §3 says "each
security-critical field carries 1-of-N replication: write the field
three times in separate physical rows; reader uses 2-of-3 majority
vote." This protects against transient read errors but not against an
attacker who can probe two of the three rows during read.

OpenTitan `otp_ctrl` adds *scrambling*: each OTP word is scrambled
with a per-partition key, so even probing all three rows yields
ciphertext, not plaintext. The scrambling key itself is derived from
the lifecycle state, so OTP content cannot be migrated across
lifecycles.

**E1 commitment (v1):** Adopt OpenTitan otp_ctrl scrambling, not just
the 2-of-3 majority. This requires the OTP macro to support the
otp_ctrl programming protocol; vendor OTP macros generally do, but
this is a vendor-IP question for the production node.

## 11. Cold-boot mitigation

A frozen-DRAM cold-boot attack can recover plaintext keys from DRAM
that was zeroized "too late" before reset. Two defenses:

- Inline LPDDR encryption (v1; see §6).
- Zeroize the keymgr internal state on every reset; require the TEE
  to re-derive working keys from CDI on every boot.

`docs/security/debug-policy.md` §5 already requires hardware-driven
erasure on RMA entry; we should also require zeroize-on-reset for
the keymgr (this is the OpenTitan default).

## 12. Summary of v0 vs v1 vs v2 posture

| Posture | v0 (current spec) | v1 (next-gen E1) | v2 (long-term) |
|---|---|---|---|
| AES side channel | Unprotected; KeyMint TEE-only | OpenTitan masked AES on security core | Higher-order masking |
| Ed25519 verify | Constant-time OTBN | Constant-time OTBN | Hybrid with ML-DSA |
| Spectre / Meltdown | Rocket in-order; narrow window | Re-evaluate if BOOM/XiangShan adopted | BPU isolation + fence.t |
| Voltage / clock glitch | No detector | OpenTitan analog wrapper | + Temperature, light |
| Active mesh | None | Security-core top metal | Whole-chip option |
| RowHammer | Software-only; LPDDR vendor TRR/RFM | Same; ECC on DRAM | Same |
| Memory encryption | None | Optional inline LPDDR AES-XTS | Mandatory inline AES-XTS for CoVE |
| OTP scrambling | 2-of-3 majority only | OpenTitan otp_ctrl scrambling | Same |
| ROM scrambling | None (open mask ROM) | OpenTitan rom_ctrl SHA-3 descrambling | Same |
| BPU partitioning | PMP-aware flush | PMP/PCID-aware partitioning | Per-realm BPU |
| Cold boot | Software zeroize | Inline encryption + keymgr reset | Same |
| Fault redundancy | Single compare | Redundant compare + mubi state | Same + formal proof |
| Cache SC | None | Page coloring (Sanctum-style) | LLC partitioning |
| TRNG health | OpenTitan entropy_src | Same | Same |

## 13. What must change in the docs/security contracts for v1

The current contract documents are honest about v0's non-goals. For v1
they need to acquire:

- A new section in `docs/security/threat-model.md` that moves T9 (DPA/
  EM) and parts of T8 (light decap, not FIB) into scope.
- An analog-monitor block in `docs/security/boot-image-format.md` §6
  (new halt code `GLITCH_DETECTED`).
- An OTP scrambling note in `docs/security/otp-fuse-map.md` §3.
- A masking note in any reference to AES.
- A cache-SC discussion in `docs/security/debug-policy.md` if a TEE
  surface is exposed.

These belong in v1 work-orders, not in this packet.

## 14. Cross-references

- `docs/security/threat-model.md` T1-T10, M14.
- `docs/security/boot-image-format.md` §6 ROM halt behavior.
- `docs/security/otp-fuse-map.md` §3 ECC/parity.
- `docs/security/debug-policy.md` §5, §7.
- `docs/security/usb-pd-spec.md` §5 VBUS OVP/OCP.
- `02_analysis/root_of_trust_landscape.md` for OpenTitan analog wrapper.
- `02_analysis/pqc_and_crypto_accel.md` §2.2 AES masking, §2.4 Ed25519.
- `02_analysis/tee_and_confidential_compute.md` §4 cache partitioning
  (Sanctum) and §8 memory encryption.
- `research/memory_subsystem_2026/` for LPDDR TRR/RFM selection (the
  RowHammer mitigation path).

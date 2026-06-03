# 07 — Consolidated Hardware Implementation Plan (TEE-Native E1)

Date: 2026-05-21
Status: pre-silicon consolidated implementation spec. This document **supersedes
the scattered lane detail** in `01`–`05` with a single sequenced, actionable
hardware plan. It does not weaken the fail-closed discipline: every product-grade
claim is tied to a named gate/transcript or marked **BLOCKED** on FPGA / silicon /
LPDDR PHY / side-channel lab. BLOCKED means "awaiting a dependency", not "bug".
That gating is by design (`AGENTS.md`, `packages/chip/CLAUDE.md`).

Read the lanes for full rationale; this is the build order and the contract.
Cross-refs: [`00-overview.md`](00-overview.md), [`01`](01-tee-core-architecture.md),
[`02`](02-root-of-trust.md), [`03`](03-secure-io-iommu-npu.md),
[`04`](04-side-channel-physical-hardening.md), [`05`](05-cpu-memory-performance.md),
[`06`](06-os-on-tee-software.md), [`confidential-domain.md`](../confidential-domain.md).

---

## 0. Audited RTL reality (re-verified 2026-05-21)

The lanes' "honest starting point" still holds; re-verified against the tree:

| Surface | Claim in `00-overview` §1 | Verified | Evidence |
|---|---|---|---|
| CPU memory isolation | PMP/ePMP/Smmtt/H-ext all **disabled/absent** | **TRUE** | `grep -rin pmp rtl/` returns exactly one hit: a PMA comment at `rtl/top/e1_soc_integrated.sv:796`. CVA6 is `cv64a6_imafdc_sv39`, optional PMP not built. No `smmtt`/`hgatp`/`mtt`. |
| IOMMU | identity passthrough in BARE, 6-entry allowlist fallback, partial Sv39 first-stage KAT under identity G-stage; no full two-stage PTW | **TRUE** | `rtl/iommu/e1_riscv_iommu.sv` keeps BARE identity forwarding, adds a minimal DDT + Sv39 first-stage read walk for local KAT coverage, and still leaves non-identity G-stage/PDT/full Linux evidence blocked. |
| Root of trust | XOR debug-auth, accept-all secure boot, unconditional ROM jump | **TRUE** | `e1_lifecycle.sv:68` `DEVICE_KEY_PLACEHOLDER = 32'hA5A5_5A5A`; `fw/pmc/src/secure_boot.c` `pmc_secure_boot_verify(){ return 0; }`; `fw/boot-rom/reset.S` `jr t1` to handoff word `0x0000_0000_8000_0000`. |
| NPU | AXI-Lite single-master MMIO, no source-ID, bypasses IOMMU | **TRUE** | `rtl/npu/e1_npu.sv` exposes only `m_axil_*` (AXI-Lite), no DID/PASID side-channel. |
| Consumer contract | `TeeEvidence` real, policy verifier real, checkers exist | **TRUE, with one correction (below)** | `packages/agent/src/services/tee-evidence.ts` + `tee-policy.ts`; `scripts/check_tee_attestation_evidence.py` present. |

**Drift correction vs the lanes.** Several lane docs cite the canonical
`TeeEvidence` type as living at `packages/core/src/types/tee.ts`. It does **not**.
`packages/core/src/types/tee.ts` defines only `TEEMode`, `TeeType`, `TeeAgent`,
`RemoteAttestationQuote`, `DeriveKeyAttestationData`, etc. The canonical
`TeeEvidence` / `TeeMeasurements` / `TeeClaims` / `TeeFreshness` types and
`normalizeTeeEvidence` live **only** in
`packages/agent/src/services/tee-evidence.ts`; the policy verifier
`evaluateTeeEvidencePolicy` is in `packages/agent/src/services/tee-policy.ts`.
§7 of this doc binds to those exact definitions, not to `core/types/tee.ts`.

Net: the **contract is real, the silicon mechanisms are not.** This program makes
the existing contract true in hardware. It does not invent a new TEE.

---

## 1. The single design (one SKU)

One device, one threat model, one confidential domain. No variant matrix.

```
   E1-RoT (OpenTitan Earl Grey-class Ibex)   ← root, holds everything in reset
        │ measured-boot release, DICE UDS→CDI, attestation key, alert handler
        ▼
   M-mode TSM (CoVE/AP-TEE Security Manager, ≤10k LoC)   ← spine, tiny TCB
        │ owns MTT page-state machine + measured launch + quote
        │ Smepmp (Dorami) wall isolates TSM from untrusted OpenSBI inside M-mode
        ▼
   Single-tenant whole-OS confidential VM (TVM)
   elizaOS-Linux/AOSP + agent runtime + NPU runtime + weights + user data
        │              ▲                         ▲
        │ MTT (Smmtt)  │ MCIE: AES-CTR + counter │ Secure I/O: 2-stage IOMMU +
        │ DRAM-sized   │ integrity tree at memctl │ IOPMP, NPU re-homed behind it
        ▼              │ (NOT XTS — TEE.fail)     │ as confidential I/O
   On-package / PoP LPDDR5X (memory packaging defeats the DDR interposer)
```

Trust boundary: **UNTRUSTED** = host hypervisor/Salus, host drivers, OpenSBI,
PMIC/clock/console init, unassigned DMA masters, USB/UFS/Wi-Fi/debug. **TRUSTED
(TCB)** = RoT + DICE, M-mode TSM, the measured TVM, MTT + MCIE.

Owner-decision boundary (confirm, see §9): "whole OS in the TEE" is a
single-tenant secure-appliance model (Apple PCC / Knox Vault framing). It removes
co-tenant side channels and — with the §3 memory packaging — raises the bar on
the physical bus channel that broke the incumbents, but it does not by itself stop
power/EM analysis (T9, staged in `04`).

---

## 2. Confidential CPU + memory domain (TSM, CoVE, page-state, measured launch)

**Model: single-tenant whole-OS CoVE/AP-TEE confidential VM driven by a tiny
M-mode TSM, using the H-extension two-stage MMU + Smmtt/MTT.** Not a Keystone
per-process enclave (ePMP region count cannot describe a whole Linux address
space), not a multi-tenant hypervisor (needless scheduler TCB). This matches the
upstream RISC-V CoVE/Smmtt direction: the `mttp` CSR holds the MTT root PPN + a
supervisor-domain ID (SDID); the TSM runs as the supervisor-domain manager and
uses the Smmtt MTT to enforce TVM isolation per physical page.

### 2.1 Work items

| ID | Deliverable (NEW) | Effort | Risk | Gate that proves it |
|---|---|---|---|---|
| C1 | `docs/spec-db/tee-core-target.yaml` + `scripts/check_tee_core_target.py` — spec target + `forbidden_claims_until_evidence` | 0.25 PM | low | `tee-core-target-check` (→ `smoke`) |
| C2 | `scripts/tee/page_state_model.py` + test — pure-Python page-state Mealy machine (the buildable-now proof of the 6-state contract) | 0.75 PM | low | `tee-page-state-model-check` |
| C3 | `rtl/security/e1_mtt_checker.sv` — per-access MTT walk + hardware invariants (deny host/DMA reads of `private`/`measured`/`scrub-pending`; block writes to `measured` after launch-freeze; force `scrub-pending` deny-all until scrub-done); MTT-update port gated to the single TSM requester ID | 2.0 PM | **high** | `cocotb-mtt-checker` + `rtl-check`; SVA: no illegal edge completes |
| C4 | `rtl/security/e1_tsm_epmp_wall.sv` — Smepmp rule-locked region wall (Dorami) protecting TSM memory from OpenSBI inside M-mode | 1.0 PM | med | `cocotb-tsm-wall` |
| C5 | `scripts/tee/teeevidence_quote.py` + test — measured-launch chain → `TeeEvidence` serializer (§7) | 0.75 PM | med | `tee-quote-check` |
| C6 | `scripts/check_tee_core_scope.py` + `docs/evidence/security/tee-core-evidence-gate.yaml` — aggregate scope gate; keeps `release_claim_allowed:false`; enumerates every BLOCKED hardware claim | 0.75 PM | low | `tee-core-scope-check` (→ `smoke`) |

### 2.2 Page-state machine (both model C2 and RTL C3 must satisfy)

```
free ──assign──▶ private ──include@launch──▶ measured ──finalize──▶ (locked,immutable)
 ▲                  │                              │
 │ scrub-done       │ teardown/failed-launch       │ teardown
 └ scrub-pending ◀──┴──────────────────────────────┘
private ──share──▶ shared ──unshare+scrub──▶ scrub-pending
private ──assign-dev(srcID,policy)──▶ device-assigned   (srcID match from §4)
```

No `private→free` direct edge — the only exit from `private` is via
`scrub-pending`. Every undrawn edge faults in both the model and the RTL. The
**TSM owns transition policy**; the **hardware owns the invariants that must hold
even if the TSM is buggy** (the deny/freeze/scrub-gate listed in C3).

### 2.3 Measured launch (extend-only, RoT-rooted)

```
RoT ROM+lifecycle digest (anchor, §5) ─▶ TSM image digest ─▶ guest static
(kernel+initramfs+DTB+policy) ─▶ measured pages frozen (measured→finalize) ─▶
launch digest sealed ─▶ runtime extends: agent image, NPU fw + queue policy (§4)
```

Launch finalization is the event that flips every `measured` page's launch-frozen
bit (C3). After finalization any write to a `measured` page faults. The measured
set is exactly the `confidential-domain.md` attestation list.

**Phasing.** Phase 1 = secure-vault subset (C1/C2/C4/C5/C6 + a small `private`
key region behind the Smepmp wall) — fully buildable on CI now. Phase 2 =
protected-agent subset (C3 MTT checker + §3 MCIE model under cocotb; agent +
weights run as a `private`/`measured` domain). Phase 3 = whole-OS TVM on silicon.

---

## 3. Memory architecture (DEEPENED)

This is the section the owner asked to be deepened. Three sub-problems: isolation
(who may touch a page), confidentiality+integrity (what a bus observer learns),
and physical packaging (how hard it is to get on the bus at all).

### 3.1 Memory isolation — MTT (Smmtt) spine + Smepmp TSM wall

- **MTT/Smmtt is the whole-OS primitive.** A hardware-walked, TSM-owned table
  indexed by host-physical page, recording each page's confidentiality class.
  Checked on **every** access reaching the L2/system bus — CPU loads/stores
  **and** DMA (the IOMMU consults the same policy, §4). Table-walked and
  DRAM-sized, so it scales to the whole guest and survives guest page-table churn
  (it operates on host-physical pages, independent of the guest's Sv39/Sv48). RTL
  = `e1_mtt_checker.sv` (C3).
- **Smepmp is the TSM wall only.** 16–64 region registers — perfect for the
  Dorami intra-M-mode wall (a handful of fixed regions) and the Phase-1 vault
  subset; **not** the whole-OS primitive (cannot describe a full address space,
  slow to reprogram per world-switch). RTL = `e1_tsm_epmp_wall.sv` (C4). We use
  both, each where it fits.

Page-class → MTT encoding → enforcement is the table in `01` §2.1; unchanged.

### 3.2 Memory confidentiality + integrity — the MCIE (NOT XTS)

**Placement:** a Memory Crypto + Integrity Engine inserted at the
`SLC↔DRAM` boundary (`tl_c_to_chi_bridge.sv` / the LPDDR5X controller boundary in
`rtl/memory/`), downstream of the system cache and the MTT check, upstream of the
PHY. On-die SLC hits pay **zero** MCIE cost — only true LPDDR traffic is
encrypted/verified, which makes SLC hit-rate (lane 05 E3.3) double as an MCIE
saving. BLOCKED on the same dependency as the real DRAM controller
(`docs/evidence/memory/lpddr-phy-procurement.yaml`); specified now and proven
against the AXI-Lite stand-in via an integrity-tree model + cocotb harness.

**Confidentiality — counter-mode AES, explicitly NOT XTS.**

> **TEE.fail lesson, grounded.** TEE.fail (Georgia Tech / Purdue / Synkhronix,
> Oct 2025) built a **sub-$1000 DDR5 interposer**, downclocked the bus to
> 3200 MT/s, and read enclave ciphertext on Intel SGX/TDX and AMD SEV-SNP
> (incl. SEV-SNP Ciphertext Hiding). The break is that **AES-XTS is deterministic
> per address** — the same physical block always produces the same ciphertext —
> so they built a ciphertext dictionary, recovered plaintext relations, and
> extracted Intel's PCK to **forge valid attestation reports**. CipherLeaks
> (SEV-SNP) is the same class. Therefore: **AES-XTS / any address-only
> deterministic mode is FORBIDDEN for E1 confidential memory.**

- Use **AES-CTR with a per-line monotonic write counter**: identical plaintext
  written to the same physical address at different times produces different
  ciphertext (the counter freshens the keystream on every write). This kills the
  ciphertext-equality channel by construction.
- Only `private`/`measured`/`device-assigned` pages are encrypted; `free`/`shared`
  pages are plaintext (the host needs them). The MTT class is an **input** to the
  MCIE, carried alongside the access.

**Integrity + anti-replay — counter integrity tree (Bonsai/SGX-MEE shaped).**

- A MAC per data line keyed by that line's counter, plus a tree **over the
  counters** so the counters cannot be rolled back. The tree binds the current
  counter, so a replayed `(ciphertext, counter, MAC)` triple fails at the root.
- **Tree root in on-die SRAM**, never in attacker-visible DRAM; reset to a fresh
  random value on every cold boot → cross-boot replay impossible without
  re-deriving the whole tree.
- A verification failure is **fatal**: machine-level alert to the RoT (§5) →
  key-zeroization + `scrub-pending` on the domain. No soft-fail, no log-and-continue.

**The MEE design parameters (and the 10% budget).** The integrity tree is the
dominant performance tax — public SGX-MEE data shows a naive Merkle verification
costs ~20 extra memory accesses per protected line (sibling fetches across tree
levels), and naive root-update overheads on the order of hundreds of percent that
optimized designs cut to low single digits. The E1 budget (≤10% across the board)
is met by the following, co-designed with lane 05 §6.3:

| MEE parameter | E1 choice | Why it fits the budget |
|---|---|---|
| Cipher | AES-CTR-256, per-64B-line counter | non-deterministic ciphertext (TEE.fail), parallel keystream precompute hides AES latency |
| Counter size | split counters (per-page major + per-line minor, SGX-MEE style) | 8 lines share a major counter → 1 counter-line fetch covers 8 data lines; major bump re-encrypts the page (rare) |
| Integrity tree | counter-tree, **arity 8** (64B node / 8×8B counters) | arity-8 keeps the tree shallow (≤4 levels for multi-GB DRAM) → ≤4 hash checks worst case |
| Counter cache | dedicated on-die SRAM (start 32–64 KB) **+ pinned SLC way** for upper nodes | most counter/tree fetches hit on-die; only the cold-miss path walks to DRAM |
| Freshness source | the same per-line counter feeds both the CTR keystream and the integrity tree | one freshness source, no double bookkeeping |
| MEE bypass | `free`/`shared` pages and all SLC hits | the dominant traffic (cache-resident working set) pays nothing |

Net: the only traffic that pays MEE cost is a true LPDDR miss on a `private` page,
and even then the counter/tree fetch usually hits the counter cache. The
**≤10% net** target is a `BLOCKED` claim until DRAMsim3 + (later) FireSim/silicon
transcripts exist; the DRAMsim3 sweep of counter-cache size vs effective miss
latency (lane 05 P1 / `make dramsim-sweep`) produces the component evidence.

### 3.3 Physical memory packaging (the "hard to attack without pulling the chip" requirement)

TEE.fail's entire attack surface is the **DDR bus between package and DRAM**: an
interposer/probe on the LPDDR lanes, plus downclocking to relax the analyzer's
timing. Cryptography (§3.2) removes the *deterministic-ciphertext* leak, but the
durable structural defense is to **eliminate the probeable bus**.

**Recommendation: in-package LPDDR5X via PoP (Package-on-Package), not socketed
or board-down DRAM.** Evaluation against the threat model:

| Option | Bus exposure | Interposer/probe (TEE.fail/T4) | Cold-boot / chip-pull | Verdict |
|---|---|---|---|---|
| Socketed DIMM | Full DDR bus on connector pins | Trivial — exactly the TEE.fail setup | Easy (pull module) | **Reject.** This is the broken incumbent topology. |
| Board-down DRAM (BGA on PCB, separate package) | DDR lanes routed on PCB between two BGAs | Feasible — interposer/needle-probe on PCB traces/vias | Possible (reball/lift) | **Reject for v1 confidential claim.** PCB traces are probeable. |
| **PoP — DRAM package stacked on SoC package** | DDR lanes are micro-bump/interposer traces **inside the package stack**, not on the PCB | Requires delidding + micro-probing the inter-package interface — far harder than a connector or PCB trace; defeats the cheap interposer | Requires destroying the package stack | **Recommend.** Standard mobile-SoC topology; raises the bus-probe bar to invasive (T8-class). |
| Full in-package / 2.5D-on-interposer (DRAM die + SoC on one substrate) | DDR routing entirely on a silicon/organic interposer in one package | Requires die-level FIB/decap | Destroys the part | Best, but higher cost/area; track as a v2/premium option. |

Rationale: PoP moves the DDR PHY-to-DRAM interface off the PCB and inside the
package stack, so the cheap TEE.fail-style interposer (which clips onto a socket
or PCB-level bus) no longer has a place to attach. Combined with §3.2
non-deterministic ciphertext + integrity tree, an attacker who *does* invest in
delidding still only sees fresh, integrity-bound, replay-checked ciphertext —
both the cheap channel and the data-recovery channel are closed. This is the
"hard to attack without pulling the chip off the board" property: getting on the
bus now requires destroying the package, and even then yields nothing useful.

Cold-boot DRAM remanence is additionally mitigated because the MCIE tree root and
keys live in on-die SRAM zeroized on cold boot / tamper (§5) — a pulled or frozen
DRAM is unreadable without the on-die root, which is gone.

**Gate / status.** Memory packaging is a board+package decision; it is
**BLOCKED** on the LPDDR5X PHY procurement
(`docs/evidence/memory/lpddr-phy-procurement.yaml`) and the package design. The
plan records the PoP recommendation as the v1 target and the full in-package /
2.5D option as the v2 stretch; the bus-probe / ciphertext-bench validation
(`TC-SC-CIPHER-*`, lane 04 §6.3) stays fail-closed until silicon + a DDR capture
bench exist (the same bench TEE.fail used — now run *against* the E1 MCIE to prove
no deterministic collision).

---

## 4. Secure I/O — the biggest rebuild, the headline confidential-AI feature

The IOMMU is a partial verification scaffold (identity passthrough in BARE,
6-entry allowlist fallback, local DDT + Sv39 first-stage KAT under identity
G-stage; no full two-stage PTW, no IOPMP, no MSI translation; NPU + DMA bypass
it entirely). Whole-OS confidential I/O is still largely greenfield here.

### 4.1 Work items (phased; all NEW RTL)

**Phase A — real translation + IOPMP (foundation):**

| ID | NEW file | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| IO1 | `rtl/iommu/e1_iommu_ptw.sv` | Complete two-stage PTW (S1 Sv39/Sv48 + G-stage Sv39x4/Sv48x4) over the downstream AXI4 master + small TLB; extends the current local S1 Sv39 KAT path, replaces identity passthrough for protected domains, and forbids BARE for any domain holding `private` pages | 3.0 | high | `cocotb-iommu` (`two_stage_translation_via_3lvl_ddt`), `iommu-evidence-check` |
| IO2 | `rtl/iommu/e1_iommu_ddt_pdt_walker.sv` | Memory-resident DDT (1/2/3-level) + PDT walk replacing the on-chip allowlist; **monitor-only DDTP programming** | 2.0 | high | `cocotb-iommu`, `iommu-evidence-check` |
| IO3 | `rtl/iommu/e1_iopmp.sv` + `_pkg.sv` | RISC-V IOPMP: per-source-ID region table, R/W/X, lockable entries, default-deny; downstream of the IOMMU as redundant region enforcement | 2.5 | high | `cocotb-iopmp` + `iopmp-evidence-check` |
| IO4 | `rtl/iommu/e1_iommu_cmd_engine.sv` | Command-queue execution beyond the local IOFENCE.C fetch/decode/completion path: `IOTINVAL.VMA/GVMA`, `IODIR.INVAL_DDT/PDT` side effects | 1.0 | med | `cocotb-iommu` |
| IO5 | `rtl/iommu/e1_iommu_fq_dma.sv` | DMA fault records to the FQB ring over the downstream master (today FQ never reaches DRAM) | 0.5 | med | `cocotb-iommu` |

**Phase B — source-ID coverage + revoke/scrub:**

| ID | NEW file | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| IO6 | `rtl/iommu/e1_master_sourceid_tag.sv` | Source-ID tag shim for **every** DMA master (USB, UFS/eMMC, ISP/CSI, GPU, codec, Wi-Fi, debug) onto IOMMU upstream ports; binds each to its `dma-buf-v2.md` DID | 1.5 | med | `cocotb-iommu-sourceid` |
| IO7 | `rtl/iommu/e1_iommu_revoke_scrub.sv` | Monitor-driven revoke port + scrub-engine handshake; revoke → quiesce → pages `scrub-pending` | 1.5 | high | `cocotb-iommu-revoke` |
| IO8 | `docs/evidence/security/secure-io-evidence-gate.yaml` | Fail-closed gate enumerating assigned-vs-shared, revoke/scrub, NPU isolation tests | 0.5 | low | `secure-io-evidence-check` |

**Phase C — device measurement (SPDM-shaped):**

| ID | NEW file | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| IO9 | `rtl/security/e1_device_attest.sv` | SPDM-shaped responder + RoT measurement hook; emits device fw digest into a measurement register | 2.0 | high | `cocotb-device-attest` |
| IO10 | `fw/monitor/device_assignment.c` | measure → policy-check → install DC+IOPMP → assign; fail-closed to mediated on mismatch | 1.5 | med | `secure-io-evidence-check` |

**Phase D — NPU as secure I/O (the headline):**

| ID | NEW file | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| IO11 | `rtl/npu/e1_npu_secure_io.sv` | Re-home NPU DRAM traffic off the lite AXI-Lite path onto an IOMMU upstream port with the NPU source ID; descriptor/tensor fetch now traverses IOMMU+IOPMP | 2.5 | high | `cocotb-npu-secure-io` |
| IO12 | `rtl/npu/e1_npu_queue_owner.sv` | Private command-queue ownership FSM: `unowned→measuring→assigned(domainX)→draining→scrubbing→unowned`; doorbell/`DESC_*`/`TENSOR_MEM` gated by current owner; drain via `BARRIER`; scrub on teardown | 2.0 | high | `cocotb-npu-secure-io` |
| IO13 | `rtl/npu/e1_npu_counter_guard.sv` | Gate `PERF_CYCLES`/`PERF_MACS`/`PERF_FALLBACKS` + timing-observable status to monitor-only when owned-private (no host counter leakage; H100 CC-On model) | 0.5 | med | `cocotb-npu-secure-io`, cross-ref §6 |

**Phase E — secure interrupts:**

| ID | NEW file | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| IO14 | `rtl/iommu/e1_iommu_msi_xlate.sv` | MSI translation + MRIF + `MSI_CFG_TBL` (IGS=2 already advertised); per-DC MSI permission | 2.0 | high | `cocotb-iommu` (MSI cases) |
| IO15 | `rtl/interrupts/e1_imsic.sv` | Per-hart IMSIC files incl. monitor-only M-mode file; untrusted-device MSIs routable only to the host file (Ahoi defense) | 2.5 | high | `cocotb-imsic` |

### 4.2 Assigned-vs-shared device contract

| Master class | `private`? | `device-assigned`? | `shared`? | Mechanism |
|---|---|---|---|---|
| Assigned, measured (NPU; optionally display for protected scanout) | no (only its own subset) | yes | yes | DC + locked IOPMP regions |
| Untrusted (USB, UFS, Wi-Fi, debug) | no | no | yes | DC maps shared-only; bounce buffers |
| Host kernel DMA outside any domain | no | no | yes (its own) | default-deny into all domain pages |

`private→device-assigned` is legal **only** after the IOPMP policy for that source
ID is installed (enforced by the §2 page-state machine). On teardown/fault: revoke
DC + IOPMP region, drain the master, pages → `scrub-pending` until zeroized.
All-on-die accelerators (Gemmini NPU) need no PCIe IDE/TDISP link encryption;
across-interconnect encrypt+sign is recorded fail-closed (`npu-link-crypto.md`,
BLOCKED, not required for v0).

---

## 5. Root of trust

**Decision: integrate an OpenTitan Earl Grey-class Ibex secure subsystem as a
*discrete* RoT block — vendored, not from-scratch.** Rationale: the threat model
(bus-probe T4, storage-replacement T3, lost/stolen T5) requires chained signature,
rollback, debug-auth, OTP write-lock, RMA scrub — exactly the mitigation set
OpenTitan already implements in silicon-proven, Apache-2.0, RISC-V, CLI-buildable
RTL (`scripts/bootstrap_ibex.sh` exists). From-scratch (option B) re-derives
constant-time crypto, masked AES, lifecycle, entropy correctness for no security
gain. Folding the RoT into the PMC (option C) drags DVFS/PMIC/thermal into the TCB
— rejected; the RoT is discrete (Apple SEP / Knox Vault model) and **holds the
CVA6 cluster + PMC in reset, releasing only on verified measured boot.** Mailbox
(TL-UL), not shared memory, is the AP↔RoT interface — no AP-visible path to RoT
SRAM/OTP/keymgr.

Reused as-is from OpenTitan: `aes`, `hmac`, `kmac`, `csrng`, `edn`,
`entropy_src`, `keymgr`, `otp_ctrl`, `lc_ctrl`, `alert_handler`, `rom_ctrl`.
E1-specific (must write): the mask-ROM `OPNPHN01` parser/verifier, the TL-UL
mailbox glue, the IOPMP-policy programming sequence.

### 5.1 Work items

| ID | NEW path | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| R1 | `rtl/security/rot/` | OpenTitan Earl Grey-class subsystem integration wrapper + TL-UL mailbox to CVA6/PMC; reset-release sequence | 8.0 | **high** (cross-domain integration — the long pole) | `rot-integration-check` |
| R2 | `fw/boot-rom/secure/verify.c` + `ed25519_ct.c` + `sha256.c` | mask-ROM `OPNPHN01` parser, **constant-time Ed25519** verify, SHA-256, fail-closed halt records | 3.0 | med (constant-time correctness) | `bootrom-check`, `boot-security-chain-contract-check` |
| R3 | `fw/boot-rom/secure/measure.c` | measurement-register extend + keymgr advance per stage; export to mailbox | 1.5 | med | `boot-security-chain-contract-check` |
| R4 | `rtl/security/otp/e1_otp_map.sv` + `scripts/check_otp_fuse_map.py` | OTP shadow regs, 2-of-3 majority read, write controller, parity-fault halt | 3.0 | med | `otp-fuse-map-check` |
| R5 | `rtl/security/lc/e1_lc_ctrl.sv` | replace the 2-bit `e1_lifecycle.sv` with 6-state one-hot lc_ctrl; signed debug-auth challenge (retires the XOR placeholder) | 2.5 | med (retires existing block) | `security-lifecycle-scope-check` |
| R6 | `fw/dice/` shim + `docs/sw/security/dice-rot-binding.md` | bind RoT UDS/measurements to the existing CDI lane (`build/dice/test_cdi_chain`, `gate-dice-measurement-chain-check` PASS); no re-impl | 1.0 | low | `dice-measurement-chain-check` |
| R7 | `tests/security/negative/` | unsigned / tampered / wrong-key / corrupt-header / rollback-downgrade rejection vectors + debug-locked transcript | 2.0 | low | `boot-security-chain-contract-check` |
| R8 | `docs/spec-db/tee-attestation-evidence.e1-rot.json` | RoT-produced `TeeEvidence` fixture per §7 | 0.5 PM | low | `tee-attestation-evidence` |
| R9 | `fw/provisioning/e1_provision.py` | ATE OTP programming + readback-verify; RMA scrub | 2.0 | med | `provisioning-readback-check` |

DICE chain: `SRAM-PUF/OTP secret →(keymgr, never exported)→ UDS → CDI_layer0 =
KDF(UDS,H(BL1)) → CDI_BL1 → CDI_BL2 → CDI_monitor → DeviceID/Alias keypair →
X.509 chain (DeviceID creator-signed, Alias per-boot)`. The Alias cert chain +
per-stage measurements become the `quote`/`certificatePem`/`measurements` of §7.

**Negative-evidence requirement (non-negotiable):** the first "development secure
boot prototype" claim is gated on R7 producing reproducible rejection transcripts.
A passing positive boot alone is insufficient.

---

## 6. Side-channel + physical hardening

Memory encryption + attestation are necessary but never sufficient — TEEs fall to
**observation and fault**, not broken crypto. Each control maps to specific RTL /
floorplan / RoT work and to a concrete attack.

| Attack class (research) | E1 control | RTL / owner |
|---|---|---|
| Controlled-channel / page-fault (Xu et al.) | no shared page-walker state across the boundary; TLB/PWC flush on switch | CVA6 MMU purge (`cd_purge`) |
| Branch leakage (branch shadowing on SGX, BranchScope) | BPU partition-or-flush on switch | `rtl/cpu/bpu/*` `bpu_cd_purge` strobe |
| Cache timing (Prime+Probe, Flush+Reload) | L1 flush; L2/L3/SLC **way-partition** (disjoint CD ways) | `rtl/cache/slc/e1_slc.sv` `way_alloc_mask` (already present) |
| Transient (Foreshadow/L1TF, MDS) | L1D drain (MSHR + store buffer) before invalidate; no cross-domain fill forwarding | CVA6 LSU + `e1_l1d_cache.sv` MSHR |
| **Single-step (SGX-Step, TDXdown, StumbleStepping)** | see below — **AEX-Notify-style atomic re-entry**, not a detection heuristic | monitor + `cd_purge_seq.sv` |
| Notification injection (Ahoi) | secure IMSIC routing + interrupt-rate clamp | IO15 + monitor |
| **Ciphertext side channel (CipherLeaks, TEE.fail)** | §3.2 non-deterministic AES-CTR + counter tree; §3.3 PoP packaging | MCIE + package |
| Voltage/clock fault (Plundervolt, CLKSCREW, VoltJockey) | droop/clock-glitch sensors → alert → zeroization | `rtl/power/droop_sensor.sv` (exists) + `clk_glitch_mon.sv` (new) |
| PMU/timer as oracle | `mcountinhibit` force-inhibit + `rdcycle`/`mcycle` coarsening while CD-resident | `rtl/cpu/csr/zihpm.sv`, `bpu_csr.sv` |
| Power/EM key extraction (DPA/CPA) | first-order masked AES/sig, constant-time, verify-after-sign | RoT crypto (R-lane); staged T9 |
| Physical glitch/probe/light | sensors + dual-rail alerts + escalation → zeroization; shadow registers | `alert_handler` (RoT) + sensors |

**Single-step — the one to get right (grounded update vs the lanes).** TDXdown
(CCS 2024) **defeats TDX's built-in single-step detection heuristic** by deluding
the security monitor about elapsed time, and StumbleStepping turns the prevention
mechanism itself into an instruction-count side channel; subsequent work shows
**AEX-Notify's "obfuscated forward progress" guarantee does not hold** and enables
ECDSA key leakage. Implication for E1: do **not** rely on a step-*detector* alone
(it is the part that gets defeated). Lead with **structural defenses** — the
warm-up/atomic-re-entry trampoline that re-establishes the next-instruction
working set so a single step yields no clean observation, plus the
interrupt-rate clamp — and treat the retired-instruction step detector as a
secondary tamper signal that escalates, never as the sole guarantee. Secret-
dependent crypto must additionally be constant-time + control-flow-balanced so
that even a perfect single-step leaks no key-dependent branch (the
StumbleStepping/wolfSSL-ECDSA lesson).

**Microarch purge sequencer.** One `cd_state_purge` pulse per boundary crossing,
fanned out by `rtl/cpu/cd_purge_seq.sv` (new) in dependency order: (1) stop fetch
/ quiesce prefetch, (2) drain store buffer + MSHRs, (3) writeback-invalidate L1D,
(4) invalidate L1I + TLB/PWC, (5) flush BPU/RAS/BTB, (6) freeze+zero PMU, (7) ack.
The monitor blocks re-entry until ack (Sanctum/MI6 state-purge). SVA proves no CD
boundary completes while any purge ack is low and no CD-ASID L1D line survives exit.

**Tamper response → zeroization.** Reuse `droop_sensor.sv` (route `droop_alarm_o`
into the alert network, not only DVFS); add clock-glitch, temp, and (BLOCKED on
PDK analog macro) light/laser sensors. Dual-rail alert encoding (a cut wire is an
alarm). Escalation phases → interrupt+log → NMI → **secret wipe** (MEE keys, DICE/
attestation key, KeyMint blobs, ephemeral keys) + **SRAM scramble-key scrub**
(`pmc_top.sv` `scramble_key_*` ports, tied off today) + CD teardown to
`scrub-pending`. Escalation completes **autonomously in hardware** even if firmware
is hung. Shadow registers on every security-critical control (lifecycle, alert
enables, key-release gates, way-mask/purge policy): a single fault that flips the
live copy without the shadow trips a mismatch → escalation.

**Debug fused-off in production.** The XOR auth is retired (R5); LOCKED devices
cannot be debugged; RMA destroys production secrets before unlock.

Evidence: pre-silicon runnable now — `tee-side-channel-scope-check`,
`tee-purge-sva` (Verilator/formal), `tee-mee-freshness-model`. FPGA-BLOCKED —
single-step harness, cache/BPU residue probe, gate-level fault campaign. Lab-
BLOCKED — TVLA, DPA/CPA, physical fault injection, **ciphertext bench (DDR capture
replaying TEE.fail against the E1 MCIE)**, tamper E2E. All fail-closed.

---

## 7. THE UPWARD ATTESTATION CONTRACT (silicon → OS → agent → dstack)

This is the cross-layer seam: what the silicon **produces** that the OS and agent
layers **consume**. It is bound to the **actual** canonical type at
`packages/agent/src/services/tee-evidence.ts` (NOT `core/types/tee.ts` — see §0
drift correction) and verified by `evaluateTeeEvidencePolicy` in
`packages/agent/src/services/tee-policy.ts`, plus the chip-side
`scripts/check_tee_attestation_evidence.py` and the OS manifest at
`packages/os/docs/tee-measured-boot-contract.md`.

### 7.1 What the RoT/TSM must expose, field by field

The silicon emits a quote that normalizes (via `normalizeTeeEvidence`) to this
exact `TeeEvidence` shape:

| `TeeEvidence` field | Type | Silicon source (who measures / sets it) | Consumed by |
|---|---|---|---|
| `kind` | `TeeKind` = `"cove"` | fixed for the whole-OS TVM (shape A fallback: `"keystone"`/`"eliza-vault"`) | policy `allowedKinds` |
| `provider` | string | `"eliza-riscv"` | policy `allowedProviders` |
| `hardwareVendor` / `platformVersion` | string | `"eliza"` / `"e1-<rev>"` (RoT ROM+lifecycle version) | display / policy |
| `securityVersion` | int | max programmed rollback index across boot slots (OTP, R4) | policy `minSecurityVersion` |
| `measurements.boot` | `sha256:<64hex>` | RoT: `sha256(rom_ctrl digest ‖ H(BL1) ‖ H(BL2) ‖ H(OpenSBI/TSM-driver))`, DICE-folded (R3) | golden-digest match |
| `measurements.monitor` | `sha256:` | TSM-driver measures TSM image at load (C5) | golden-digest match (required when `npuProtected`) |
| `measurements.os` | `sha256:` | TSM measures kernel+initramfs+DTB+rootfs at TVM `add-region`/`finalize` | golden-digest match (required) |
| `measurements.policy` | `sha256:` | TSM measures the in-domain policy blob at finalize | golden-digest match (required) |
| `measurements.device` | `sha256:` | TSM/IOPMP source-ID policy digest (§4, `tee-iopmp-source-id-map.json`) | golden-digest match (required) |
| `measurements.agent` | `sha256:` | in-domain attestation agent hashes agent image at first run | golden-digest match (required) |
| `measurements.container`/`compose` | `sha256:` | optional, containerized agent | optional |
| `measurements.npuFirmware` | `sha256:` | NPU runtime hashes NPU fw + queue-policy before private-queue ownership (IO12) | required when `npuProtected` |
| `claims.secureBoot` | bool | **true only** when the §5 boot chain verified end-to-end | policy `requiredClaims` (required true) |
| `claims.debugDisabled` | bool | **true only** when lifecycle==LOCKED and debug ports gated (R5) | required true |
| `claims.productionLifecycle` | bool | **true only** when lifecycle==LOCKED | policy |
| `claims.memoryEncrypted` | bool | **true only** when MCIE active on the domain's `private` pages (§3.2) | required true for `kind:"cove"` |
| `claims.ioProtected` | bool | **true only** when IOPMP source-ID policy programmed + IOMMU not in BARE for the domain (§4) | required true |
| `claims.npuProtected` | bool | **true only** when NPU fw measured + private-queue ownership held + counter guard active (§4 D) | policy (then `monitor`+`npuFirmware` required) |
| `freshness.nonce` | string | CSRNG-drawn, bound to `boot_counter` and the verifier challenge | policy `expectedNonce` |
| `freshness.timestamp`/`verifier` | string | RFC3339 + verifier id (`"eliza-local-verifier"` default) | policy `maxAgeMs` |
| `quote` | base64 | CoVE attestation evidence signed by the RoT-derived DICE key | signature/cert-chain verify |
| `certificatePem` | PEM | DICE Alias cert chain (R6) | chain to DeviceID root |
| `reportData` | `sha256:` | binds `H(nonce ‖ ephemeral pubkey)` so the quote is non-replayable and tied to the live RA-TLS channel | freshness/channel binding |

### 7.2 Key-release semantics (how dstack KMS / the agent gate on it)

```
verifier issues nonce
 → in-domain attestation agent calls TSM "get-attestation", reportData = H(nonce‖epk)
 → TSM returns CoVE quote signed by the RoT DICE key (cert chain)
 → agent assembles TeeEvidence, serves over RA-TLS (epk in TLS cert)
 → verifier runs evaluateTeeEvidencePolicy(evidence, policy):
      allowedKinds, allowedProviders, requiredMeasurements (golden digests from the
      reproducible image manifest), revokedMeasurements, minSecurityVersion,
      expectedNonce, maxAgeMs, requiredClaims
 → trusted → KMS releases the data-encryption key WRAPPED TO epk
 → agent unseals model weights / user data; ~/.local/state/milady private volume mounts
```

The negative path is enforced by **data unavailability, not a software check**: a
tampered OS/agent yields a different `measurements.os`/`agent`, the policy returns
`measurement-mismatch`, the KMS withholds the key, and weights/user data stay
sealed. dstack's KMS (or the elizaOS local verifier, default for local-first) is
the consumer; Eliza Cloud is an optional remote verifier/KMS, never required for
local operation. **Extend `check_tee_attestation_evidence.py` (do not fork)** to
require `monitor` + `npuFirmware` whenever `claims.npuProtected` is true.

### 7.3 The RoT/TSM must therefore expose, concretely:

1. **Measurement registers**: an extend-only boot measurement register (RoT,
   `rom_ctrl` digest + keymgr-bound H(BL1)/H(BL2)/H(monitor)) and a TSM-owned TVM
   measurement context (os/policy/device at finalize; agent/npuFirmware at
   runtime). All `sha256:`.
2. **A DICE-derived per-boot attestation key** (Alias) whose cert chains to a
   creator-signed DeviceID, exported only via the mailbox; the UDS is never
   software-visible.
3. **The five claim gates** (`secureBoot`, `debugDisabled`, `memoryEncrypted`,
   `ioProtected`, plus `npuProtected`) wired to the real silicon conditions above
   — never settable true except by the component that owns the condition.
4. **A CSRNG nonce + `boot_counter` binding** and the `reportData` channel binding,
   so quotes are fresh and non-replayable.

---

## 8. Sequenced Plan

### Phase 1 — Buildable now (models, contracts, gates; no silicon)
Establish the executable contract + fail-closed floor on a laptop.
- OS WI-0: wire the **already-existing-but-orphaned** `check_tee_*.py` + fixtures
  into a `tee-software-check` aggregate on `make smoke` (0.25 PM — do first; pure win).
- C1/C2/C5/C6 (page-state model, quote serializer, scope gates).
- R8 (RoT `TeeEvidence` fixture), DICE binding (R6, gate already PASS).
- Lane-04 `tee-side-channel-scope-check` + `tee-mee-freshness-model`.
- Lane-05 in-tree perf loop (BPU/cache/SLC + DRAMsim3 + ChampSim) + P0 experiments.

### Phase 2 — FPGA / simulator (RTL lands, cocotb/formal pass vs stand-ins)
- C3 `e1_mtt_checker.sv`, C4 `e1_tsm_epmp_wall.sv`, MCIE model (`e1_mcie_model.sv`
  + integrity-tree model) against the AXI-Lite stand-in.
- R2/R3 secure boot ROM (constant-time Ed25519 + SHA-256, measurement extend),
  R5 `e1_lc_ctrl.sv` (retire the 2-bit block), R4 OTP RTL; R7 negative vectors.
- IO1–IO5 (PTW + DDT/PDT + IOPMP), IO6/IO7 (source-ID + revoke/scrub), then
  **IO11–IO13 NPU secure-I/O re-home + private-queue FSM + counter guard** (the
  headline), then IO14/IO15 (MSI/IMSIC).
- Lane-04 `cd_purge_seq.sv` + purge SVA, single-step detector, clk-glitch monitor;
  FPGA residue/single-step harnesses BLOCKED until bitstream.
- OS WI-6/WI-7 Salus + CoVE TSM bring-up, riscv64 CoVE QEMU/Renode harness
  (BLOCKED until target exists), NPU private-queue attestation contract.

### Phase 3 — Silicon (product claims; almost all BLOCKED today)
R1 OpenTitan RoT silicon + key ceremony; full CoVE TSM + H-ext two-stage + MTT for
the whole guest; MCIE on real LPDDR5X with **PoP packaging** (§3.3); side-channel/
fault lab (TVLA, DPA, glitch/laser, **ciphertext bench**, tamper E2E); end-to-end
signed `TeeEvidence`; confidential elizaOS-Linux boot. Every claim fail-closed.

### Effort & critical paths

| Lane | Buildable-subset PM | Long pole |
|---|---|---|
| Core (C1–C6) | ~6 | MTT checker C3 + MCIE model (high risk) |
| RoT (R1–R9) | ~23.5 | **R1 OpenTitan integration (~8 PM, the program long pole)** |
| Secure I/O (IO1–IO15) | ~22 | **IOMMU rebuild + NPU isolation (greenfield)** |
| Side-channel/phys | substantial; most evidence lab-BLOCKED | masked crypto + tamper sensors |
| Perf | experiment-driven (P0 now → P3 fork-gated) | application-core choice (§9) |
| OS software | ~9 | Salus/TSM bring-up + riscv64 CoVE target |

**~60+ person-months** of buildable engineering before lab/silicon. **Two critical
paths run in parallel: (1) R1 OpenTitan RoT integration, (2) the IOMMU+IOPMP+NPU
secure-I/O rebuild.** Everything else sequences behind C3 (MTT) and the §5 boot
chain. The whole effort is designed against the lane-05 ≤10% perf budget.

---

## 9. Open owner-decisions (gate large downstream work; not ours to assume)

1. **Application core.** CVA6 little-core won't hit phone-class perf. Lane 05
   recommends mid-core-first on **XiangShan Kunminghu V3** in XS-GEM5; the big
   core is selected as the **open Kunminghu V3 8-wide scale-up** (no vendor IP
   license; Tenstorrent Ascalon-D8 was surveyed but rejected for lack of
   published mobile-volume license terms). The remaining big-core gate is the
   external XiangShan checkout + 8-wide scale-up microbench, not licensing.
   This drives the H-ext/TSM integration target and the whole perf lane.
2. **OpenTitan integration depth.** Vendored Earl Grey (≈8 PM, fastest real RoT)
   vs trimmed from-scratch (smaller TCB, much slower). **Recommend vendored.**
3. **v1 memory-encryption scope.** Full MCIE on LPDDR5X is silicon-BLOCKED. Decide
   whether the first FPGA milestone targets the **protected-agent subset** (agent +
   weights private) or attempts whole-OS — MCIE bandwidth is the dominant perf cost.
4. **Memory packaging.** **Recommend PoP LPDDR5X for v1** (§3.3) to defeat the
   TEE.fail interposer; full in-package/2.5D as a v2/premium stretch. Confirm the
   package budget accepts PoP.
5. **Android timeline.** AVF/pKVM is ARM64-only; riscv64 has a 16KB-page gap. Lane
   06 recommends **Linux-first, AOSP-later** (CoVE/TSM, not AVF/pKVM). Confirm.
6. **Whole-OS vs appliance threat boundary.** "Everything in the TEE" is a
   single-tenant appliance: it cuts co-tenant side channels and (with PoP + AES-CTR
   + integrity tree) closes the cheap bus/ciphertext channel, but does not stop
   power/EM (T9, staged). Confirm the threat model accepts that boundary (it
   matches Apple PCC / Knox Vault).

---

## 10. What changed vs `00-overview`

This plan is consistent with `00-overview` and does not overturn its decisions. It
adds/sharpens:

- **Drift correction:** `TeeEvidence` is in `packages/agent/src/services/tee-evidence.ts`,
  **not** `packages/core/src/types/tee.ts` (which has only `TEEMode`/`TeeType`/
  `TeeAgent`). The §7 contract binds to the real location. `claims.memoryEncrypted`
  and `claims.npuProtected` are first-class in the type and are added to the §7
  field table (the lanes mention them in prose but `00`'s field table omitted them).
- **Memory deepened (§3):** concrete MEE parameters (split counters, arity-8
  counter tree ≤4 levels, 32–64 KB counter cache + pinned SLC way) tied to the
  ≤10% budget and grounded in SGX-MEE overhead data; a concrete **physical
  packaging recommendation (PoP LPDDR5X)** with a threat-model table — this was an
  open item in `00` §5.3, now answered as a v1 recommendation (still BLOCKED on
  PHY + package).
- **Single-step hardened (§6):** updated for **TDXdown / StumbleStepping / broken
  AEX-Notify guarantee** — lead with structural atomic-re-entry + rate clamp +
  constant-time crypto, demote the step *detector* to a secondary tamper signal
  (the lanes leaned more on detection).
- **Attestation contract made exact (§7):** a single field-by-field table from
  silicon source → `TeeEvidence` field → policy consumer, plus the precise list of
  measurement registers, claims, and key-release semantics the RoT/TSM must expose
  for dstack KMS / the agent key-release client to gate on.

No claim in this document is silicon evidence. Each is bound to a fail-closed gate;
product-grade claims stay **BLOCKED** until the named FPGA / silicon / LPDDR-PHY /
lab transcript exists.

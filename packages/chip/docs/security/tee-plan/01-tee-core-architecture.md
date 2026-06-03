# TEE Core Architecture — Confidential CPU + Memory Domain

Date: 2026-05-21
Status: pre-tapeout architecture plan. Not implementation evidence. No claim in
this document may be promoted to a product claim until the named fail-closed
gate produces a real transcript. BLOCKED here means "awaiting FPGA / simulator /
fab", not "bug".

This is the core-architecture lane of the E1 TEE program. It concretizes the
[Confidential Domain Contract](../confidential-domain.md) into a buildable
CPU+memory design and a phased work plan. It does **not** restate that
contract's page-state list, attestation field list, or I/O rule — those are the
inputs. It also does **not** design the root of trust, the secure-I/O/IOMMU/NPU
path, the side-channel/physical hardening, the CPU/memory performance work, or
the OS software stack: those are the sibling lanes
[`02-root-of-trust.md`](02-root-of-trust.md),
[`03-secure-io-iommu-npu.md`](03-secure-io-iommu-npu.md),
[`04-side-channel-physical-hardening.md`](04-side-channel-physical-hardening.md),
[`05-cpu-memory-performance.md`](05-cpu-memory-performance.md), and
[`06-os-on-tee-software.md`](06-os-on-tee-software.md). Cross-references below
point at those files by filename; this lane owns only the trust model, the
in-core memory-isolation primitive, the memory confidentiality/integrity engine
at the controller, the measured-launch chain shape, and the monitor TCB.

## 0. Where we start (audited current state)

- CPU is `e1_cpu_subsystem` (`rtl/cpu/e1_cva6_wrapper.sv`) wrapping OpenHW CVA6
  v5.3.0 in the `cv64a6_imafdc_sv39` config. **No PMP, no ePMP/Smepmp, no
  H-extension is wired today** — a repo-wide grep finds zero `pmp`/`epmp`/
  `smmtt`/`hgatp` outside one PMA comment in `rtl/top/e1_soc_integrated.sv:796`.
  CVA6's own optional PMP is not enabled in this config build.
- The only security RTL is `rtl/security/e1_lifecycle.sv` (220 lines): a 4-state
  lifecycle FSM (UNLOCKED/LOCKED/RMA/INVALID) with an **explicitly placeholder**
  XOR debug-auth (`DEVICE_KEY_PLACEHOLDER = 32'hA5A5_5A5A`) and a static
  challenge. [`docs/arch/security.md`](../arch/security.md) is honest that there
  is no production security boundary and the boot ROM does not authenticate
  firmware.
- The RISC-V IOMMU v1.0.1 block (`rtl/iommu/`, [`docs/arch/iommu.md`](../arch/iommu.md))
  already exists with the register/fault surface, PASID fields, IOFENCE.C
  fetch/decode/completion, a local DDT + Sv39 first-stage KAT under identity G-stage, and a
  fail-closed evidence gate. **This is an important existing asset for the TEE**,
  but non-identity G-stage translation, full PDT/PASID behavior, ATS/PRI/MSI, and
  Linux/phone evidence remain blocked.
- DRAM is a 4 KiB AXI-Lite SRAM stand-in (`rtl/memory/e1_axi_lite_dram.sv`); the
  real LPDDR5X controller/PHY is BLOCKED under
  `docs/evidence/memory/lpddr-phy-procurement.yaml`. The memory
  confidentiality/integrity engine in §3 must therefore be specified now and
  inserted at that controller boundary when it lands.
- Gate culture: every block ships a Python `check_*.py` that writes a JSON
  report to `build/reports/`, keeps `release_claim_allowed: false` until real
  evidence exists, and is wired into `make smoke` / `make ci-*`. The new TEE
  work items in §5 follow this pattern exactly.

## 1. Architecture decision: trust model

**Decision: a single-tenant, whole-OS confidential VM driven by a tiny M-mode
secure monitor, using the RISC-V H-extension + CoVE/AP-TEE supervisor-domain
model — NOT a flat M-mode-monitor enclave (Keystone-style) and NOT a
multi-tenant hypervisor.**

Three candidate models were weighed:

| Model | What runs in the domain | Isolation primitive | TCB | Fit for E1 |
|---|---|---|---|---|
| A. M-mode monitor + ePMP enclave (Keystone/Penglai) | a process/library or a thin guest, monitor multiplexes ePMP regions on every context switch | Smepmp regions | tiny monitor, but ePMP region count caps the number/size of protected ranges and every domain switch reprograms PMP | poor: whole-OS guest needs hundreds of disjoint ranges; ePMP has ~16–64 entries |
| B. CoVE / AP-TEE confidential VM (Salus/Intel-TDX-shaped, Arm-CCA-Realm-shaped) | the **entire** guest kernel + drivers + agent + NPU runtime + weights + user data as one measured VM | H-extension two-stage page tables + a memory-tracking table (Smmtt/MTT) policed by an M-mode TSM (TEE Security Manager) | small TSM in M-mode; host hypervisor is **untrusted** and outside the TCB | **chosen** — matches "whole OS in the enclave except mediated I/O" exactly |
| C. Multi-tenant confidential hypervisor | many mutually distrusting VMs | same as B plus rich scheduling | large TCB, scheduler in trust path | rejected: E1 is a single-owner appliance; multi-tenancy buys nothing and grows the TCB |

**Why B over A.** The product goal is "the entire OS plus agent runtime, NPU
runtime, model weights, and user data run inside the TEE, with only a tiny
monitor + RoT + mediated I/O outside." That is definitionally a confidential VM,
not an enclave carved out of an OS. ePMP (model A) cannot describe a full Linux/
AOSP address space with a fixed handful of region registers, and reprogramming
them on every world switch is both slow and a correctness hazard. CoVE's MTT
(model B) tracks confidentiality **per physical page** in a memory-resident
table the hardware walks, which scales to all of DRAM and survives guest page-
table churn because it operates on host-physical pages independent of the
guest's own Sv39/Sv48 tables.

**Why B over C.** Single owner, single confidential domain (plus the
secure-vault subset in Phase 1). Multi-tenant scheduling is the largest single
contributor to TDX/SEV-SNP TCB size; we get the security benefit of CoVE without
paying for tenancy we will never use. The TSM stays restricted to: launch,
measure, page-state transitions, attestation, teardown/scrub.

**Where the monitor lives and how the TCB stays tiny (the Dorami/ACE lesson).**
The TSM runs in **M-mode** but is structurally isolated from the untrusted M-mode
firmware (OpenSBI). Two lessons drive the layout:

- **ACE-RISCV**: keep the security-manager small enough to be a candidate for
  formal verification. Target a TSM under ~10k LoC of policy: page-state
  checker, MTT manager, measurement/attestation glue, world-switch context save/
  scrub. Everything else (device init, PMIC, clocks, console) stays in untrusted
  OpenSBI.
- **Dorami**: isolate the monitor's own memory from the rest of M-mode firmware
  using the **rule-locking** Smepmp primitive so that even compromised OpenSBI
  cannot read or write TSM memory or jump into the middle of TSM routines. ePMP
  is therefore **not** the whole-OS isolation primitive (that is MTT, §2) — it is
  the *intra-M-mode* wall that protects the TSM itself. This is the one place
  ePMP is exactly the right tool, and it is small and static.

Net trust boundary:

```
            UNTRUSTED                    |            TRUSTED (TCB)
  host hypervisor (HS) / untrusted FW    |   TSM in M-mode (CoVE security mgr)
  device drivers in host                 |   RoT / DICE   (lane 02)
  unassigned DMA masters                 |   measured guest VM (kernel+agent+NPU rt+weights+data)
  PMIC/clock/console init (OpenSBI)      |   MTT + memory crypto/integrity engine (lane 01, this doc §3)
        — Smepmp wall (Dorami) keeps OpenSBI out of TSM memory —
```

## 2. Memory isolation primitive: MTT (Smmtt) as the spine, Smepmp as the TSM wall

**Decision: Smmtt/MTT is the whole-OS confidentiality primitive; Smepmp is used
only to wall off the TSM inside M-mode (per §1).** This is the in-core lane's
single largest RTL deliverable.

### 2.1 What the MTT is

A memory-tracking table is a hardware-walked, monitor-owned table indexed by
host-physical page that records the confidentiality class of every page of DRAM.
On **every** access that reaches the L2/system bus — CPU loads/stores *and* DMA
(the IOMMU consults the same policy via lane 03) — the page's MTT entry is
checked against the requester's world. The MTT is the hardware that makes the
Confidential Domain Contract's page states real:

| Contract page state | MTT encoding intent | Enforced by |
|---|---|---|
| `free` | unassigned, accessible to host only | MTT walk (this lane) |
| `private` | confidential, owning-domain-only | MTT walk + world tag |
| `shared` | host+domain visible bounce buffer | MTT walk allows both worlds |
| `measured` | private **and** launch-locked, immutable until launch finalizes | MTT walk + a launch-frozen bit checked by TSM (§4) |
| `device-assigned` | accessible to a measured DMA source-ID | MTT walk + IOMMU source-ID match (lane 03 owns the source-ID side) |
| `scrub-pending` | no world may access until zeroized | MTT walk denies all; scrub engine clears then transitions to `free` |

### 2.2 The page-state transition checker (RTL + TSM split)

The contract lists illegal transitions (`private→free` without scrub,
`measured` mutation after digest finalization, host DMA into `private`, etc.).
We enforce these in **two cooperating places**:

- **TSM software** owns the transition *policy*: it is the only agent permitted
  to issue MTT-update operations, and it runs a deterministic transition table
  (a Mealy machine) that rejects any illegal edge before touching the MTT. This
  is verified first as a pure model (`scripts/tee/page_state_model.py`, see §5)
  so the policy is provable on a macOS/CI host with no hardware.
- **Hardware** owns the transition *invariants that must hold even if the TSM is
  buggy*: a new RTL block `rtl/security/e1_mtt_checker.sv` performs the per-
  access walk and (a) denies host/DMA reads of `private`/`measured`/
  `scrub-pending`, (b) blocks writes to `measured` once the launch-frozen bit is
  set, and (c) forces a `scrub-pending` page to deny-all until the scrub-done
  signal from the zeroization engine returns. The MTT-update port is gated to a
  single privileged requester ID (the TSM) so untrusted M-mode firmware cannot
  edit it even though it shares M-mode.

The transition machine, as a state/edge contract that both the model and the
RTL must satisfy:

```
free ──assign(domain)──▶ private ──include@launch──▶ measured ──finalize──▶ (locked, immutable)
 ▲                          │                              │
 │ scrub-done               │ teardown / failed-launch     │ teardown
 └── scrub-pending ◀────────┴──────────────────────────────┘
private ──share(buf)──▶ shared ──unshare+scrub──▶ scrub-pending
private ──assign-dev(srcID,policy)──▶ device-assigned   (lane 03 supplies srcID match)
```

Every edge not drawn is illegal and must fault in both the model and
`e1_mtt_checker.sv`. There is no `private→free` direct edge: the only path out of
`private` is through `scrub-pending`.

### 2.3 Why not flat ePMP for the whole OS

Recorded explicitly so the decision is durable: Smepmp gives 16–64 region
registers and a clean M/S/U privilege story, which is perfect for the Dorami
TSM wall (a handful of fixed regions) and for the Phase-1 secure-vault subset.
It does **not** scale to a whole Linux/AOSP guest's physical footprint, and
reprogramming it per world-switch is slow and error-prone. MTT is table-walked
and DRAM-sized, so it is the correct primitive for the whole-OS phase. We use
both, each where it fits.

## 3. External-memory confidentiality + integrity

**Placement: a Memory Crypto + Integrity Engine (MCIE) inserted at the memory-
controller boundary in `rtl/memory/`, downstream of the system cache and the
MTT check, upstream of the LPDDR5X PHY.** It is BLOCKED on the same dependency
as the real DRAM controller (`docs/evidence/memory/lpddr-phy-procurement.yaml`),
so this lane specifies it now and ships an integrity-tree model + cocotb harness
against the existing AXI-Lite stand-in so the algorithm is provable before the
PHY exists.

### 3.1 Confidentiality — counter-mode encryption

- **AES-XTS is rejected** for DRAM in favor of **counter-mode (AES-CTR) with a
  per-line counter**, because XTS is deterministic per address (same plaintext →
  same ciphertext at the same address), which is exactly the ciphertext-equality
  leak that **TEE.fail** and the SEV-SNP/TDX ciphertext side-channel work
  exploited. Counter-mode with a counter that increments on every write makes
  ciphertext non-deterministic across writes to the same address.
- Only pages whose MTT class is `private`/`measured`/`device-assigned` are
  encrypted; `free`/`shared` pages are plaintext (the host needs them). The MTT
  class is therefore an **input** to the MCIE, carried alongside the access.

### 3.2 Integrity + anti-replay — counter integrity tree

- A **counter-mode integrity tree** (Bonsai-Merkle-tree style: a MAC per data
  line keyed by the line counter, and a tree over the counters so the counters
  themselves cannot be rolled back) provides both tamper detection and
  **anti-replay**. Without the counter tree, an attacker who snapshots ciphertext
  +MAC can replay a stale (ciphertext, counter, MAC) triple; the tree binds the
  current counter so replay is detected at the root.
- The tree root is held in **on-die SRAM** (never in attacker-visible DRAM) and
  is reset to a fresh random value on every cold boot, which also makes
  cross-boot replay impossible without re-deriving the whole tree.
- A verification failure is **fatal**: it raises a machine-level alert to the RoT
  (lane 02) and triggers key-zeroization + `scrub-pending` on the domain. No
  soft-fail, no log-and-continue — fail closed.

### 3.3 Ciphertext-side-channel hardening (the TEE.fail lesson)

- Counter-mode (above) removes deterministic ciphertext.
- The MCIE must **not** expose any timing difference between a hit/miss in the
  integrity-tree counter cache that is observable to the untrusted world; the
  tree-cache is flushed/partitioned on world switch (the cache/TLB/BPU flush
  policy itself is owned by lane 04 — this lane only states the MCIE's counter
  cache is in scope for that policy).
- No performance counter or debug aperture may report MCIE counter values,
  tree-walk latency, or per-line MAC results to the untrusted world (PMU
  disablement is lane 04's mechanism; this lane registers the MCIE counters as
  must-be-hidden state).

## 4. Measured launch + attestation chain

This lane owns the **measurement chain shape and the `TeeEvidence` quote
composition**; it does **not** design the RoT, the DICE key ladder, or the
signing key — those are [`02-root-of-trust.md`](02-root-of-trust.md). The
handoff is precise: lane 02 delivers a DICE-derived attestation key and a
hardware measurement register (or a TSM-owned measurement context seeded by RoT);
this lane defines what gets measured, in what order, and how it serializes into
the `TeeEvidence` shape already named in the Confidential Domain Contract.

### 4.1 Measurement order (extend-only, RoT-rooted)

```
RoT ROM + lifecycle  ─(lane 02 provides this digest as the anchor)─┐
                                                                    ▼
TSM image digest ──▶ guest static measurement (kernel + initramfs + DTB + policy)
   ──▶ measured pages frozen (MTT measured→finalize, §2.2) ──▶ launch digest sealed
   ──▶ runtime extends: agent image, NPU firmware + queue policy (lane 03 supplies NPU fw digest)
```

- The TSM maintains a measurement context that is **extend-only** (each stage
  hashes-in the next; no stage can rewrite a prior measurement). The set of
  things measured is exactly the Confidential Domain Contract's attestation list
  — this lane does not re-enumerate it, it implements the chain that fills it.
- Launch finalization is the event that flips every `measured` page's
  launch-frozen bit (§2.2); after finalization any write to a `measured` page
  faults in `e1_mtt_checker.sv`.

### 4.2 `TeeEvidence` quote composition

The agent-side normalized shape is `TeeEvidence` (defined by the contract). This
lane's serializer (`scripts/tee/teeevidence_quote.py`) composes the launch
digest + runtime-extend digests + lifecycle/debug/rollback claims into that
shape, and lane 02's attestation key signs it. A synthetic fixture quote is
producible on a macOS/CI host today (it is structural, not cryptographic) and is
gated to **never** claim a real hardware root until lane 02's key ceremony and
RoT silicon evidence exist.

## 5. Concrete work items (new files only)

This lane creates only new files; it must not edit RTL/firmware/docs other lanes
may be touching. Each item lists a fail-closed gate in the existing
`scripts/check_*.py` + `build/reports/*.json` + `make` style, wired the same way
`security-lifecycle-scope-check` is.

| # | Deliverable (new file) | Kind | Effort | Risk | Gate (new `make` target) |
|---|---|---|---|---|---|
| W1 | `docs/spec-db/tee-core-target.yaml` | spec target + `forbidden_claims_until_evidence` | 0.25 pm | low | `tee-core-target-check` → `scripts/check_tee_core_target.py` |
| W2 | `scripts/tee/page_state_model.py` + `scripts/test_page_state_model.py` | pure-Python transition Mealy machine for §2.2 (the buildable-now proof) | 0.75 pm | low | `tee-page-state-model-check` |
| W3 | `rtl/security/e1_mtt_checker.sv` | per-access MTT walk + invariant enforcement (§2.2 hardware half) | 2.0 pm | high | `cocotb-mtt-checker` (new `verify/cocotb/security/test_mtt_checker.py`) + `rtl-check` |
| W4 | `rtl/security/e1_tsm_epmp_wall.sv` | Smepmp rule-locked region wall protecting TSM memory in M-mode (Dorami) | 1.0 pm | med | `cocotb-tsm-wall` |
| W5 | `rtl/memory/dram_ctrl/e1_mcie_model.sv` + `scripts/tee/integrity_tree_model.py` | counter-mode crypto + counter-integrity-tree model (§3), against the AXI-Lite stand-in | 2.5 pm | high | `tee-mcie-model-check` + `cocotb-mcie` |
| W6 | `scripts/tee/teeevidence_quote.py` + `scripts/test_teeevidence_quote.py` | measured-launch chain + `TeeEvidence` serializer (§4) | 0.75 pm | med | `tee-quote-check` |
| W7 | `docs/evidence/security/tee-core-evidence-gate.yaml` | fail-closed gate enumerating every BLOCKED real-hardware claim | 0.25 pm | low | consumed by `tee-core-scope-check` |
| W8 | `scripts/check_tee_core_scope.py` + `scripts/test_tee_core_scope.py` | aggregate scope gate (mirrors `check_security_lifecycle_scope.py`): keeps `release_claim_allowed: false`, asserts the MTT/MCIE/quote artifacts exist and remain non-production | 0.5 pm | low | `tee-core-scope-check`, added to `smoke` |

**Effort total ≈ 8 person-months** for the buildable subset (models + RTL
blocks + gates). Whole-OS confidential Linux boot, real MCIE-on-LPDDR5X, and lab
side-channel validation are BLOCKED beyond this on FPGA/silicon and on lanes 02/
03/04 landing.

**Gate wiring.** W8's `tee-core-scope-check` joins `make smoke` next to
`security-lifecycle-scope-check`; W3/W4/W5 cocotb targets join `make cocotb` /
`ci-fast` only once they pass under Verilator (fail-closed if Verilator absent,
exactly as `cocotb-soc-boot-smoke` does today). No target may report a passing
security claim — every report carries a `claim_boundary` string and
`release_claim_allowed: false` until the corresponding real transcript exists.

## 6. Phased Plan

**Phase 1 — secure-vault subset (buildable now, no whole-OS).** W1, W2, W7, W8.
A small `private` region protected by the Smepmp TSM wall (W4 RTL lands here
too) holds keys/credentials; the page-state model and quote serializer run on
CI. Proves the transition checker and `TeeEvidence` shape with synthetic
fixtures. Maps to the contract's "early prototypes may implement only the
secure-vault subset." Gate: `tee-core-scope-check` green, all claims still
release-blocked.

**Phase 2 — protected-agent subset (FPGA/sim).** W3 (`e1_mtt_checker.sv`) + W5
MCIE model land and pass cocotb against the stand-in DRAM; the agent runtime +
its model weights run as a `private`/`measured` domain while the rest of the OS
stays untrusted. NPU private-queue path depends on lane 03. Gate: cocotb
MTT/MCIE green under Verilator; real-DRAM and side-channel claims still BLOCKED.

**Phase 3 — whole-OS confidential domain (silicon target).** Full CoVE TSM,
H-extension two-stage + MTT for the entire elizaOS-Linux/AOSP guest, MCIE on the
real LPDDR5X controller, measured launch of kernel+initramfs+rootfs+agent+NPU
firmware, end-to-end `TeeEvidence` signed by the lane-02 DICE key. This is the
product goal. Every claim here is BLOCKED until: lane 02 RoT silicon + key
ceremony, lane 03 IOMMU/NPU isolation transcripts, lane 04 side-channel lab
validation, lane 05 perf headroom for crypto/MTT overhead, lane 06 a guest that
boots confidentially, and a real LPDDR5X controller. The
`tee-core-evidence-gate.yaml` enumerates each as a fail-closed blocked claim.

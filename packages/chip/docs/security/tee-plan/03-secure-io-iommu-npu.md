# 03 — Secure I/O: IOMMU / IOPMP, Device Assignment, and the NPU as Confidential I/O

Status: pre-silicon plan. Not implementation evidence. This document defines the
phased work required to make whole-OS confidential I/O real on the Eliza E1, with
the NPU treated as a measured, domain-owned secure-I/O block so on-device AI
inference (model weights + user prompts) stays private. Every claim here is
fail-closed: a milestone is `BLOCKED` until its named gate, RTL, and evidence
artifact exist.

This is the I/O-boundary half of the TEE plan. Read alongside:

- `01-tee-core-architecture.md` — confidential-domain monitor, page-state machine,
  measured launch/teardown, ePMP/Smepmp hart isolation.
- `02-root-of-trust.md` — OpenTitan-like RoT, DICE, OTP, key manager; the source of
  the device-attestation signing key and firmware measurement registers this plan
  consumes.
- `04-side-channel-physical-hardening.md` — PMU/counter virtualization and
  cross-domain flush; the no-perf-counter-leakage requirement here is enforced
  there.
- `05-cpu-memory-performance.md` — memory encryption/integrity and QoS partitioning
  that bound the cost of the IOMMU walks and bounce-buffer copies introduced here.

Authoritative contracts this plan extends, never forks:

- `docs/security/confidential-domain.md` — the I/O Rule and the canonical page
  states (`free`/`private`/`shared`/`measured`/`device-assigned`/`scrub-pending`).
- `docs/arch/iommu.md` + `rtl/iommu/e1_riscv_iommu.sv` + `e1_riscv_iommu_pkg.sv` —
  the RISC-V IOMMU v1.0.1 surface.
- `docs/arch/dma-buf-v2.md` — the DID map and the only supported buffer-sharing path.
- `docs/arch/npu.md`, `docs/arch/npu-microarch.md` — NPU command-queue ABI.
- `docs/arch/interrupts.md` — interrupt source IDs (AIA/IMSIC integration pending).

SOTA grounding (web-research baseline): RISC-V IOMMU v1.0.1 and the RISC-V IOPMP
spec; RISC-V AP-TEE-IO / CoVE-IO for in-trust-domain device assignment; Intel TDX
Connect (TEE-IO) and AMD SEV-SNP + TDISP as the assigned-vs-shared device-sharing
model; DMTF SPDM for device firmware measurement/attestation; NVIDIA H100/Blackwell
confidential-compute mode (encrypted+signed command buffers across the bus, perf
counters disabled in CC-On) as the accelerator-in-the-trust-domain comparator.

---

## 1. IOMMU / IOPMP gap analysis

### 1.1 What `e1_riscv_iommu.sv` does today

The current 693-line module is an honest **front-stub**, not a translating IOMMU.
Reading the RTL:

- **6 upstream AXI4 masters** front the fabric, each carrying out-of-band
  `aw_devid`/`ar_devid` (24-bit) and `aw_pasid`/`ar_pasid` (20-bit) side-channels.
- **DDTP=OFF/BARE → identity forward.** `d_awaddr <= u_awaddr` verbatim; the comment
  at line 359 is explicit that "G-stage IOVA→PA is a follow-on walker." There is
  **no page-table walk at all** — neither first-stage (Sv39/Sv48) nor G-stage.
- **Any translating DDTP mode** authorizes against a 6-entry **on-chip allowlist**
  (`allowed_dev[]`/`allowed_vld[]`), programmed through a non-architectural MMIO
  window at `0x800`. Unknown DID → `CAUSE_DDT_ENTRY_NOT_VALID` fault record +
  upstream behavior that *drops* the transaction (W data sunk, B/R never returned).
- **Fault queue** stages records on-chip (`fq_stage[]`) in the correct 32-byte
  spec layout but **never DMAs them to the FQB ring** — `reg_fqt` mirrors the stage
  pointer; the downstream AXI4 master is never used for FQ writes.
- **PRI / page-request queue** is MMIO-injection-only (`page_req_irq` is hardwired
  low in the `always_ff`; no upstream PRI request port).
- **Command queue** (`CQB`/`CQH`/`CQT`) registers exist but no command is decoded
  or executed — `IOTINVAL.*` / `IODIR.INVAL_*` are not implemented.
- **`cmd_complete_irq` is tied to 0.** MSI translation, MRIF, and `MSI_CFG_TBL`
  are advertised in `CAPABILITIES` (IGS=2) but not implemented.
- **No IOPMP.** There is no second, region-based access-control layer; the only
  gate is the DID allowlist, which is permission-blind (no R/W/X, no address-range
  scoping, no per-region revoke).

### 1.2 What whole-OS confidential I/O needs (and the gaps)

| Requirement (I/O Rule + CoVE-IO/TDISP model) | Today | Gap |
|---|---|---|
| Per-master stable source IDs for **every** DMA master: USB, eMMC/UFS, display planes, ISP/CSI, NPU DMA, GPU, video codec, network/Wi-Fi, debug transport | DID side-channel exists for 6 generic masters; DID map in `dma-buf-v2.md` | Lite-path masters (`e1_dma.sv`, `e1_npu.sv`) are AXI-Lite single-master MMIO with **no DID tagging** and bypass the IOMMU entirely. USB/UFS/ISP/Wi-Fi/codec masters are not wired to the 6 ports. |
| **Default-deny** translation (no transaction reaches DRAM without a valid, monitor-installed mapping) | BARE mode is identity-allow; translate mode allowlist is coarse | BARE must be **forbidden** for any domain that holds `private` pages; need a real PTW so default is "no mapping = fault." |
| **Monitor-programmed** permissions (only the confidential-domain monitor, not the host kernel, can grant a master access to `private`/`device-assigned` pages) | Allowlist is writable by whoever owns the MMIO aperture | Need an M-mode/monitor-only programming path + IOPMP locking so the host OS cannot self-authorize. |
| **Region-scoped R/W/X permissions** per source ID (IOPMP) | none | Need an IOPMP layer enforcing address-range + R/W/X per source ID, independent of and downstream-redundant to the IOMMU PTW. |
| Real **two-stage PTW** (S1 Sv39/Sv48 + G-stage Sv39x4/Sv48x4) with TLB | none | Core deliverable of Phase 1. |
| **Fault → revoke → scrub** on reset/error (a faulting or torn-down master loses access and its in-flight queue/scratch is zeroized) | fault recorded, transaction dropped; no revoke/scrub coupling | Need a hardware revoke port the monitor drives, plus a scrub engine handshake (ties to `scrub-pending` page state in `01-`). |
| **Secure MSI/IRQ translation** (MRIF) so a device cannot inject an interrupt into monitor/private state | IGS=2 advertised, not implemented | Phase 5. |

**Assessment.** The IOMMU is a verification scaffold that proves the register map,
fault-record layout, and an allowlist authorization shape. It is correct as far as
it goes and the evidence gate (`iommu-evidence-gate.yaml`) is honestly
`blocked_until_evidence`. But it provides **zero confidential-I/O guarantees**:
identity passthrough in BARE, no PTW, no IOPMP, no revoke/scrub, no MSI translation,
and the two highest-value masters (NPU, DMA) do not even traverse it. Whole-OS TEE
claims are fail-closed-blocked until Phases 1–5 land.

---

## 2. Assigned-vs-shared device model

The monitor classifies every DMA master into exactly one of three modes per domain
launch. This is the RISC-V CoVE-IO / TDX-Connect / TDISP distinction mapped onto our
page states from `confidential-domain.md`.

### 2.1 Assigned (measured, in-trust-domain)

A device whose firmware is measured (Section 3) and whose RTL enforces the secure-I/O
contract is **assigned** to the confidential domain:

- Monitor installs a device context (DC) in the DDT binding the master's **source ID**
  to the domain's G-stage page table, with `device-assigned` pages reachable and all
  `private` pages of *other* domains unreachable.
- Monitor programs IOPMP regions for that source ID (R/W/X scoped to the assigned
  buffers) and **locks** them so the host OS cannot widen them.
- The device may DMA directly into `device-assigned` pages — no bounce copy.
- Page-state transition `private → device-assigned` is legal **only** when the IOPMP
  policy for that source ID is installed first (enforced by the monitor's page-state
  machine in `01-`; illegal transitions listed there).
- On teardown/fault: monitor revokes the DC + IOPMP region, drains/quiesces the
  master, then transitions the buffers to `scrub-pending` until zeroized.

The NPU is the canonical assigned device (Section 4). USB/UFS/Wi-Fi/debug are
**never** assigned — they are untrusted and always mediated.

### 2.2 Shared / bounce-buffered (untrusted, mediated)

An untrusted or unmeasured device only ever touches `shared` pages:

- The domain places I/O payload in a `shared` bounce buffer (host-visible, never
  `private`). The device DMAs to/from the `shared` buffer; the domain copies across
  the private↔shared boundary under monitor mediation, applying any required
  encryption (e.g. block-device data is encrypted by the domain before it lands in
  the `shared` UFS buffer).
- The IOMMU DC for the untrusted source ID maps **only** `shared` pages; an attempt
  to reach `private` raises `CAUSE_DDT_ENTRY_NOT_VALID`/permission fault with the
  master's DID — exactly the negative test already shaped in `dma-buf-v2.md`.
- This is the default for USB, eMMC/UFS, network/Wi-Fi, and any closed-BSP device.

### 2.3 Page-state interaction (canonical, owned by `01-`)

| Master class | Reaches `private`? | Reaches `device-assigned`? | Reaches `shared`? | Mechanism |
|---|---|---|---|---|
| Assigned, measured (NPU, optionally display for protected scanout) | no (only its own assigned subset) | yes | yes | DC + locked IOPMP |
| Untrusted (USB, UFS, Wi-Fi, debug) | no | no | yes | DC maps shared-only; bounce buffers |
| Host kernel DMA outside any domain | no | no | yes (its own) | default-deny into all domain pages |

This document does not own the page-state FSM (that is `01-`); it owns the
**source-ID-to-page-state enforcement** in the IOMMU/IOPMP and the bounce-buffer
mediation contract.

---

## 3. Device measurement / attestation before assignment

No device is assigned until measured. The flow is SPDM-like and feeds the same
`TeeEvidence` quote shape named in `confidential-domain.md` and produced by the RoT
in `02-`.

### 3.1 Measurement flow (SPDM / AP-TEE-IO shaped)

1. **Reset isolation.** On domain launch the monitor holds the candidate device in
   reset / quiesced with its IOMMU DC absent (default-deny) and IOPMP regions zero.
2. **Firmware measurement.** The device's loadable firmware (NPU firmware blob,
   ISP firmware, display controller microcode) is hashed by the RoT measurement
   engine (`02-`) into a dedicated measurement register before the device is
   released from reset. Mask-ROM/ROM-resident device logic contributes a static
   digest published in the release manifest.
3. **Attestation challenge.** The monitor issues an SPDM-style
   `GET_MEASUREMENTS` to the device's responder (a small measured agent in the
   device firmware) with a monitor nonce; the device returns measurement blocks
   signed by a key chained to the RoT device-identity key (DICE layer from `02-`).
   For fully on-die blocks (NPU, ISP) the "responder" is the RoT itself attesting
   the firmware it just measured — there is no untrusted bus in between.
4. **Policy check.** Monitor compares the measurement against the
   domain's allowed-device policy (a signed manifest). Match → device eligible for
   assignment; mismatch → device stays untrusted/mediated (Section 2.2) or the
   launch fails closed.
5. **Quote inclusion.** The accepted device firmware digest + queue-policy digest is
   folded into the domain attestation quote (`confidential-domain.md` already lists
   "NPU firmware and queue policy digest when private inference is enabled").

### 3.2 What feeds the attestation quote

- RoT-measured device firmware digest(s) (NPU, ISP, display ucode as applicable).
- IOMMU DC + IOPMP policy digest installed for each assigned source ID (so the quote
  binds *which* device got *which* access).
- NPU command-queue ownership policy digest (private vs shared queue config).
- Device reset/lifecycle state (debug-locked, production) from `02-`.

For the E1's all-on-die accelerators there is no PCIe/CXL link, so we do **not**
need the full IDE/TDISP link-encryption machinery; the comparator simplification vs
H100/TDX Connect is that measurement is RoT-local. Section 4.4 covers the one case
(NPU across an interconnect boundary) where link confidentiality does apply.

---

## 4. NPU as secure I/O — the headline feature

This is what makes "confidential on-device AI inference" real: model weights and user
prompts/activations must be unreadable by the host OS, other domains, debug, and any
unassigned master.

### 4.1 Today's NPU is not secure I/O

`rtl/npu/e1_npu.sv` (and the Gemmini-wrapper path in `npu-microarch.md`) is an
**AXI-Lite single-master MMIO** block: it fetches descriptors and tensor data from
DRAM over `m_axil_*` with **no source-ID tagging and no IOMMU traversal**. The
command queue, `DESC_BASE`, and `TENSOR_MEM` are programmed through plain MMIO with
no notion of domain ownership. `PERF_CYCLES`/`PERF_MACS`/`PERF_FALLBACKS` counters
are world-readable. As-is, any master that can reach the NPU MMIO window can read its
descriptors and the host can observe inference timing/MAC counts.

### 4.2 Required NPU secure-I/O properties

1. **Measured NPU firmware** (Section 3) before the NPU is released to a domain.
2. **Private command queue ownership.** The NPU descriptor ring + doorbell +
   `TENSOR_MEM` window are bound to a single owning domain at a time. A second domain
   (or the host) attempting to ring the doorbell or read `DESC_*`/`STATUS` while the
   NPU is owned-private is denied. Queue ownership is monitor-programmed and part of
   the attested queue-policy digest.
3. **DMA isolation through the IOMMU.** All NPU DRAM traffic (descriptor fetch,
   A/B/C tensor reads/writes, scratch staging) must carry the NPU source ID and
   traverse the IOMMU + IOPMP, so weights/activations live in `device-assigned`
   `private` pages unreachable by anyone else. This requires re-homing the NPU master
   from the lite AXI-Lite path onto an IOMMU upstream port (a hard RTL item, 6.x).
4. **Encrypted weight/activation traffic across interconnect boundaries** (4.4).
5. **No performance-counter leakage.** When the NPU is owned-private, `PERF_*`
   counters and any timing-observable status must be virtualized/zeroized to the
   host (enforcement detailed in `04-`); the monitor reads them, the host does not.

### 4.3 Ownership state machine (NPU)

`unowned → measuring → assigned(domainX) → draining → scrubbing → unowned`. Doorbell
writes, descriptor fetch, and `TENSOR_MEM` access are gated by the current owner.
`draining` quiesces in-flight descriptors (the existing `BARRIER` op + `STATUS.busy`
give a clean drain point); `scrubbing` zeroizes scratch + descriptor ring before the
NPU can be reassigned — directly implementing the I/O Rule's "reset and error paths
revoke access and scrub queues."

### 4.4 Across-interconnect confidentiality (conditional)

If the NPU sits behind a fabric boundary the monitor does not physically trust (e.g.
a chiplet/NoC hop or a future external accelerator), command buffers and
weight/activation traffic must be **encrypted + integrity-protected on the wire**,
mirroring H100 CC-On signed/encrypted command buffers. For the v0 all-on-die Gemmini
this is **BLOCKED / not-required** and recorded as such; the gate exists so the claim
is fail-closed if topology changes. Inline memory encryption for the tensor pages
themselves is owned by `05-`.

---

## 5. Secure interrupt routing

A device must not be able to inject an interrupt that lands in monitor/private state
or that the host can use to observe private activity.

Current state: `docs/arch/interrupts.md` is a 4-source PLIC-style stub
(`irq_timer/dma/npu/vsync`); the IOMMU advertises MSI translation (IGS=2) but does
not implement MRIF/`MSI_CFG_TBL`. There is no AIA/IMSIC.

Plan:

1. **MSI translation in the IOMMU.** Implement the MSI page-table / MRIF path so a
   device-issued MSI write is translated against the owning domain's IMSIC interrupt
   file — a device can only target interrupt identities its DC permits
   (`CAUSE_MSI_PTE_NOT_VALID`/`MISCONFIGURED` on violation; causes already in the
   pkg).
2. **AIA/IMSIC integration.** Per-hart IMSIC interrupt files with an M-mode
   (monitor) file that the host/S-mode cannot address. Untrusted-device MSIs are only
   ever routable to the host's interrupt file, never the monitor's.
3. **NPU completion IRQ ownership.** When the NPU is owned-private, its completion
   interrupt routes to the owning domain's IMSIC file; the host sees no NPU IRQ and
   cannot use IRQ timing as a side channel (ties to `04-`).
4. **Source-ID-stable mapping.** Preserve the stable source IDs in `interrupts.md`
   as PLIC→IMSIC migration lands, so the attested interrupt policy is durable.

---

## 6. Work items — RTL/firmware, effort, risk, gates

All new files; this lane does **not** edit existing RTL/docs (swarm rule). New RTL is
wired by the integration owner once landed. Effort in person-months (PM).

### Phase 1 — Real translation + IOPMP (foundation)

| ID | New file(s) | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| P1.1 | `rtl/iommu/e1_iommu_ptw.sv` | Two-stage page-table walker (S1 Sv39/Sv48 + G-stage Sv39x4/Sv48x4) over the downstream AXI4 master, with a small TLB; replaces identity passthrough. | 3.0 | High | extend `cocotb-iommu` (`two_stage_translation_via_3lvl_ddt`), `iommu-evidence-check` |
| P1.2 | `rtl/iommu/e1_iommu_ddt_pdt_walker.sv` | Memory-resident DDT (1/2/3-level) + PDT walk replacing the on-chip allowlist; monitor-only DDTP programming. | 2.0 | High | `cocotb-iommu`, `iommu-evidence-check` |
| P1.3 | `rtl/iommu/e1_iopmp.sv` + `e1_iopmp_pkg.sv` | RISC-V IOPMP: per-source-ID region table with R/W/X, lockable entries, default-deny; sits downstream of the IOMMU as redundant region enforcement. | 2.5 | High | new `cocotb-iopmp` + `iopmp-evidence-check` (model on iommu gate) |
| P1.4 | `rtl/iommu/e1_iommu_cmd_engine.sv` | Command-queue execution: `IOTINVAL.VMA/GVMA`, `IODIR.INVAL_DDT/PDT`; drive `cmd_complete_irq` (today tied 0). | 1.0 | Med | `cocotb-iommu` |
| P1.5 | `rtl/iommu/e1_iommu_fq_dma.sv` | DMA staged fault records to the FQB ring over the downstream master (today FQ never reaches DRAM). | 0.5 | Med | `cocotb-iommu` |

### Phase 2 — Source-ID coverage + revoke/scrub

| ID | New file(s) | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| P2.1 | `rtl/iommu/e1_master_sourceid_tag.sv` | Source-ID tagging shim for every DMA master (USB, UFS/eMMC, ISP/CSI, GPU, codec, Wi-Fi, debug) onto the IOMMU upstream ports; binds each to its `dma-buf-v2.md` DID. | 1.5 | Med | new `cocotb-iommu-sourceid` |
| P2.2 | `rtl/iommu/e1_iommu_revoke_scrub.sv` | Monitor-driven revoke port + scrub-engine handshake; revoking a source ID quiesces it and marks its pages `scrub-pending`. | 1.5 | High | new `cocotb-iommu-revoke` + extend `confidential-domain` evidence |
| P2.3 | `docs/evidence/security/secure-io-evidence-gate.yaml` | Fail-closed gate (modeled on `iommu-evidence-gate.yaml`) enumerating required tests/artifacts for assigned-vs-shared, revoke/scrub, NPU isolation. | 0.5 | Low | new `secure-io-evidence-check` |

### Phase 3 — Device measurement / attestation

| ID | New file(s) | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| P3.1 | `rtl/security/e1_device_attest.sv` | SPDM-shaped responder + RoT measurement hook; emits device firmware digest into a measurement register (`02-` RoT). | 2.0 | High | new `cocotb-device-attest` |
| P3.2 | `fw/monitor/device_assignment.c` (+ header) | Monitor logic: measure → policy-check → install DC+IOPMP → assign; fail-closed to mediated on mismatch. | 1.5 | Med | extend `secure-io-evidence-check` |
| P3.3 | `compiler/runtime/bounce_buffer_mediation.py` | Reference model + sim contract for private↔shared bounce-buffer mediation (untrusted-device path). | 1.0 | Low | new `secure-io-bounce-sim-check` |

### Phase 4 — NPU as secure I/O

| ID | New file(s) | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| P4.1 | `rtl/npu/e1_npu_secure_io.sv` | Re-home NPU DRAM traffic onto an IOMMU upstream port with the NPU source ID (off the lite AXI-Lite path); descriptor/tensor fetch now traverses IOMMU+IOPMP. | 2.5 | High | new `cocotb-npu-secure-io` |
| P4.2 | `rtl/npu/e1_npu_queue_owner.sv` | Private command-queue ownership FSM (Section 4.3): doorbell/`DESC_*`/`TENSOR_MEM` gated by current owner; drain via `BARRIER`; scrub on teardown. | 2.0 | High | `cocotb-npu-secure-io` |
| P4.3 | `rtl/npu/e1_npu_counter_guard.sv` | Gate `PERF_*` + timing-observable status to monitor-only when owned-private (no host-side counter leakage). | 0.5 | Med | `cocotb-npu-secure-io` + cross-ref `04-` |
| P4.4 | `docs/security/tee-plan/npu-link-crypto.md` (BLOCKED note) | Records across-interconnect encrypt+sign requirement as fail-closed; not required for v0 on-die Gemmini. | 0.25 | Low | `secure-io-evidence-check` (blocked entry) |

### Phase 5 — Secure interrupt routing

| ID | New file(s) | Work | PM | Risk | Gate |
|---|---|---|---|---|---|
| P5.1 | `rtl/iommu/e1_iommu_msi_xlate.sv` | MSI translation + MRIF path + `MSI_CFG_TBL` (IGS=2 already advertised); per-DC MSI permission. | 2.0 | High | `cocotb-iommu` (MSI cases) |
| P5.2 | `rtl/interrupts/e1_imsic.sv` | Per-hart IMSIC files incl. monitor-only M-mode file; untrusted-device MSIs routable only to host file. | 2.5 | High | new `cocotb-imsic` |

**Totals:** ~17 RTL PM + ~4.5 firmware/model PM. Critical path: P1.1/P1.2/P1.3
(translation+IOPMP) → P4.1/P4.2 (NPU isolation) → P5 (secure IRQ). Phases 2–5 are
each fail-closed-blocked behind their own gate; nothing promotes a confidential-I/O
claim until its `*-evidence-check` clears the same way `iommu-evidence-check` does
today.

### Sequencing vs siblings

- Needs from `02-`: RoT measurement register + DICE device-identity key (P3.1).
- Needs from `01-`: page-state FSM + monitor-only programming privilege (P1.2, P2.2).
- Feeds `04-`: counter virtualization enforcement consumes P4.3's monitor-only gate.
- Feeds `05-`: tensor-page memory encryption complements P4.1 DMA isolation.

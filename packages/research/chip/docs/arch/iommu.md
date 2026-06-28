# RISC-V IOMMU v1.0.1 contract

The Eliza phone-class SoC carries a partial [ratified RISC-V IOMMU v1.0.1
specification][spec] implementation. The current RTL covers the register and
fault surface, BARE/identity behavior, IOFENCE.C fetch/decode, an allowlist
fallback, and a local DDT + Sv39 first-stage read walk under an identity
G-stage context. It is not yet complete per-device DMA isolation for the NPU
command queue, GPU contexts, DMA channels, display planes, camera ISP pipelines,
Linux, or phone-class claims. The implementation lives in `rtl/iommu/` and is
verified by cocotb tests under `verify/cocotb/iommu/`.

[spec]: https://docs.riscv.org/reference/hardware/iommu/v20240911/_attachments/riscv-iommu.pdf

## Scope

The IOMMU sits between bus masters and the AXI4 system fabric (see
`docs/arch/interconnect.md` and `rtl/interconnect/axi4/`). It owns:

| Concern | Owner |
|---|---|
| Per-device translation (DDT walk) | IOMMU; local minimal DDT KAT only |
| Per-process translation (PDT walk, PASID) | IOMMU; still blocked for full PDT/PASID evidence |
| Two-stage translation (Sv39 + G-stage / Sv48 + G-stage) | IOMMU; only S1 Sv39 under identity G-stage is locally covered |
| Fault recording into a memory-resident ring | IOMMU; staged fault records exist, FQ DMA remains blocked |
| Page-request interface for SVA | IOMMU; still blocked |
| ATS request/response with PCIe-style devices | IOMMU; still blocked |
| Snoop coherency | Cache agent (separate domain) |
| QoS arbitration | AXI4 interconnect + DRAM controller |
| Boot-time enable / Linux device-tree binding | Software |

## Feature subset

The 2028 target requires the v1.0.1 mandatory feature set plus the optional
features required by the upstream Linux RISC-V IOMMU driver (merged for v6.10+).
Current local RTL evidence is narrower:

| Feature | Status | Notes |
|---|---|---|
| Sv39 first-stage | partial local evidence | DDT + Sv39 read walk KAT under identity G-stage |
| Sv48 first-stage | required target | not yet locally covered |
| Sv57 first-stage | optional target | advertised in CAPABILITIES, not locally covered |
| Sv39x4 G-stage | required target | not yet locally covered beyond identity G-stage context |
| Sv48x4 G-stage | required target | not yet locally covered |
| PASID (PD20, 20-bit) | required target | fields exist; full PDT/PASID behavior remains blocked |
| ATS | required target | PCIe-style devices using `disco`/peripheral RC; blocked |
| PRI / page-request interface | required target | enables shared virtual memory; blocked |
| MSI translation (IGS=2) | required target | matches Linux v6.x driver; blocked |
| T2GPA | optional target | translates GPA into HPA on ATS; blocked |
| DDT 1-level / 2-level / 3-level walk | required target | local KAT covers a minimal DDT path only |

## Register map

The IOMMU exposes a 4 KiB MMIO aperture beginning at `iommu_base`
(defined by the device tree node). Register offsets follow the v1.0.1
spec exactly:

| Offset | Name | Width | Description |
|---:|---|---:|---|
| `0x000` | `CAPABILITIES` | 64 | Feature advertisement; read-only |
| `0x008` | `FCTL`         | 32 | Global control: WSI/BE/GXL bits |
| `0x010` | `DDTP`         | 64 | Device-directory pointer + mode |
| `0x018` | `CQB`          | 64 | Command-queue base + log size |
| `0x020` | `CQH`          | 32 | CQ head (IOMMU-updated) |
| `0x024` | `CQT`          | 32 | CQ tail (driver-updated) |
| `0x028` | `FQB`          | 64 | Fault-queue base + log size |
| `0x030` | `FQH`          | 32 | FQ head (driver-updated) |
| `0x034` | `FQT`          | 32 | FQ tail (IOMMU-updated) |
| `0x038` | `PQB`          | 64 | Page-request-queue base |
| `0x040` | `PQH`          | 32 | PQ head |
| `0x044` | `PQT`          | 32 | PQ tail |
| `0x048` | `CQCSR`        | 32 | CQ control/status |
| `0x04C` | `FQCSR`        | 32 | FQ control/status |
| `0x050` | `PQCSR`        | 32 | PQ control/status |
| `0x054` | `IPSR`         | 32 | Interrupt pending status (W1C) |
| `0x258` | `TR_REQ_IOVA`  | 64 | Debug-translation request IOVA |
| `0x260` | `TR_REQ_CTL`   | 64 | Debug-translation request control |
| `0x268` | `TR_RESPONSE`  | 64 | Debug-translation response |
| `0x2F8` | `ICVEC`        | 64 | Interrupt-cause vector configuration |
| `0x300` | `MSI_CFG_TBL`  | … | MSI configuration table base |

The implementation also exposes a non-architectural simple device-id
allowlist beginning at offset `0x800` for early bring-up verification.
This range is reserved for upstream Linux compatibility (no real driver
uses it) and is replaced when the full DDT walker lands.

## Fault record format

Each fault queue entry is 32 bytes laid out as four 64-bit words:

| Word | Bits | Field |
|---:|---|---|
| 0 | `[11:0]` | CAUSE (page-fault, permission, DDT-walk, …) |
| 0 | `[17:12]` | TTYP (transaction type) |
| 0 | `[18]` | PRIV |
| 0 | `[20]` | PV (PASID valid) |
| 0 | `[40:21]` | PID (PASID) |
| 0 | `[63:41]` | DID (24-bit, low 23 bits here; spec carries the rest in word 1) |
| 1 | `[3:0]` | iotval-present flags |
| 1 | `[63:4]` | reserved |
| 2 | `[63:0]` | iotval (IOVA or fault address) |
| 3 | `[63:0]` | iotval2 (guest-physical address for G-stage faults) |

CAUSE encodings used most frequently in verification:

| Value | Mnemonic | Meaning |
|---:|---|---|
| 1 | `INSN_ACCESS_FAULT` | instruction fetch access fault |
| 5 | `LOAD_ACCESS_FAULT` | data read access fault |
| 7 | `STORE_ACCESS_FAULT` | data write access fault |
| 12 | `INSN_PAGE_FAULT` | first-stage instruction page fault |
| 13 | `LOAD_PAGE_FAULT` | first-stage load page fault |
| 15 | `STORE_PAGE_FAULT` | first-stage store page fault |
| 21 | `LOAD_GUEST_PAGE_FAULT` | G-stage load fault |
| 23 | `STORE_GUEST_PAGE_FAULT` | G-stage store fault |
| 256 | `ALL_INBOUND_DISALLOWED` | IOMMU is OFF and rejected the request |
| 258 | `DDT_ENTRY_NOT_VALID` | translation requested without a valid DC |
| 259 | `DDT_ENTRY_MISCONFIGURED` | DC field combination invalid |
| 260 | `TRANSACTION_TYPE_DISALLOWED` | DC blocks this TTYP |

TTYP encodings used in verification:

| Value | Meaning |
|---:|---|
| 1 | untranslated read (data) |
| 2 | untranslated write or AMO |
| 3 | untranslated read for instruction fetch |
| 4 | translated read |
| 5 | translated write or AMO |
| 6 | translated read for instruction fetch |
| 7 | PCIe ATS translation request |
| 8 | PCIe message request |
| 9 | page request from device |

## ATS support

`CAPABILITIES.ATS` is currently part of the advertised target surface, but
end-to-end ATS request/completion behavior is still blocked. The local RTL
evidence does not yet prove PCIe-style devices can issue ATS translation
requests, receive completions, cache translations, or revoke those translations
on teardown/reset. Those claims remain gated by
`docs/evidence/memory/iommu-evidence-gate.yaml`.

## Page-request interface (PRI)

PRI is a target requirement, not a completed local behavior. The register
surface and MMIO plumbing exist, but the current evidence does not prove that a
device fault emits a page-request record into `PQB`/`PQT` or that Linux can
resolve the fault and invalidate the IOMMU TLB. The verified subset keeps these
claims blocked until transaction-level PRI tests and Linux transcripts exist.

## Kernel-driver expectations

Linux requires the following bindings (kernel v6.10+):

* Device-tree node `iommu@<base>` with compatible `riscv,iommu` and the
  base/size pair.
* `riscv,fcfg` property listing the optional features the IOMMU
  advertises so that the driver does not poll for unsupported bits.
* Per-master `iommus = <&iommu, did>` references that bind a bus master
  to a device-id (DID) and allow the kernel to manage its DC.
* MSI-fixed `interrupts` property; the IOMMU drives a wired interrupt
  when `FCTL.WSI` is set or routes via the IMSIC otherwise.

The Android dma-buf v2 mapping ABI (see `docs/arch/dma-buf-v2.md`)
relies on `iommu_attach_device` and `iommu_map_sgtable` with the same
DID. Closed BSPs that map dma-bufs without going through `iommu_map`
fail closed against unauthorized-IOVA tests.

## Verification surface

| Test | Location | Coverage |
|---|---|---|
| `test_riscv_iommu.py::capabilities_register_advertises_v1_features` | `verify/cocotb/iommu/` | CAPABILITIES register bits |
| `test_riscv_iommu.py::bare_mode_passes_traffic_with_no_fault` | `verify/cocotb/iommu/` | DDTP=BARE identity passthrough |
| `test_riscv_iommu.py::translate_mode_blocks_unknown_devid_with_fault` | `verify/cocotb/iommu/` | unauthorized devid raises CAUSE 258 |
| `test_riscv_iommu.py::translate_mode_allows_known_devid` | `verify/cocotb/iommu/` | authorized devid completes |
| `test_riscv_iommu.py::pasid_isolation_via_allowlist_revoke` | `verify/cocotb/iommu/` | revoking a DID re-faults |

Reference-model tracking: the pinned [`riscv-non-isa/riscv-iommu`][refmodel]
revision is recorded in
`verify/cocotb/iommu/refmodel/riscv-iommu.manifest.yaml`. The current gate checks
that manifest pin and the local cocotb evidence; it does not yet run a live
cross-check against the upstream reference model.

[refmodel]: https://github.com/riscv-non-isa/riscv-iommu

## Evidence gate

The fail-closed evidence gate for this block is
`docs/evidence/memory/iommu-evidence-gate.yaml`. Promoting any phone-class
IOMMU claim requires:

1. Passing every required cocotb test enforced by `scripts/check_iommu_evidence.py`.
2. The tracked reference-model manifest at
   `verify/cocotb/iommu/refmodel/riscv-iommu.manifest.yaml`.
3. No stale blocked or contradiction artifacts under
   `docs/evidence/memory/` for the IOMMU subset.
4. ATS round-trip evidence with a Linux
   v6.10+ kernel boot transcript.
5. PASID-context-switch evidence proving that two simultaneously
   active masters with different PASIDs see isolated translations.

The gate also blocks tapeout-readiness claims until every entry under
`docs/evidence/memory/uma-dram-evidence-gate.yaml::blocked_real_claims`
has cleared.

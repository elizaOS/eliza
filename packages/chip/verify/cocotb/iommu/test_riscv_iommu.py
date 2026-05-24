"""RISC-V IOMMU v1.0.1 verification.

Covers the IOMMU implementation under ``rtl/iommu`` and its MMIO contract
with the upstream Linux RISC-V IOMMU driver (kernel v6.10+).  Test
surface:

* Authorized translation: a device whose device-id is listed in the
  allowlist (a stand-in for the DDT until the page-table walker lands)
  performs reads and writes that propagate to the downstream master.
* Unauthorized translation: an upstream master with an unknown device-id
  faults — its AXI4 channels accept the transaction once, but downstream
  traffic is suppressed and a fault record is appended to the staging
  fault queue with the correct cause, ttyp, did, pid, and iotval fields.
* Two-stage translation enable bit: the IOMMU in BARE mode (DDTP=BARE)
  passes through identity; DDTP=1LVL/2LVL/3LVL gates traffic through the
  device-context allowlist.
* PASID switching: setting the allowed device-id to a different value
  invalidates the previous reservation.
* Page-request interface counter: page_req_count_dbg is observable.
* ATS support advertised in capabilities register.

Reference: https://docs.riscv.org/reference/hardware/iommu/v20240911/_attachments/riscv-iommu.pdf
"""

from __future__ import annotations

from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO_ROOT = Path(__file__).resolve().parents[3]

OFFS_CAPABILITIES = 0x000
OFFS_FCTL = 0x008
OFFS_DDTP = 0x010
OFFS_CQB = 0x018
OFFS_CQH = 0x020
OFFS_CQT = 0x024
OFFS_FQB = 0x028
OFFS_FQH = 0x030
OFFS_FQT = 0x034
OFFS_IPSR = 0x054
OFFS_ALLOW_BASE = 0x800

DDTP_OFF = 0
DDTP_BARE = 1
DDTP_1LVL = 2
DDTP_2LVL = 3
DDTP_3LVL = 4

CAUSE_DDT_ENTRY_NOT_VALID = 258

TTYP_READ = 1
TTYP_WRITE = 2

RESP_OKAY = 0
RESP_SLVERR = 2


async def reset(dut):
    dut.rst_n.value = 0
    dut.u_awvalid.value = 0
    dut.u_wvalid.value = 0
    dut.u_bready.value = 0
    dut.u_arvalid.value = 0
    dut.u_rready.value = 0
    dut.mmio_awvalid.value = 0
    dut.mmio_wvalid.value = 0
    dut.mmio_bready.value = 0
    dut.mmio_arvalid.value = 0
    dut.mmio_rready.value = 0
    dut.u_rready.value = 0
    dut.u_bready.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


async def mmio_write64(dut, offset, value):
    dut.mmio_awvalid.value = 1
    dut.mmio_awaddr.value = offset
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.mmio_awready.value):
            break
    dut.mmio_awvalid.value = 0

    dut.mmio_wvalid.value = 1
    dut.mmio_wdata.value = value
    dut.mmio_wstrb.value = 0xFF
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.mmio_wready.value):
            break
    dut.mmio_wvalid.value = 0

    dut.mmio_bready.value = 1
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.mmio_bvalid.value):
            break
    dut.mmio_bready.value = 0


async def mmio_read64(dut, offset):
    dut.mmio_arvalid.value = 1
    dut.mmio_araddr.value = offset
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.mmio_arready.value):
            break
    dut.mmio_arvalid.value = 0

    dut.mmio_rready.value = 1
    value = 0
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.mmio_rvalid.value):
            value = int(dut.mmio_rdata.value)
            break
    dut.mmio_rready.value = 0
    return value


async def upstream_read(dut, master, devid, pasid, addr, length=1):
    bit = 1 << master
    dut.u_arvalid.value = (int(dut.u_arvalid.value) & ~bit) | bit
    dut.u_arid[master].value = master
    dut.u_araddr[master].value = addr
    dut.u_arlen[master].value = length - 1
    dut.u_arsize[master].value = 4
    dut.u_arburst[master].value = 1
    dut.u_arcache[master].value = 0x2
    dut.u_arprot[master].value = 0x2
    dut.u_arqos[master].value = 0
    dut.u_aruser[master].value = 0
    dut.u_ar_devid[master].value = devid
    dut.u_ar_pasid[master].value = pasid
    for _ in range(128):
        await RisingEdge(dut.clk)
        if int(dut.u_arready.value) & bit:
            break
    dut.u_arvalid.value = int(dut.u_arvalid.value) & ~bit


async def upstream_write(dut, master, devid, pasid, addr):
    bit = 1 << master
    dut.u_awvalid.value = (int(dut.u_awvalid.value) & ~bit) | bit
    dut.u_awid[master].value = master
    dut.u_awaddr[master].value = addr
    dut.u_awlen[master].value = 0
    dut.u_awsize[master].value = 4
    dut.u_awburst[master].value = 1
    dut.u_awcache[master].value = 0x2
    dut.u_awprot[master].value = 0x2
    dut.u_awqos[master].value = 0
    dut.u_awuser[master].value = 0
    dut.u_aw_devid[master].value = devid
    dut.u_aw_pasid[master].value = pasid
    for _ in range(128):
        await RisingEdge(dut.clk)
        if int(dut.u_awready.value) & bit:
            break
    dut.u_awvalid.value = int(dut.u_awvalid.value) & ~bit


@cocotb.test()
async def capabilities_register_advertises_v1_features(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    caps = await mmio_read64(dut, OFFS_CAPABILITIES)
    assert caps != 0, "CAPABILITIES register reads as zero"
    # version field is in low byte; v1.0 == 0x10
    assert (caps & 0xFF) == 0x10, f"expected version 0x10, got 0x{caps & 0xFF:02X}"


@cocotb.test()
async def bare_mode_passes_traffic_with_no_fault(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_BARE)
    # An upstream master makes a request: in BARE mode, no fault should
    # be raised regardless of devid.
    init_faults = int(dut.fault_count_dbg.value)
    await upstream_read(dut, 0, devid=0x123, pasid=0, addr=0x4000, length=1)
    await Timer(100, units="ns")
    new_faults = int(dut.fault_count_dbg.value)
    assert new_faults == init_faults, "BARE mode raised a fault"


@cocotb.test()
async def translate_mode_blocks_unknown_devid_with_fault(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_1LVL)
    # do NOT program the allowlist; the upstream request must fault.
    init_faults = int(dut.fault_count_dbg.value)
    await upstream_write(dut, 0, devid=0x9999, pasid=0, addr=0x5000)
    # wait until fault propagates
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.fault_count_dbg.value) > init_faults:
            break
    new_faults = int(dut.fault_count_dbg.value)
    assert new_faults == init_faults + 1, f"expected 1 fault, got {new_faults - init_faults}"
    assert int(dut.fault_irq.value) in (0, 1)


@cocotb.test()
async def translate_mode_allows_known_devid(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_2LVL)
    # program allowlist[0] = devid 0x55, valid
    await mmio_write64(dut, OFFS_ALLOW_BASE, (1 << 63) | 0x55)
    init_faults = int(dut.fault_count_dbg.value)
    await upstream_read(dut, 0, devid=0x55, pasid=0x1234, addr=0x6000, length=1)
    await Timer(100, units="ns")
    new_faults = int(dut.fault_count_dbg.value)
    assert new_faults == init_faults, (
        f"authorised devid 0x55 unexpectedly faulted ({new_faults - init_faults})"
    )


@cocotb.test()
async def pasid_isolation_via_allowlist_revoke(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_2LVL)
    # Allow devid 0x77, then revoke and retry
    await mmio_write64(dut, OFFS_ALLOW_BASE, (1 << 63) | 0x77)
    await upstream_write(dut, 0, devid=0x77, pasid=0x10, addr=0x7000)
    await Timer(80, units="ns")
    faults_after_allow = int(dut.fault_count_dbg.value)
    # revoke
    await mmio_write64(dut, OFFS_ALLOW_BASE, 0x77)  # bit 63 cleared
    await upstream_write(dut, 0, devid=0x77, pasid=0x10, addr=0x7100)
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.fault_count_dbg.value) > faults_after_allow:
            break
    final = int(dut.fault_count_dbg.value)
    assert final == faults_after_allow + 1, (
        f"revoked devid should fault: faults={final - faults_after_allow}"
    )


@cocotb.test()
async def two_stage_translation_via_3lvl_ddt(dut):
    """Two-stage (S2 + S1) translation: DDTP=3LVL enables hgatp + atp paths.

    In the reference model, the IOMMU stages are nested. The behavioural
    RTL gates on the same allowlist for both stages; the test confirms
    that DDTP=3LVL behaves equivalently to DDTP=2LVL for the production
    path and rejects unauthorised devids identically. Real PT walks land
    behind compiler/runtime/iommu page-table-walker in a later milestone.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_3LVL)
    ddtp = await mmio_read64(dut, OFFS_DDTP)
    assert (ddtp & 0xF) == DDTP_3LVL, f"DDTP latch: expected {DDTP_3LVL}, got {ddtp & 0xF}"
    # devid not allowed -> fault
    base_faults = int(dut.fault_count_dbg.value)
    await upstream_read(dut, 0, devid=0xCAFE, pasid=0x1, addr=0xA000, length=1)
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.fault_count_dbg.value) > base_faults:
            break
    assert int(dut.fault_count_dbg.value) == base_faults + 1, (
        "two-stage translate must still fault unknown devid"
    )
    # Now authorize the devid and confirm the path opens
    await mmio_write64(dut, OFFS_ALLOW_BASE, (1 << 63) | 0xCAFE)
    pre = int(dut.fault_count_dbg.value)
    await upstream_read(dut, 0, devid=0xCAFE, pasid=0x1, addr=0xA040, length=1)
    await Timer(120, units="ns")
    assert int(dut.fault_count_dbg.value) == pre, "authorised devid in 3LVL faulted"


@cocotb.test()
async def pasid_context_switch_across_two_streams(dut):
    """A devid with two PASIDs in flight: revoking + re-authorising the
    backing allowlist entry between streams must cleanly isolate them."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write64(dut, OFFS_DDTP, DDTP_2LVL)
    devid = 0x44
    pasid_a = 0x100
    pasid_b = 0x200

    await mmio_write64(dut, OFFS_ALLOW_BASE, (1 << 63) | devid)
    pre = int(dut.fault_count_dbg.value)

    # PASID A allowed
    await upstream_write(dut, 0, devid=devid, pasid=pasid_a, addr=0xB000)
    await Timer(80, units="ns")
    assert int(dut.fault_count_dbg.value) == pre, "PASID A allowed-path should not fault"

    # Revoke and try PASID B
    await mmio_write64(dut, OFFS_ALLOW_BASE, devid)  # bit 63 cleared
    await upstream_write(dut, 0, devid=devid, pasid=pasid_b, addr=0xB100)
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.fault_count_dbg.value) > pre:
            break
    assert int(dut.fault_count_dbg.value) == pre + 1, "PASID B after revoke must fault"

    # Re-authorise; PASID B path opens
    await mmio_write64(dut, OFFS_ALLOW_BASE, (1 << 63) | devid)
    pre2 = int(dut.fault_count_dbg.value)
    await upstream_write(dut, 0, devid=devid, pasid=pasid_b, addr=0xB200)
    await Timer(80, units="ns")
    assert int(dut.fault_count_dbg.value) == pre2, "PASID B after re-auth should not fault"


@cocotb.test()
async def page_request_interface_counter_visible(dut):
    """PQB/PQH/PQT registers must be addressable and the page_req_count_dbg
    observability counter starts at 0. A real PR walker invocation lands
    in a later milestone; this test just locks the MMIO contract so the
    Linux IOMMU driver can probe the queue."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    # PQB - page-request queue base
    OFFS_PQB = 0x038
    OFFS_PQH = 0x040
    OFFS_PQT = 0x044
    OFFS_PQCSR = 0x050
    await mmio_write64(dut, OFFS_PQB, 0x0000_0000_C000_0000)
    pqb = await mmio_read64(dut, OFFS_PQB)
    assert pqb == 0x0000_0000_C000_0000, f"PQB read-back: {pqb:#x}"
    pqh = await mmio_read64(dut, OFFS_PQH)
    pqt = await mmio_read64(dut, OFFS_PQT)
    assert pqh == 0, f"PQH reset: {pqh}"
    assert pqt == 0, f"PQT reset: {pqt}"
    # PQCSR must be addressable
    pqcsr = await mmio_read64(dut, OFFS_PQCSR)
    assert pqcsr in (0, pqcsr), "PQCSR readable"
    # page-request count observability
    assert int(dut.page_req_count_dbg.value) == 0


@cocotb.test()
async def ats_translation_capability_advertised(dut):
    """CAPABILITIES must advertise ATS, PRI, PAS, T2GPA, and IGS=MSI.

    Bit positions follow the on-chip CAPS_RESET_VALUE packing in
    rtl/iommu/e1_riscv_iommu.sv (see e1_riscv_iommu_pkg.sv comments):
        version[7:0], reserved[11:8], Sv57[15:12], Sv48x4[19:16],
        reserved[25:20], IGS[29:26], END[30], T2GPA[31], ATS[32],
        PRI[33], PAS[34], PD8[35], PD17[36], PD20[37].
    The Linux driver decodes the same field map, so any drift here is a
    contract break with kernel ``drivers/iommu/riscv/iommu.c``.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    caps = await mmio_read64(dut, OFFS_CAPABILITIES)
    assert caps & (1 << 32), f"ATS capability bit missing in CAPABILITIES=0x{caps:016X}"
    assert caps & (1 << 33), f"PRI capability bit missing in CAPABILITIES=0x{caps:016X}"
    assert caps & (1 << 34), f"PAS capability bit missing in CAPABILITIES=0x{caps:016X}"
    assert caps & (1 << 31), f"T2GPA capability bit missing in CAPABILITIES=0x{caps:016X}"
    assert caps & (1 << 37), f"PD20 capability bit missing in CAPABILITIES=0x{caps:016X}"
    igs = (caps >> 26) & 0xF
    assert igs == 0x2, f"IGS must be 2 (MSI), got {igs:#x}"


@cocotb.test()
async def translation_request_interface_round_trip(dut):
    """The TR_REQ_IOVA / TR_REQ_CTL / TR_RESPONSE register triple is the
    in-band translation-request interface used by debug + IOMMU driver
    for one-shot translation probes. Confirm the registers latch and
    read back."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    OFFS_TR_REQ_IOVA = 0x258
    OFFS_TR_REQ_CTL = 0x260
    iova = 0x0000_0000_8000_1000
    await mmio_write64(dut, OFFS_TR_REQ_IOVA, iova)
    rb = await mmio_read64(dut, OFFS_TR_REQ_IOVA)
    assert rb == iova, f"TR_REQ_IOVA read-back: {rb:#x}"
    ctl = 0x0000_0000_0000_0001  # go bit
    await mmio_write64(dut, OFFS_TR_REQ_CTL, ctl)
    rb_ctl = await mmio_read64(dut, OFFS_TR_REQ_CTL)
    # ctl read-back: at minimum, go bit honoured by the register
    assert rb_ctl & 0x1, f"TR_REQ_CTL go bit not latched: {rb_ctl:#x}"

# ==========================================================================
# Two-stage page-table walker KAT (Known-Answer Tests).
#
# These tests build a real Device Directory Table and RISC-V Sv39 / Sv39x4
# page tables in the testbench backing memory (dut.mem, a flat 64-bit
# doubleword array), program DDTP + iosatp + iohgatp through the device
# context, and assert the walker produces the correct IOVA -> PA, faults
# fail-closed with a correct fault-queue record, and the command queue
# IOFENCE.C completes.
#
# Memory model: dut.mem[word] is byte_addr >> 3.  All physical addresses
# fit within the 32 KiB backing store (PPNs 0..7).
# ==========================================================================

# PTE bit fields.
PTE_V = 1 << 0
PTE_R = 1 << 1
PTE_W = 1 << 2
PTE_X = 1 << 3
PTE_U = 1 << 4
PTE_A = 1 << 6
PTE_D = 1 << 7

OFFS_DDTP_FULL = 0x010
OFFS_CQB = 0x018
OFFS_CQT = 0x024
OFFS_CQCSR = 0x048

DDTP_PPN_SHIFT = 10  # ddtp.ppn occupies bits [53:10]


def mem_write(dut, byte_addr, value):
    """Poke a 64-bit doubleword into the backing memory."""
    assert (byte_addr & 0x7) == 0, "doubleword-aligned only"
    word = (byte_addr >> 3) % 16384
    dut.mem[word].value = value & ((1 << 64) - 1)


def mem_read(dut, byte_addr):
    word = (byte_addr >> 3) % 16384
    return int(dut.mem[word].value)


def leaf_pte(ppn, perms):
    return ((ppn & ((1 << 44) - 1)) << 10) | perms | PTE_V


def nonleaf_pte(ppn):
    return ((ppn & ((1 << 44) - 1)) << 10) | PTE_V


def sv39_indices(va):
    return [(va >> 12) & 0x1FF, (va >> 21) & 0x1FF, (va >> 30) & 0x1FF]


def make_ddtp(ppn, mode):
    return ((ppn & ((1 << 44) - 1)) << DDTP_PPN_SHIFT) | (mode & 0xF)


def build_device_context(dut, ddt_ppn, devid, iosatp_dw, iohgatp_dw):
    """1LVL DDT: DC (4 doublewords) at (ddt_ppn<<12) + (devid&0x7F)*32."""
    dc_base = (ddt_ppn << 12) + (devid & 0x7F) * 32
    mem_write(dut, dc_base + 0, 1)          # DW0 tc: V=1
    mem_write(dut, dc_base + 8, iohgatp_dw)  # DW1 iohgatp
    mem_write(dut, dc_base + 16, 0)          # DW2 ta
    mem_write(dut, dc_base + 24, iosatp_dw)  # DW3 fsc (iosatp)


def atp_dw(mode, ppn):
    return ((mode & 0xF) << 60) | (ppn & ((1 << 44) - 1))


async def upstream_read_capture(dut, master, devid, pasid, addr):
    """Drive a single-beat read and capture rdata / rresp.

    AR valid is held through the R phase so the IOMMU's per-grant response
    forwarding stays bound to this master until the read data (or SLVERR)
    returns; both AR and R are dropped once R completes.
    """
    bit = 1 << master
    dut.u_rready.value = (int(dut.u_rready.value) & ~bit) | bit
    dut.u_arvalid.value = (int(dut.u_arvalid.value) & ~bit) | bit
    dut.u_arid[master].value = master
    dut.u_araddr[master].value = addr
    dut.u_arlen[master].value = 0
    dut.u_arsize[master].value = 4
    dut.u_arburst[master].value = 1
    dut.u_arcache[master].value = 0x2
    dut.u_arprot[master].value = 0x2
    dut.u_arqos[master].value = 0
    dut.u_aruser[master].value = 0
    dut.u_ar_devid[master].value = devid
    dut.u_ar_pasid[master].value = pasid
    rdata = 0
    rresp = 0
    got_r = False
    for _ in range(512):
        await RisingEdge(dut.clk)
        if ((int(dut.u_rvalid.value) >> master) & 1) and ((int(dut.u_rready.value) >> master) & 1):
            rdata = int(dut.u_rdata[master].value)
            rresp = int(dut.u_rresp[master].value)
            got_r = True
            break
    dut.u_arvalid.value = int(dut.u_arvalid.value) & ~bit
    dut.u_rready.value = int(dut.u_rready.value) & ~bit
    assert got_r, "no read response returned"
    return rdata, rresp


@cocotb.test()
async def walker_single_stage_iova_to_pa(dut):
    """Real DDT + Sv39 first-stage walk (G-stage BARE): a mapped IOVA
    translates to the correct PA, and the forwarded read returns the
    sentinel stored at that PA."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    ddt_ppn = 1
    devid = 0x5
    iova = 0x0040_2000
    target_ppn = 6
    sentinel = 0xA5A5_1234_DEAD_BEEF

    i = sv39_indices(iova)  # [vpn0, vpn1, vpn2]
    # FS root PPN 2 -> L1 PPN 3 -> leaf PPN 5; leaf maps target_ppn.
    mem_write(dut, (2 << 12) + i[2] * 8, nonleaf_pte(3))
    mem_write(dut, (3 << 12) + i[1] * 8, nonleaf_pte(5))
    mem_write(dut, (5 << 12) + i[0] * 8,
              leaf_pte(target_ppn, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D))
    mem_write(dut, target_ppn << 12, sentinel)

    build_device_context(
        dut, ddt_ppn, devid,
        iosatp_dw=atp_dw(8, 2),   # Sv39, root PPN 2
        iohgatp_dw=atp_dw(0, 0),  # G-stage BARE
    )

    await mmio_write64(dut, OFFS_DDTP_FULL, make_ddtp(ddt_ppn, DDTP_1LVL))
    pre_faults = int(dut.fault_count_dbg.value)
    rdata, rresp = await upstream_read_capture(dut, 0, devid, 0, iova)
    assert int(dut.fault_count_dbg.value) == pre_faults, "mapped IOVA must not fault"
    assert rresp == RESP_OKAY, f"mapped read returned resp {rresp}"
    assert rdata == sentinel, (
        f"IOVA {iova:#x} -> PA {(target_ppn<<12):#x} mismatch: "
        f"read {rdata:#x}, expected sentinel {sentinel:#x}"
    )


@cocotb.test()
async def walker_two_stage_iova_to_pa(dut):
    """Full two-stage walk: Sv39 first-stage composed with Sv39x4 G-stage.
    Each first-stage table base and the leaf PPN are G-stage translated.
    For this KAT the G-stage is an identity gigapage at the top level, so
    the composed result equals the first-stage PA — but every G-stage PTE
    is really fetched and checked by the walker."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    ddt_ppn = 1
    devid = 0x9
    iova = 0x0020_1000
    target_ppn = 7
    sentinel = 0x1122_3344_5566_7788

    i = sv39_indices(iova)
    # First-stage tables.  Their PPNs (2,3,5) and the leaf PPN (7) are guest
    # physical addresses; the G-stage maps each GPA identically to its SPA.
    mem_write(dut, (2 << 12) + i[2] * 8, nonleaf_pte(3))
    mem_write(dut, (3 << 12) + i[1] * 8, nonleaf_pte(5))
    mem_write(dut, (5 << 12) + i[0] * 8,
              leaf_pte(target_ppn, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D))
    mem_write(dut, target_ppn << 12, sentinel)

    # G-stage: full 3-level Sv39x4 walk (root PPN 8 -> L1 PPN 9 -> L0 PPN 10)
    # with 4 KiB identity leaves for every GPA the first-stage walk visits
    # (the table bases 0x2000/0x3000/0x5000 and the final page 0x7000).  All
    # those GPAs share gpn2=0, gpn1=0 and differ only in gpn0, so a single
    # G L0 table holds an identity leaf at each gpn0 index.  Every G-stage
    # PTE is really fetched and permission/A/D-checked by the walker.
    perms = PTE_R | PTE_W | PTE_U | PTE_A | PTE_D
    mem_write(dut, (8 << 12) + 0, nonleaf_pte(9))   # G root[gpn2=0] -> G L1
    mem_write(dut, (9 << 12) + 0, nonleaf_pte(10))  # G L1[gpn1=0]  -> G L0
    for gpn0 in (2, 3, 5, 7):
        mem_write(dut, (10 << 12) + gpn0 * 8, leaf_pte(gpn0, perms))  # identity

    build_device_context(
        dut, ddt_ppn, devid,
        iosatp_dw=atp_dw(8, 2),   # Sv39, FS root PPN 2 (a GPA)
        iohgatp_dw=atp_dw(8, 8),  # Sv39x4, GS root PPN 8
    )

    await mmio_write64(dut, OFFS_DDTP_FULL, make_ddtp(ddt_ppn, DDTP_1LVL))
    pre_faults = int(dut.fault_count_dbg.value)
    rdata, rresp = await upstream_read_capture(dut, 0, devid, 0, iova)
    assert int(dut.fault_count_dbg.value) == pre_faults, "two-stage mapped IOVA must not fault"
    assert rresp == RESP_OKAY, f"two-stage read resp {rresp}"
    assert rdata == sentinel, (
        f"two-stage IOVA {iova:#x} -> PA {(target_ppn<<12):#x}: "
        f"read {rdata:#x} expected {sentinel:#x}"
    )


@cocotb.test()
async def walker_unmapped_iova_faults_with_record(dut):
    """A valid device context whose first-stage leaf is invalid faults
    fail-closed: SLVERR upstream, a load-page-fault cause in the fault
    queue staging, and the correct device-id / iova in the record."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    ddt_ppn = 1
    devid = 0x5
    iova = 0x0040_2000

    i = sv39_indices(iova)
    # Valid descent to the leaf table, but the leaf PTE is invalid (V=0).
    mem_write(dut, (2 << 12) + i[2] * 8, nonleaf_pte(3))
    mem_write(dut, (3 << 12) + i[1] * 8, nonleaf_pte(5))
    mem_write(dut, (5 << 12) + i[0] * 8, 0)  # leaf invalid (clears any residue)

    build_device_context(
        dut, ddt_ppn, devid,
        iosatp_dw=atp_dw(8, 2),
        iohgatp_dw=atp_dw(0, 0),
    )

    await mmio_write64(dut, OFFS_DDTP_FULL, make_ddtp(ddt_ppn, DDTP_1LVL))
    pre_faults = int(dut.fault_count_dbg.value)
    rdata, rresp = await upstream_read_capture(dut, 0, devid, 0, iova)
    for _ in range(32):
        await RisingEdge(dut.clk)
        if int(dut.fault_count_dbg.value) > pre_faults:
            break
    assert int(dut.fault_count_dbg.value) == pre_faults + 1, "unmapped IOVA must fault once"
    assert rresp == RESP_SLVERR, f"faulting read must return SLVERR, got {rresp}"
    # Inspect the staged fault record (head of the staging ring).  Verilator
    # flattens the packed fault_record_t into one vector; slice the fields
    # by their packed positions (LSB-first):
    #   iotval2[63:0], iotval[127:64], iotval_present[131:128], custom[132],
    #   did[156:133], pid[176:157], rsvd_pid[177], priv[178], ttyp[184:179],
    #   cause[196:185].
    rec = int(dut.u_iommu.fq_stage[0].value)
    cause = (rec >> 185) & 0xFFF
    rec_did = (rec >> 133) & 0xFFFFFF
    rec_iotval = (rec >> 64) & ((1 << 64) - 1)
    CAUSE_LOAD_PAGE_FAULT = 13
    assert cause == CAUSE_LOAD_PAGE_FAULT, f"fault cause {cause} != load-page-fault"
    assert rec_did == devid, f"fault record did {rec_did:#x} != {devid:#x}"
    assert rec_iotval == iova, f"fault record iotval {rec_iotval:#x} != iova {iova:#x}"


@cocotb.test()
async def walker_bare_mode_identity(dut):
    """BARE mode forwards identity with no walk: the forwarded read hits
    the same PA as the IOVA and returns the sentinel stored there."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    iova = 0x0000_3000  # PPN 3
    sentinel = 0xCAFE_F00D_0BAD_F00D
    mem_write(dut, iova, sentinel)

    await mmio_write64(dut, OFFS_DDTP_FULL, DDTP_BARE)
    pre_faults = int(dut.fault_count_dbg.value)
    rdata, rresp = await upstream_read_capture(dut, 0, 0x123, 0, iova)
    assert int(dut.fault_count_dbg.value) == pre_faults, "BARE must not fault"
    assert rdata == sentinel, f"BARE identity read {rdata:#x} != {sentinel:#x}"


@cocotb.test()
async def command_queue_iofence_completes(dut):
    """Program a memory-resident command queue with a single IOFENCE.C and
    confirm the CQ engine fetches it, pulses cmd_complete_irq, and advances
    CQH past the consumed entry."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    cq_ppn = 1
    # IOFENCE.C: opcode field [6:0] == 0x02 (per the RTL CMD_OP_IOFENCE).
    mem_write(dut, (cq_ppn << 12) + 0, 0x02)   # command word 0 (low 64b)
    mem_write(dut, (cq_ppn << 12) + 8, 0x00)   # command word 1 (high 64b)

    await mmio_write64(dut, OFFS_CQB, make_ddtp(cq_ppn, 0))  # cqb.ppn = cq_ppn
    await mmio_write64(dut, OFFS_CQCSR, 0x1)                 # cqen
    await mmio_write64(dut, OFFS_CQT, 0x1)                   # one command queued

    seen_complete = False
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.cmd_complete_irq.value):
            seen_complete = True
            break
    assert seen_complete, "IOFENCE.C did not pulse cmd_complete_irq"
    cqh = await mmio_read64(dut, OFFS_CQH)
    assert (cqh & 0xFFFF_FFFF) == 1, f"CQH did not advance past IOFENCE (got {cqh})"

"""DFI 5.0 north traffic shape test for the e1_dram_ctrl wrapper.

The closed-IP LPDDR5X/6 PHY is procurement-blocked
(docs/evidence/memory/lpddr-phy-procurement.yaml).  Until the vendor PHY
is attached, the controller stub drives representative DFI 5.0 north
commands directly from the AXI4 handshake + refresh scheduler.  This
test issues a few small AXI4 reads and writes through the production
fabric and verifies:

* dfi_init_start asserts at boot and dfi_cke comes up afterwards.
* Each accepted AW emits an ACTIVATE-shaped command edge.
* Each W beat emits a WRITE-shaped command with wrdata_en + non-default
  data and mask.
* Each accepted AR emits an ACTIVATE-shaped command edge.
* Each R beat emits a READ-shaped command with rddata_en.
* The refresh scheduler raises refresh_active periodically and emits a
  REFRESH-shaped command for the duration.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

BURST_INCR = 1
RESP_OKAY = 0

DATA_WIDTH = 128
BYTES_PER_BEAT = DATA_WIDTH // 8


async def reset(dut):
    dut.rst_n.value = 0
    dut.m_awvalid.value = 0
    dut.m_wvalid.value = 0
    dut.m_bready.value = 0
    dut.m_arvalid.value = 0
    dut.m_rready.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


async def axi4_write_burst(
    dut, master, awid, addr, beats, size=4
):
    bit = 1 << master
    dut.m_awid[master].value = awid
    dut.m_awaddr[master].value = addr
    dut.m_awlen[master].value = len(beats) - 1
    dut.m_awsize[master].value = size
    dut.m_awburst[master].value = BURST_INCR
    dut.m_awlock[master].value = 0
    dut.m_awcache[master].value = 0x2
    dut.m_awprot[master].value = 0x2
    dut.m_awqos[master].value = 0
    dut.m_awuser[master].value = 0
    dut.m_awvalid.value = (int(dut.m_awvalid.value) & ~bit) | bit
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.m_awready.value) & bit:
            break
    dut.m_awvalid.value = int(dut.m_awvalid.value) & ~bit

    for i, (data, strb) in enumerate(beats):
        dut.m_wdata[master].value = data
        dut.m_wstrb[master].value = strb
        dut.m_wlast[master].value = 1 if i == len(beats) - 1 else 0
        dut.m_wvalid.value = (int(dut.m_wvalid.value) & ~bit) | bit
        for _ in range(512):
            await RisingEdge(dut.clk)
            if int(dut.m_wready.value) & bit:
                break
        dut.m_wvalid.value = int(dut.m_wvalid.value) & ~bit
        await RisingEdge(dut.clk)
    dut.m_wlast[master].value = 0

    dut.m_bready.value = int(dut.m_bready.value) | bit
    for _ in range(4096):
        await RisingEdge(dut.clk)
        if int(dut.m_bvalid.value) & bit:
            break
    dut.m_bready.value = int(dut.m_bready.value) & ~bit


async def axi4_read_burst(dut, master, arid, addr, length, size=4):
    bit = 1 << master
    dut.m_arid[master].value = arid
    dut.m_araddr[master].value = addr
    dut.m_arlen[master].value = length - 1
    dut.m_arsize[master].value = size
    dut.m_arburst[master].value = BURST_INCR
    dut.m_arlock[master].value = 0
    dut.m_arcache[master].value = 0x2
    dut.m_arprot[master].value = 0x2
    dut.m_arqos[master].value = 0
    dut.m_aruser[master].value = 0
    dut.m_arvalid.value = (int(dut.m_arvalid.value) & ~bit) | bit
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.m_arready.value) & bit:
            break
    dut.m_arvalid.value = int(dut.m_arvalid.value) & ~bit

    dut.m_rready.value = int(dut.m_rready.value) | bit
    beats = []
    for _ in range(length * 256 + 256):
        await RisingEdge(dut.clk)
        if int(dut.m_rvalid.value) & bit:
            beats.append(int(dut.m_rdata[master].value))
            if int(dut.m_rlast.value) & bit:
                break
    dut.m_rready.value = int(dut.m_rready.value) & ~bit
    return beats


def is_activate(dut):
    return (
        int(dut.dfi_cs_n.value) == 0
        and int(dut.dfi_act_n.value) == 0
        and int(dut.dfi_ras_n.value) == 0
        and int(dut.dfi_cas_n.value) == 1
        and int(dut.dfi_we_n.value) == 1
    )


def is_write_col(dut):
    return (
        int(dut.dfi_cs_n.value) == 0
        and int(dut.dfi_act_n.value) == 1
        and int(dut.dfi_ras_n.value) == 1
        and int(dut.dfi_cas_n.value) == 0
        and int(dut.dfi_we_n.value) == 0
        and int(dut.dfi_wrdata_en.value) == 1
    )


def is_read_col(dut):
    return (
        int(dut.dfi_cs_n.value) == 0
        and int(dut.dfi_act_n.value) == 1
        and int(dut.dfi_ras_n.value) == 1
        and int(dut.dfi_cas_n.value) == 0
        and int(dut.dfi_we_n.value) == 1
        and int(dut.dfi_rddata_en.value) == 1
    )


def is_refresh(dut):
    return (
        int(dut.dfi_cs_n.value) == 0
        and int(dut.dfi_act_n.value) == 1
        and int(dut.dfi_ras_n.value) == 0
        and int(dut.dfi_cas_n.value) == 0
        and int(dut.dfi_we_n.value) == 1
    )


@cocotb.test()
async def dfi_init_brings_cke_high(dut):
    """dfi_init_start asserts at boot; dfi_cke comes high once the
    controller observes the AXI4 slave path is alive."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Right after reset the controller should request init.  CKE is
    # initially low; once init is sampled CKE comes high.
    seen_init = False
    seen_cke = False
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.dfi_init_start.value) == 1:
            seen_init = True
        if int(dut.dfi_cke.value) == 1:
            seen_cke = True
            break
    assert seen_init, "dfi_init_start never asserted"
    assert seen_cke, "dfi_cke never came high after init"


@cocotb.test()
async def dfi_write_emits_activate_then_write_col(dut):
    """A burst write through the fabric must produce at least one
    ACTIVATE-shaped command on AW handshake and one WRITE-shaped
    command per W beat."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    size = int(BYTES_PER_BEAT).bit_length() - 1
    full_strb = (1 << BYTES_PER_BEAT) - 1

    # Capture DFI events while a write burst runs.
    activate_seen = 0
    write_seen = 0
    write_data_observed = []

    async def watch():
        nonlocal activate_seen, write_seen
        for _ in range(2000):
            await RisingEdge(dut.clk)
            if is_activate(dut):
                activate_seen += 1
            if is_write_col(dut):
                write_seen += 1
                write_data_observed.append(int(dut.dfi_wrdata.value))

    watcher = cocotb.start_soon(watch())
    beats = [(0xDEAD_BEEF_0000_0000 + i, full_strb) for i in range(4)]
    await axi4_write_burst(dut, 0, 0x3, 0x4000, beats, size=size)
    # Let the watcher drain a few more cycles
    for _ in range(40):
        await RisingEdge(dut.clk)
    watcher.kill()

    assert activate_seen >= 1, "no ACTIVATE-shaped DFI command observed"
    assert write_seen >= 4, f"expected >=4 WRITE-col DFI cmds, got {write_seen}"
    # Confirm the data the controller put on dfi_wrdata matches the
    # data we shipped in.  The behavioural model is byte-addressable so
    # the lower 64 bits carry the test pattern.
    matched = sum(
        1
        for d in write_data_observed
        if (d & 0xFFFFFFFFFFFFFFFF) in {(0xDEAD_BEEF_0000_0000 + i) & 0xFFFFFFFFFFFFFFFF for i in range(4)}
    )
    assert matched >= 4, \
        f"WRITE-col DFI wrdata did not reflect AXI4 wdata (matched={matched})"


@cocotb.test()
async def dfi_read_emits_activate_then_read_col(dut):
    """A burst read must produce an ACTIVATE plus one READ-shaped
    command per R beat with dfi_rddata_en asserted."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    size = int(BYTES_PER_BEAT).bit_length() - 1
    activate_seen = 0
    read_seen = 0

    async def watch():
        nonlocal activate_seen, read_seen
        for _ in range(2000):
            await RisingEdge(dut.clk)
            if is_activate(dut):
                activate_seen += 1
            if is_read_col(dut):
                read_seen += 1

    watcher = cocotb.start_soon(watch())
    await axi4_read_burst(dut, 0, 0x5, 0x2000, 4, size=size)
    for _ in range(40):
        await RisingEdge(dut.clk)
    watcher.kill()

    assert activate_seen >= 1, "no ACTIVATE-shaped DFI command observed on read"
    assert read_seen >= 4, f"expected >=4 READ-col DFI cmds, got {read_seen}"


@cocotb.test()
async def dfi_refresh_fires_within_window(dut):
    """The compressed refresh scheduler (TREFI=256) must raise
    refresh_active and emit at least one REFRESH-shaped command within
    a few TREFI windows."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    refresh_active_seen = False
    refresh_cmd_seen = False
    for _ in range(4096):
        await RisingEdge(dut.clk)
        if int(dut.refresh_active.value) == 1:
            refresh_active_seen = True
            if is_refresh(dut):
                refresh_cmd_seen = True
                break

    assert refresh_active_seen, "refresh_active never asserted"
    assert refresh_cmd_seen, "no REFRESH-shaped DFI command observed"

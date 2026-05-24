"""SoC integration smoke — CLINT, PLIC, and AXI4 DRAM-controller RTL in e1_soc_top.

Drives the integrated e1_soc_top config (compiled with +define+E1_SOC_REAL_IRQ
+define+E1_SOC_REAL_DRAM) through its 32-bit MMIO debug aperture and proves the
RTL interrupt + main-memory leaves compose end to end inside the SoC,
not just standalone:

  * dram_rw            — write/read words through the e1_dram_ctrl AXI4
                         RTL model at the 2 GiB @ 0x8000_0000 main-memory
                         window; the discoverable capacity ports report 2 GiB.
  * clint_timer_irq    — program the e1_clint RTL mtimecmp and observe mtip_o
                         (mip.MTIP) assert when the free-running mtime crosses
                         it; the CPU subsystem's time_irq_i is fed from it.
  * plic_claim_complete— raise a device IRQ source line into the e1_plic RTL
                         gateway, enable it, claim it (read), confirm meip_o
                         (mip.MEIP) round-trips, then complete it.

The MMIO aperture is single-outstanding; RTL regions hold mmio_ready low
until the AXI(-Lite) transfer drains, so these helpers poll mmio_ready.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# Spec base addresses (match sw/platform/generated/e1-platform.dtsi).
CLINT_BASE = 0x0200_0000
PLIC_BASE = 0x0C00_0000
DRAM_BASE = 0x8000_0000

# CLINT register offsets (RISC-V CLINT map).
CLINT_MSIP = 0x0000
CLINT_MTIMECMP_LO = 0x4000
CLINT_MTIMECMP_HI = 0x4004
CLINT_MTIME_LO = 0xBFF8
CLINT_MTIME_HI = 0xBFFC

# PLIC register offsets (RISC-V PLIC v1.0.0 map), context 0 = hart0 M-mode.
PLIC_PRIORITY = 0x00_0000  # +4*src
PLIC_ENABLE_CTX0 = 0x00_2000  # bitfield, bit s = source s
PLIC_THRESHOLD_CTX0 = 0x20_0000
PLIC_CLAIM_CTX0 = 0x20_0004

# DMA peripheral IRQ is PLIC source id 2 (sources = {vsync,npu,dma,timer},
# index 0 == id 1, so dma is bit 1 -> source id 2). We exercise the timer
# source (id 1) which the peripheral block raises deterministically.
SRC_TIMER = 1


def _has_rot(dut):
    return hasattr(dut, "boot_verified_i")


async def reset(dut, release_rot=True):
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    if _has_rot(dut):
        # Default: pre-assert the RoT release strobes so the CPU is released
        # and the rest of the smoke runs unchanged. The dedicated RoT test
        # overrides release_rot=False to prove the fail-closed hold.
        dut.boot_verified_i.value = 1 if release_rot else 0
        dut.iopmp_policy_ready_i.value = 1 if release_rot else 0
        dut.lc_scrap_i.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _wait_ready(dut, timeout=512):
    for _ in range(timeout):
        await Timer(1, units="ns")
        if int(dut.mmio_ready.value):
            return
        await RisingEdge(dut.clk)
    raise AssertionError("mmio_ready never asserted")


async def mwrite(dut, addr, data):
    """One MMIO write that holds valid until the (multi-cycle) region drains."""
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    await _wait_ready(dut)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await RisingEdge(dut.clk)


async def mread(dut, addr):
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await _wait_ready(dut)
    value = int(dut.mmio_rdata.value)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


@cocotb.test()
async def dram_rw(dut):
    """AXI4 DRAM-controller RTL model: word write/read at the 2 GiB main window."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Discoverable capacity = 2 GiB @ 0x8000_0000 (boot enumeration / DTB).
    assert int(dut.mem_base_addr.value) == DRAM_BASE
    assert int(dut.mem_capacity_bytes.value) == 0x8000_0000

    patterns = {
        DRAM_BASE + 0x000: 0xDEAD_BEEF,
        DRAM_BASE + 0x004: 0x0BAD_F00D,
        DRAM_BASE + 0x010: 0x1234_5678,
        DRAM_BASE + 0x040: 0xCAFE_BABE,
    }
    for addr, val in patterns.items():
        await mwrite(dut, addr, val)
    for addr, val in patterns.items():
        got = await mread(dut, addr)
        assert got == val, f"DRAM 0x{addr:08x}: got 0x{got:08x} want 0x{val:08x}"

    # Overwrite then re-read proves the AXI4 write path (B response) committed.
    await mwrite(dut, DRAM_BASE + 0x000, 0xA5A5_5A5A)
    assert await mread(dut, DRAM_BASE + 0x000) == 0xA5A5_5A5A


@cocotb.test()
async def clint_timer_irq(dut):
    """Real CLINT: program mtimecmp, take a timer interrupt (mtip_o)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # No spurious timer IRQ at reset (mtimecmp resets to all-ones).
    assert int(dut.mtip_o.value) == 0

    # msip round-trips through the CLINT RTL (software interrupt).
    await mwrite(dut, CLINT_BASE + CLINT_MSIP, 1)
    assert await mread(dut, CLINT_BASE + CLINT_MSIP) == 1
    assert int(dut.msip_o.value) == 1
    await mwrite(dut, CLINT_BASE + CLINT_MSIP, 0)
    assert int(dut.msip_o.value) == 0

    # Reset mtime low/high to 0, then arm mtimecmp at a small value.
    await mwrite(dut, CLINT_BASE + CLINT_MTIME_LO, 0)
    await mwrite(dut, CLINT_BASE + CLINT_MTIME_HI, 0)
    await mwrite(dut, CLINT_BASE + CLINT_MTIMECMP_LO, 64)
    await mwrite(dut, CLINT_BASE + CLINT_MTIMECMP_HI, 0)
    assert await mread(dut, CLINT_BASE + CLINT_MTIMECMP_LO) == 64

    saw_mtip = False
    for _ in range(256):
        await RisingEdge(dut.clk)
        if int(dut.mtip_o.value) == 1:
            saw_mtip = True
            break
    assert saw_mtip, "timer interrupt (mtip_o) never asserted"


@cocotb.test()
async def plic_claim_complete(dut):
    """Real PLIC: device IRQ -> enable -> claim (meip_o) -> complete."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # No external interrupt before any source is enabled.
    assert int(dut.meip_o.value) == 0

    # Program the peripheral timer to raise its IRQ line (PLIC source 1).
    # 0x1000_0010 is the peripheral timer-compare register (see e1_peripherals).
    await mwrite(dut, 0x1000_0010, 4)
    for _ in range(16):
        await RisingEdge(dut.clk)
    assert int(dut.irq_timer.value) == 1, "peripheral timer IRQ not raised"

    # Give source 1 a non-zero priority, set ctx0 threshold below it, enable it.
    await mwrite(dut, PLIC_BASE + PLIC_PRIORITY + 4 * SRC_TIMER, 5)
    await mwrite(dut, PLIC_BASE + PLIC_THRESHOLD_CTX0, 0)
    await mwrite(dut, PLIC_BASE + PLIC_ENABLE_CTX0, 1 << SRC_TIMER)

    # The external-interrupt line to the CPU (mip.MEIP) must now be asserted.
    await RisingEdge(dut.clk)
    assert int(dut.meip_o.value) == 1, "PLIC did not raise meip_o for enabled src"

    # Claim: read claim/complete returns the highest-priority pending source.
    claimed = await mread(dut, PLIC_BASE + PLIC_CLAIM_CTX0)
    assert claimed == SRC_TIMER, f"claim returned {claimed}, expected {SRC_TIMER}"

    # While in service, the gateway masks the source, so meip drops even though
    # the line is still high.
    await RisingEdge(dut.clk)
    assert int(dut.meip_o.value) == 0, "meip_o should drop while source in service"

    # Complete: write the claimed id back to re-arm the gateway.
    await mwrite(dut, PLIC_BASE + PLIC_CLAIM_CTX0, SRC_TIMER)
    # The line is still high, so the gateway re-arms and meip re-asserts.
    for _ in range(8):
        await RisingEdge(dut.clk)
        if int(dut.meip_o.value) == 1:
            break
    assert int(dut.meip_o.value) == 1, "gateway did not re-arm after complete"


# RoT FSM states (rtl/security/rot/e1_rot_reset_seq.sv).
ST_ROT_RUN = 1
ST_WAIT_IOPMP = 2
ST_RELEASED = 3


@cocotb.test()
async def rot_gated_boot(dut):
    """RoT reset sequencer holds the CPU in reset until boot_verified + IOPMP.

    Only meaningful when compiled with +define+E1_SOC_ROT_GATED; skipped
    otherwise (the gated ports are absent).
    """
    if not _has_rot(dut):
        return  # config without the RoT gate; nothing to prove here

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    # Bring up with the release strobes LOW: the cluster must stay held.
    await reset(dut, release_rot=False)

    # After a few cycles the RoT itself is running but the AP cluster is held.
    for _ in range(8):
        await RisingEdge(dut.clk)
    assert int(dut.rot_state_o.value) == ST_ROT_RUN, "RoT not awaiting verdict"
    assert int(dut.platform_released_o.value) == 0, "platform released too early"

    # Strobe secure-boot verified: advances to WAIT_IOPMP, still not released.
    dut.boot_verified_i.value = 1
    await RisingEdge(dut.clk)
    dut.boot_verified_i.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.rot_state_o.value) == ST_WAIT_IOPMP
    assert int(dut.platform_released_o.value) == 0, "released before IOPMP policy"

    # Program the IOPMP policy: now the cluster is released.
    dut.iopmp_policy_ready_i.value = 1
    await RisingEdge(dut.clk)
    dut.iopmp_policy_ready_i.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.rot_state_o.value) == ST_RELEASED
    assert int(dut.platform_released_o.value) == 1, "platform never released"
    assert int(dut.rot_halted_o.value) == 0

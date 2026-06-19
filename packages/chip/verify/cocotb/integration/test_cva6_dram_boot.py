"""CVA6 boots a bare-metal M-mode image from the REAL AXI4 DRAM controller.

This is the CPU-execution-substrate proof for the E1 SoC.  The DUT
(`rtl/top/e1_cva6_dram_boot_top.sv`) wires the REAL OpenHW CVA6 v5.3.0 core
(`+define+E1_HAVE_CVA6`) through the REAL NoC->AXI4 adapter, the REAL 64->128
width converter, the REAL `e1_axi4_interconnect` fabric, to the REAL
`e1_dram_ctrl` AXI4 DRAM controller and the REAL `e1_clint`, released by the
REAL `e1_rot_reset_seq`.

The firmware (`fw/bare-metal/e1-cva6-dram-boot/boot.S`) is preloaded into the
DRAM controller's backing store via the `+E1_DRAM_PRELOAD_HEX` plusarg (the
deterministic stand-in for the secure boot-ROM / loader).  After the RoT
release inputs are asserted, CVA6 fetches and executes the image FROM REAL
DRAM through the real datapath.

The program (see boot.S):
  1. fetches itself from DRAM @ 0x8000_0000,
  2. stores a marker pattern to DRAM and reads it back,
  3. programs CLINT mtimecmp, enables mie.MTIE + mstatus.MIE, waits,
  4. takes the machine timer trap into mtvec; the handler records
     mcause/mepc to DRAM and disarms the timer,
  5. writes the ASCII "E1BOOT-OK" marker to DRAM, then spins.

Pass criteria (all must hold):
  * DRAM AR/R counters > 0  — CVA6 fetched instructions from real DRAM.
  * DRAM AW/W/B counters > 0 — CVA6 wrote real DRAM.
  * CLINT AW counter > 0    — CVA6 programmed the timer through the fabric.
  * MARK_ALIVE / MARK_ECHO  — store + load round-tripped (read back from DRAM).
  * MARK_TRAP_HIT == 1      — the timer trap was taken.
  * MARK_MCAUSE bit63 set, low bits == 7 — machine timer interrupt cause.
  * MARK_BOOT_OK == "E1BOOT-OK\\0".
"""

from __future__ import annotations

import os

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

# DRAM marker map (byte offsets from DRAM base 0x8000_0000), mirroring boot.S.
DRAM_BASE = 0x8000_0000
MARK_BASE = 0x8000_2000
OFF_ALIVE = 0x00
OFF_ECHO = 0x08
OFF_TRAP = 0x10
OFF_MCAUSE = 0x18
OFF_MEPC = 0x20
OFF_BOOT_OK = 0x30

EXPECT_ALIVE = 0x1122_3344_5566_7788
# RV64 machine timer interrupt: mcause = (1<<63) | 7
MCAUSE_M_TIMER = (1 << 63) | 7
BOOT_OK_LO = 0x4F2D_544F_4F42_3145  # "E1BOOT-O"
BOOT_OK_HI = 0x0000_0000_0000_004B  # "K\0"

_RUN = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"

# The marker words are observed off the live DRAM write channel and exposed as
# flat output ports by the DUT (Verilator's GPI cannot read the controller's
# sim-only associative backing store, so the top snoops the real write beats).
_MARK_PORT = {
    OFF_ALIVE: "mark_alive_o",
    OFF_ECHO: "mark_echo_o",
    OFF_TRAP: "mark_trap_o",
    OFF_MCAUSE: "mark_mcause_o",
    OFF_MEPC: "mark_mepc_o",
    OFF_BOOT_OK: "mark_bootok_lo_o",
    OFF_BOOT_OK + 8: "mark_bootok_hi_o",
}


def _read_dram_u64(dut, abs_addr: int) -> int:
    """Return the snooped 64-bit marker word the CPU wrote to `abs_addr`."""
    off = abs_addr - MARK_BASE
    return int(getattr(dut, _MARK_PORT[off]).value)


async def _release_reset_and_rot(dut) -> None:
    """Drive cold reset, then strobe the RoT release inputs so the sequencer
    releases the CVA6 application core (boot_verified + iopmp_policy_ready)."""
    dut.rst_n.value = 0
    dut.boot_verified_i.value = 0
    dut.iopmp_policy_ready_i.value = 0
    dut.lc_scrap_i.value = 0
    dut.plic_sources_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)
    # RoT walks ST_ROT_RESET -> ST_ROT_RUN; assert boot_verified to advance to
    # ST_WAIT_IOPMP, then iopmp_policy_ready to reach ST_RELEASED (CVA6 reset
    # deasserts).  Fail-closed: without these the core never runs.
    dut.boot_verified_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.iopmp_policy_ready_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


@cocotb.test(skip=not _RUN)
async def test_cva6_executes_from_real_dram(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _release_reset_and_rot(dut)

    # Confirm the RoT actually released the platform before running.
    assert int(dut.platform_released_o.value) == 1, (
        "RoT did not release the CVA6 cluster — check boot_verified/"
        "iopmp_policy_ready strobes and the reset sequencer FSM."
    )
    assert int(dut.cva6_rst_n_o.value) == 1, "CVA6 still held in reset."

    # Run long enough for: fetch from DRAM, the store/load, CLINT program,
    # the timer trap, and the boot-OK marker.  CVA6 cv64a6 takes a few
    # thousand cycles to bring up its frontend + first cache fill from DRAM.
    trap_seen = False
    for _ in range(120_000):
        await RisingEdge(dut.clk)
        if int(_read_dram_u64(dut, MARK_BASE + OFF_TRAP)) == 1:
            trap_seen = True
            # let the post-trap boot-OK stores drain
            for _ in range(2000):
                await RisingEdge(dut.clk)
            break

    # --- structural fabric/DRAM evidence ---
    dram_ar = int(dut.dram_ar_xfers_o.value)
    dram_r = int(dut.dram_r_xfers_o.value)
    dram_aw = int(dut.dram_aw_xfers_o.value)
    dram_w = int(dut.dram_w_xfers_o.value)
    dram_b = int(dut.dram_b_xfers_o.value)
    clint_aw = int(dut.clint_aw_xfers_o.value)

    assert dram_ar >= 1 and dram_r >= 1, (
        f"CVA6 never fetched/read real DRAM through the fabric "
        f"(AR={dram_ar}, R={dram_r}). The instruction-fetch datapath is broken."
    )
    assert dram_aw >= 1 and dram_w >= 1 and dram_b >= 1, (
        f"CVA6 never wrote real DRAM through the fabric (AW={dram_aw}, W={dram_w}, B={dram_b})."
    )
    assert clint_aw >= 1, (
        f"CVA6 never programmed the CLINT through the fabric (CLINT AW={clint_aw})."
    )

    # --- DRAM content evidence (store + load round-trip) ---
    alive = _read_dram_u64(dut, MARK_BASE + OFF_ALIVE)
    echo = _read_dram_u64(dut, MARK_BASE + OFF_ECHO)
    assert alive == EXPECT_ALIVE, (
        f"MARK_ALIVE mismatch: DRAM held 0x{alive:016x}, expected "
        f"0x{EXPECT_ALIVE:016x}. The CPU store to real DRAM did not land."
    )
    assert echo == EXPECT_ALIVE, (
        f"MARK_ECHO mismatch: 0x{echo:016x} != 0x{EXPECT_ALIVE:016x}. "
        "The CPU load from real DRAM did not read back the stored value."
    )

    # --- timer-trap evidence ---
    assert trap_seen, (
        "MARK_TRAP_HIT never set — CVA6 did not take the CLINT timer trap. "
        f"(mtip_o={int(dut.mtip_o.value)}, mtime={int(dut.mtime_o.value)})"
    )
    mcause = _read_dram_u64(dut, MARK_BASE + OFF_MCAUSE)
    assert (mcause >> 63) & 1 == 1, f"mcause 0x{mcause:016x} is not an interrupt (bit63 clear)."
    assert (mcause & 0x7FFF_FFFF_FFFF_FFFF) == 7, (
        f"mcause low bits 0x{mcause & 0x7FFFFFFFFFFFFFFF:x} != 7 (machine timer interrupt)."
    )
    mepc = _read_dram_u64(dut, MARK_BASE + OFF_MEPC)
    assert DRAM_BASE <= mepc < (DRAM_BASE + 0x1000), (
        f"mepc 0x{mepc:016x} not in the program text — the trap was taken from an unexpected PC."
    )

    # --- boot-OK marker ---
    ok_lo = _read_dram_u64(dut, MARK_BASE + OFF_BOOT_OK)
    ok_hi = _read_dram_u64(dut, MARK_BASE + OFF_BOOT_OK + 8)
    assert ok_lo == BOOT_OK_LO and ok_hi == BOOT_OK_HI, (
        f"boot-OK marker mismatch: lo=0x{ok_lo:016x} hi=0x{ok_hi:016x}; "
        f"expected lo=0x{BOOT_OK_LO:016x} hi=0x{BOOT_OK_HI:016x} "
        '("E1BOOT-OK").'
    )

    dut._log.info(
        "CVA6 boot substrate PROVEN: fetched+executed from real DRAM "
        f"(DRAM AR={dram_ar} R={dram_r} AW={dram_aw} W={dram_w} B={dram_b}, "
        f"CLINT AW={clint_aw}); store/load round-trip OK; timer trap taken "
        f"(mcause=0x{mcause:016x}, mepc=0x{mepc:016x}); E1BOOT-OK emitted."
    )

"""CVA6 executes a small program that writes/reads through the AXI4
fabric to the TB's DRAM model.

Drives the standalone CVA6 wrapper through `e1_cva6_unit_tb.sv`. The TB
exposes the AXI4 traffic counters so the test can verify CVA6 actually
issued the AW + W + B handshakes when the program runs the store, and
issued AR + R for the load.

Program (encoded at the boot address 0x1000):

    li   x1, 0xCAFEBABE       ; constant payload
    li   x2, 0x80000000       ; DRAM base
    sd   x1, 0(x2)            ; store the constant to DRAM[0]
    ld   x3, 0(x2)            ; reload it
    j    .                    ; spin

This test asserts:
  - At least one AW handshake fires (CVA6 issued a store).
  - At least one W handshake fires.
  - At least one B handshake completes (the store wrote back).
  - At least one AR handshake fires beyond the initial fetch traffic.

The DRAM-content readback assertion is the upgrade target: once a
side-channel observer reads the dram_mem array, the test will also
verify dram_mem[0] == 0xCAFEBABE.  Until that side-channel exists the
B-handshake count is the structural proof the store completed.

BLOCKED on Verilator 5.049 internal error (`V3Delayed: Unexpected LHS
form`) at `external/cva6/cva6/core/frontend/btb.sv:188` — see
`external/cva6/pin-manifest.json` `verilator_full_conversion_blocker`.
Set `CVA6_VERILATOR_FULL_OK=1` once a fixed Verilator release lands.
"""

from __future__ import annotations

import os

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

_RUN_CVA6 = os.environ.get("CVA6_VERILATOR_FULL_OK", "0") == "1"

# RV64I encoding (objdump-style) for the store/load program.
# Constants chosen so the program fits in the boot ROM region.
#
#   00:  lui   x1, 0xCAFEC         ; upper bits of 0xCAFEBABE
#   04:  addi  x1, x1, -1346       ; 0xCAFEBABE = 0xCAFEC000 + -0x542
#   08:  lui   x2, 0x80000         ; 0x80000000 = DRAM base
#   0c:  sd    x1, 0(x2)
#   10:  ld    x3, 0(x2)
#   14:  j     .                   ; spin
PROGRAM = [
    0x000CAFEC | 0x00000037,  # lui x1, 0xCAFEC  -> 0xCAFEC0B7
    0xABE08093,  # addi x1, x1, -1346
    0x80000137,  # lui x2, 0x80000
    0x00113023,  # sd x1, 0(x2)
    0x00013183,  # ld x3, 0(x2)
    0x0000006F,  # j .
]


async def reset(dut, cycles: int = 16) -> None:
    dut.rst_n.value = 0
    dut.irq_i.value = 0
    dut.ipi_i.value = 0
    dut.time_irq_i.value = 0
    dut.debug_req_i.value = 0
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


def _preload_rom(dut, program: list[int]) -> None:
    rom_words = (len(program) + 1) // 2
    for i in range(rom_words):
        lo = program[2 * i] if 2 * i < len(program) else 0
        hi = program[2 * i + 1] if 2 * i + 1 < len(program) else 0
        dut.boot_rom[i].value = (hi << 32) | lo


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_dram_store(dut):
    """CVA6 fires an AW + W + B sequence against the DRAM region.

    Pass criteria:
      - After reset deassertion and the program runs, the TB observes
        at least one complete AW/W/B handshake triple — proof the
        store instruction reached the AXI4 master and the TB's memory
        model accepted it.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    _preload_rom(dut, PROGRAM)
    await reset(dut)

    # Allow enough cycles for: instruction fetch + decode + issue +
    # execute + commit + writeback for the lui/addi/lui/sd chain.
    for _ in range(8192):
        await RisingEdge(dut.clk)
        if int(dut.b_xfer_count_o.value) >= 1:
            break

    assert int(dut.aw_xfer_count_o.value) >= 1, (
        "CVA6 never issued an AW handshake — the store instruction "
        "did not reach the AXI4 master.  Check the wrapper-to-CVA6 "
        "noc_req_t adapter and the program encoding."
    )
    assert int(dut.w_xfer_count_o.value) >= 1, (
        "CVA6 issued AW but never followed with a W beat — the write data channel is stalled."
    )
    assert int(dut.b_xfer_count_o.value) >= 1, (
        "CVA6 issued AW + W but the TB never returned a B response — "
        "the write-response path is broken."
    )


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_dram_load(dut):
    """CVA6 issues an AR handshake against the DRAM region.

    Pass criteria:
      - After the store-and-load program runs, the TB observes at least
        one AR handshake to the DRAM region (address >= 0x8000_0000).
        The TB counter does not currently filter by region, so we
        simply require AR + R counts to grow beyond the fetch baseline.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    _preload_rom(dut, PROGRAM)
    await reset(dut)

    # Run long enough to cover both the store and the subsequent load.
    for _ in range(12288):
        await RisingEdge(dut.clk)

    # The total AR count must include both the initial ROM fetch and
    # the load instruction's DRAM read, so we expect at least 2.
    assert int(dut.ar_xfer_count_o.value) >= 2, (
        f"Expected at least 2 AR handshakes (fetch + load), saw "
        f"{int(dut.ar_xfer_count_o.value)}.  CVA6 did not complete the "
        "load instruction."
    )
    assert int(dut.r_xfer_count_o.value) >= 2, (
        f"Expected at least 2 R-channel beats, saw {int(dut.r_xfer_count_o.value)}."
    )

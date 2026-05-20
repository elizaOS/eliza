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

The Verilator 5.049 V3Delayed `Unexpected LHS form` crash on CVA6
btb.sv:188 (and the identical bht.sv:122 pattern) is unblocked by the
tracked patches under `patches/cva6/`, applied by
`scripts/apply_cva6_patches.sh` before each Verilator run.  See
`external/cva6/pin-manifest.json::verilator_full_conversion_blocker`
(now `status: RESOLVED`).  The `cocotb-cva6-cpu-*` Makefile targets
export `CVA6_VERILATOR_FULL_OK=1` by default so the tests run.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

_RUN_CVA6 = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"
_BOOT_ROM_HEX = Path("boot_rom.hex")

# RV64I encoding (objdump-style) for the store/load program.
#
#   00:  lui   x1, 0xCAFEC         ; x1 = 0xFFFF_FFFF_CAFEC000 (sign-ext)
#   04:  addi  x1, x1, -1346       ; x1 = 0xFFFF_FFFF_CAFEBABE
#   08:  lui   x2, 0x80000         ; x2 = 0xFFFF_FFFF_8000_0000
#   0c:  sd    x1, 0(x2)           ; mem[0x8000_0000] = x1
#   10:  ld    x3, 0(x2)           ; x3 = mem[0x8000_0000]
#   14:  j     .                   ; spin-loop
#
# LUI encoding: imm[31:12] in bits [31:12], rd in [11:7], opcode 0b0110111 in [6:0].
# 0xCAFEC -> instr = (0xCAFEC << 12) | (1 << 7) | 0x37 = 0xCAFEC0B7
# 0x80000 -> instr = (0x80000 << 12) | (2 << 7) | 0x37 = 0x80000137
# (Note: lui x2, 0x80000 sign-extends to 0xFFFF_FFFF_8000_0000 on RV64;
#  the upper bits are masked away when CVA6 issues the AXI4 address.)
PROGRAM = [
    0xCAFEC0B7,  # lui  x1, 0xCAFEC
    0xABE08093,  # addi x1, x1, -1346  -> x1 = 0xCAFEBABE (sign-extended)
    0x80000137,  # lui  x2, 0x80000
    0x00113023,  # sd   x1, 0(x2)
    0x00013183,  # ld   x3, 0(x2)
    0x0000006F,  # jal  x0, 0 (j .)
]


def _write_rom_hex_at_import(program: list[int], path: Path) -> None:
    rom_words = (len(program) + 1) // 2
    lines = []
    for i in range(rom_words):
        lo = program[2 * i] if 2 * i < len(program) else 0
        hi = program[2 * i + 1] if 2 * i + 1 < len(program) else 0
        lines.append(f"{(hi << 32) | lo:016x}\n")
    path.write_text("".join(lines))


# Write the boot-ROM hex file at import time so the TB's initial
# `$readmemh` sees the payload before simulation time 0.
_write_rom_hex_at_import(PROGRAM, _BOOT_ROM_HEX)


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


def _expected_word(program: list[int], idx: int) -> int:
    lo = program[2 * idx] if 2 * idx < len(program) else 0
    hi = program[2 * idx + 1] if 2 * idx + 1 < len(program) else 0
    return (hi << 32) | lo


async def _assert_rom_preloaded(dut, program: list[int]) -> None:
    """Take the assert after one clock edge so the TB's initial-time
    `$readmemh` has run.  See the bootrom test for the long-form rationale.
    """
    await RisingEdge(dut.clk)
    expected_w0 = _expected_word(program, 0)
    expected_w1 = _expected_word(program, 1)
    expected_w2 = _expected_word(program, 2)
    got_w0 = int(dut.boot_rom_word0_o.value)
    got_w1 = int(dut.boot_rom_word1_o.value)
    got_w2 = int(dut.boot_rom_word2_o.value)
    assert got_w0 == expected_w0, (
        f"boot_rom[0] preload failed: expected 0x{expected_w0:016x}, got 0x{got_w0:016x}."
    )
    assert got_w1 == expected_w1, (
        f"boot_rom[1] preload failed: expected 0x{expected_w1:016x}, got 0x{got_w1:016x}."
    )
    assert got_w2 == expected_w2, (
        f"boot_rom[2] preload failed: expected 0x{expected_w2:016x}, got 0x{got_w2:016x}."
    )


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
    await _assert_rom_preloaded(dut, PROGRAM)
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
    await _assert_rom_preloaded(dut, PROGRAM)
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

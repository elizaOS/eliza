"""CVA6 executes a small program from the boot ROM.

This test drives the standalone CVA6 wrapper (`rtl/cpu/e1_cva6_wrapper.sv`)
through the dedicated harness `e1_cva6_unit_tb.sv`.  The harness wires the
wrapper's flat AXI4 master to a minimal in-TB ROM + DRAM memory model.

Program (4 instructions at the boot address 0x0001_0000):

    addi x1, x0, 1         ; x1 = 1
    addi x2, x0, 2         ; x2 = 2
    add  x3, x1, x2        ; x3 = 3
    j    .                 ; spin-loop

CVA6 issues an instruction-cache miss against the ROM region, then the
test observes the decoded RVFI retirement stream exported by the wrapper
through the unit TB.  The pass condition is the first four retired
instructions matching the boot ROM program at the expected PCs with no
trap, plus a non-zero AXI fetch count as the memory-side sanity check.

The Verilator 5.049 V3Delayed `Unexpected LHS form` crash on CVA6
btb.sv:188 (and the identical bht.sv:122 pattern) is unblocked by the
tracked patches under `patches/cva6/`, applied by
`scripts/apply_cva6_patches.sh` before each Verilator run.  See
`external/cva6/pin-manifest.json::verilator_full_conversion_blocker`
(now `status: RESOLVED`).  The `cocotb-cva6-cpu-*` Makefile targets
export `CVA6_VERILATOR_FULL_OK=1` by default so the tests run; set it
to `0` only when reproducing the historical skip behaviour.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

_BOOT_ROM_HEX = Path("boot_rom.hex")

_RUN_CVA6 = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"


def _write_rom_hex_at_import(program: list[int], path: Path) -> None:
    """Eagerly write the hex file at module-import time.

    Cocotb imports this module before the simulator starts, which is the
    only window where the `$readmemh` in the TB's `initial` block can
    actually find the file (the test function runs after sim time 0).
    """
    rom_words = (len(program) + 1) // 2
    lines = []
    for i in range(rom_words):
        lo = program[2 * i] if 2 * i < len(program) else 0
        hi = program[2 * i + 1] if 2 * i + 1 < len(program) else 0
        lines.append(f"{(hi << 32) | lo:016x}\n")
    path.write_text("".join(lines))


# RV64I encodings for the 4-instruction program.
#   addi x1, x0, 1   -> 0x00100093
#   addi x2, x0, 2   -> 0x00200113
#   add  x3, x1, x2  -> 0x002081b3
#   jal  x0, 0       -> 0x0000006f  (j .)
PROGRAM = [
    0x00100093,
    0x00200113,
    0x002081B3,
    0x0000006F,
]

BOOT_ADDR = 0x0000_0000_0001_0000


# Write the boot-ROM hex file at module import time so the TB's initial
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


def _packed_word(value: int, idx: int, width: int) -> int:
    return (value >> (idx * width)) & ((1 << width) - 1)


async def _assert_rom_preloaded(dut, program: list[int]) -> None:
    """Check that the `$readmemh` preload populated the boot ROM.

    The TB's `initial` block runs at time 0 *after* cocotb's first Python
    callback, so the assertion is taken after one rising edge to let the
    initial-time `$readmemh` complete.  The TB exposes flat-port mirrors
    of the first three ROM words because Verilator does not always
    surface every element of an unpacked logic array via cocotb's GPI.
    """
    await RisingEdge(dut.clk)
    expected_w0 = _expected_word(program, 0)
    expected_w1 = _expected_word(program, 1)
    got_w0 = int(dut.boot_rom_word0_o.value)
    got_w1 = int(dut.boot_rom_word1_o.value)
    assert got_w0 == expected_w0, (
        f"boot_rom[0] preload failed: expected 0x{expected_w0:016x}, "
        f"got 0x{got_w0:016x}.  Verify the cocotb-side hex-file write "
        f"ran before sim start and the TB's $readmemh path is correct."
    )
    assert got_w1 == expected_w1, (
        f"boot_rom[1] preload failed: expected 0x{expected_w1:016x}, got 0x{got_w1:016x}."
    )


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_starts_fetching(dut):
    """CVA6 issues at least one AR handshake against the boot ROM.

    Pass criteria:
      - After reset deassertion and a bounded number of cycles, the TB's
        `ar_xfer_count_o` reaches at least 1.  This proves the wrapper
        elaborated and CVA6 came out of reset and issued a fetch.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _assert_rom_preloaded(dut, PROGRAM)
    await reset(dut)

    # Allow CVA6's reset sequencer + fetch pipeline to start.  The cv64a6
    # configuration takes a handful of cycles to release the frontend.
    for _ in range(2048):
        await RisingEdge(dut.clk)
        if int(dut.ar_xfer_count_o.value) >= 1:
            break

    assert int(dut.ar_xfer_count_o.value) >= 1, (
        "CVA6 wrapper never issued an AR handshake — the core did not "
        "begin fetching after reset.  Check the boot vector and the "
        "wrapper-to-CVA6 NoC adapter."
    )


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_executes_four_instructions(dut):
    """RVFI proof CVA6 retires the 4-instruction program.

    Pass criteria:
      - The 4-instruction program is preloaded into the boot ROM.
      - After reset deassertion CVA6 retires the first four instructions
        through the wrapper's decoded RVFI stream.
      - The first four retired PCs/instructions match the boot ROM prefix
        and none of those retirements trap.
      - At least one AXI read beat was observed as a memory-side sanity
        check that the TB ROM actually served the instruction stream.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _assert_rom_preloaded(dut, PROGRAM)
    await reset(dut)

    # Let CVA6 fetch and commit from the ROM.  The unit TB increments
    # rvfi_retire_count_o only when the decoded CVA6 RVFI stream asserts
    # valid, so this is a commit-visible proof rather than an AXI-only
    # structural surrogate.
    for _ in range(8192):
        await RisingEdge(dut.clk)
        if int(dut.rvfi_retire_count_o.value) >= len(PROGRAM):
            break

    retire_count = int(dut.rvfi_retire_count_o.value)
    assert retire_count >= len(PROGRAM), (
        f"CVA6 retired {retire_count} instructions via RVFI, expected at "
        f"least {len(PROGRAM)}.  This blocks precise bootrom retirement "
        "evidence; inspect the E1_RVFI compile define and cva6_rvfi decode path."
    )

    assert int(dut.r_xfer_count_o.value) >= 1, (
        "CVA6 wrapper never received an R-channel beat — the TB memory "
        "model did not respond to the wrapper's AR handshake."
    )

    assert int(dut.ar_xfer_count_o.value) >= 1, (
        "CVA6 frontend stalled after the first fetch — expected at "
        "least one AR handshake to advance after the program is loaded."
    )

    first4_insn = int(dut.rvfi_first4_insn_o.value)
    first4_pc = int(dut.rvfi_first4_pc_o.value)
    first4_trap = int(dut.rvfi_first4_trap_o.value)

    for idx, expected_insn in enumerate(PROGRAM):
        got_insn = _packed_word(first4_insn, idx, 32)
        got_pc = _packed_word(first4_pc, idx, 64)
        got_trap = (first4_trap >> idx) & 1
        expected_pc = BOOT_ADDR + idx * 4
        assert got_insn == expected_insn, (
            f"RVFI retired instruction {idx} mismatch: expected "
            f"0x{expected_insn:08x}, got 0x{got_insn:08x}."
        )
        assert got_pc == expected_pc, (
            f"RVFI retired PC {idx} mismatch: expected 0x{expected_pc:016x}, "
            f"got 0x{got_pc:016x}."
        )
        assert got_trap == 0, f"RVFI retired instruction {idx} with trap=1."

"""CVA6 boots inside `e1_soc_integrated` through the slot-0 fabric path.

This test is the in-band SoC-integration counterpart to the standalone
`test_cva6_executes_bootrom_program.py` / `test_cva6_dram_read_write.py`
suite under the dedicated `e1_cva6_unit_tb`.  It runs against the
integrated SoC top (`e1_soc_integrated_tb`) compiled with
`+define+E1_HAVE_CVA6 +define+E1_CLUSTER_SLOT0_CVA6 +define+WT_DCACHE`,
which instantiates the OpenHW Group CVA6 v5.3.0 wrapper as
`u_soc.u_cva6_slot0` and routes its 64-bit AXI4 master through
`e1_axi4_width_converter` to 128-bit fabric master[2], then through
`e1_axi4_interconnect` and `e1_dram_ctrl`.

Pass criteria (the in-band counterpart of the four standalone tests):

  1. The shared DRAM controller preload file is written at module-import
     time and passed via `+E1_DRAM_PRELOAD_HEX=boot_rom.hex`; the SoC also
     mirrors the first words so the test can assert the expected 128-bit pack
     before reset release.
  2. After reset deassertion CVA6 issues at least one AR handshake at
     the 128-bit fabric-facing side of the width converter.  This proves
     the wrapper-to-fabric-to-DRAM path is alive.
  3. CVA6 retires the 8-instruction store/load program: at least one
     full AW + W + B handshake reaches the shared DRAM controller
     (the store) and at least two AR handshakes (initial fetch + the
     load instruction's DRAM read).

The R7 standalone CVA6 fix uncovered three landmines that all carry
forward to the in-band SoC path (see
`docs/evidence/integration/cross-domain-interfaces.yaml::cluster_to_fabric`
for the full record):

  - Boot vector must sit inside CVA6's cv64a6 executable PMA windows
    (`[0, 0x1000), [0x1_0000, 0x2_0000), [0x8000_0000, 0xC000_0000)`).
    The integrated SoC vector previously defaulted to `0x8000_0000`,
    which is executable but has no real ROM behind it.  The in-band SoC proof
    now uses the executable DRAM window at `0x8000_0000`
    and preloads `e1_dram_ctrl` through `+E1_DRAM_PRELOAD_HEX`.
  - The DRAM preload uses `$readmemh` (cocotb-side Verilator GPI cannot
    write every element of a sparse backing store).  The cocotb test writes
    `boot_rom.hex` at import time.
  - The LUI encoding in the store/load program is `0xCAFEC0B7`
    (lui x1, 0xCAFEC), not the historical typo.

The integrated path uses 128-bit beats (fabric-facing side of the width
converter) so the preload hex file packs four RV32 words per line.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

_BOOT_ROM_HEX = Path("boot_rom.hex")

# Gate driven by the SoC Makefile; mirrors the standalone test's contract.
_RUN_CVA6 = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"

# Eight-instruction RV64I program: lui/addi build the 0xCAFEBABE payload,
# lui/slli/addi build the positive DRAM address 0x8000_0080 (outside the
# preloaded instruction lines), sd stores, ld reloads, j spins.
PROGRAM = [
    0xCAFEC0B7,  # lui  x1, 0xCAFEC
    0xABE08093,  # addi x1, x1, -1346
    0x40000137,  # lui  x2, 0x40000
    0x00111113,  # slli x2, x2, 1      -> x2 = 0x8000_0000
    0x08010113,  # addi x2, x2, 128    -> x2 = 0x8000_0080
    0x00113023,  # sd   x1, 0(x2)
    0x00013183,  # ld   x3, 0(x2)
    0x0000006F,  # jal  x0, 0 (j .)
]


def _write_rom_hex_at_import(program: list[int], path: Path) -> None:
    """Write a 128-bit-per-line hex file for the shared DRAM preload.

    `$readmemh` reads one entry per line; `e1_dram_ctrl` consumes one
    128-bit fabric beat per line through `+E1_DRAM_PRELOAD_HEX`.  Each
    line packs four RV32 words: line `i` carries `program[4i .. 4i+3]`,
    where `program[4i]` is the low 32 bits and `program[4i+3]` is the
    high 32 bits.  Missing trailing entries are zero-filled (acceptable
    because the spin-loop branch at PC `0x1c` makes any execution past
    it unreachable in this test).
    """
    words_per_line = 4
    n_lines = (len(program) + words_per_line - 1) // words_per_line
    lines: list[str] = []
    for i in range(n_lines):
        packed = 0
        for j in range(words_per_line):
            idx = i * words_per_line + j
            if idx < len(program):
                packed |= program[idx] << (j * 32)
        lines.append(f"{packed:032x}\n")
    path.write_text("".join(lines))


# Write the preload hex file at import time so the SoC's initial-block
# `$readmemh` calls pick up the payload before simulation time 0.
_write_rom_hex_at_import(PROGRAM, _BOOT_ROM_HEX)


def _expected_rom_word_128(program: list[int], line_idx: int) -> int:
    """Return the expected 128-bit preload word at `line_idx`."""
    words_per_line = 4
    packed = 0
    for j in range(words_per_line):
        idx = line_idx * words_per_line + j
        if idx < len(program):
            packed |= program[idx] << (j * 32)
    return packed


async def _reset(dut, cycles: int = 16) -> None:
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    dut.lkp_valid_i.value = 0
    dut.lkp_pc_i.value = 0
    dut.resolve_i.value = 0
    dut.fetch_pop_i.value = 0
    dut.fetch_stream_ready_i.value = 1
    dut.zihpm_csr_we_i.value = 0
    dut.zihpm_csr_addr_i.value = 0
    dut.zihpm_csr_wdata_i.value = 0
    dut.zihpm_csr_raddr_i.value = 0
    dut.zihpm_instret_pulse_i.value = 0
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _assert_slot0_rom_preloaded(dut, program: list[int]) -> None:
    """After one rising edge, the SoC preload mirror `$readmemh` has run.

    The actual program fetch is served by `e1_dram_ctrl` through the AXI4
    fabric.  The SoC top also re-exports the first three 128-bit preload
    words via flat ports because cocotb GPI does not surface the sparse DRAM
    backing store directly.  A missing or zero hex file fails loudly here
    rather than letting CVA6 run against all-zero DRAM.
    """
    await RisingEdge(dut.clk)
    expected_w0 = _expected_rom_word_128(program, 0)
    expected_w1 = _expected_rom_word_128(program, 1)
    got_w0 = int(dut.cva6_slot0_rom_word0_o.value)
    got_w1 = int(dut.cva6_slot0_rom_word1_o.value)
    assert got_w0 == expected_w0, (
        f"DRAM preload mirror[0] failed: expected 0x{expected_w0:032x}, "
        f"got 0x{got_w0:032x}.  Verify the cocotb-side hex write ran "
        f"before sim start and the SoC top's E1_DRAM_PRELOAD_HEX path matches "
        f"`boot_rom.hex`."
    )
    assert got_w1 == expected_w1, (
        f"DRAM preload mirror[1] failed: expected 0x{expected_w1:032x}, got 0x{got_w1:032x}."
    )


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_boots_through_soc_slot0(dut):
    """CVA6 fetches code from shared DRAM through the SoC fabric.

    Pass criteria:
      - The DRAM preload mirror matches the boot program.
      - After reset deassertion, the downstream-side AR counter
        (`cva6_slot0_ar_xfers_o`) reaches at least one within a bounded
        cycle budget — CVA6 emitted an AR through the wrapper → adapter
        → width converter → AXI4 fabric and e1_dram_ctrl accepted it.
      - The downstream-side R counter reaches at least one — the memory
        returned a beat back through the same path.

    The bound mirrors the standalone bootrom test (≤ 4096 cycles for the
    first R beat).  The integrated path has the same single-master
    single-inflight contract, so the upper bound carries over.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _assert_slot0_rom_preloaded(dut, PROGRAM)
    await _reset(dut)

    # Allow CVA6's reset sequencer + fetch pipeline to start.  The cv64a6
    # frontend issues a full 64-byte cache-line burst (8 beats of 64-bit
    # at the upstream port = 4 beats of 128-bit downstream); the width
    # converter is single-inflight so one AR handshake covers the line.
    for _ in range(4096):
        await RisingEdge(dut.clk)
        if int(dut.cva6_slot0_ar_xfers_o.value) >= 1:
            break

    assert int(dut.cva6_slot0_ar_xfers_o.value) >= 1, (
        "CVA6 in-band slot-0 wrapper never issued an AR handshake at the "
        "128-bit fabric-facing side.  The wrapper-to-adapter-to-converter-"
        "to-fabric-to-DRAM path did not propagate the fetch.  Check the "
        "`E1_CLUSTER_SLOT0_CVA6` define is set, the boot vector is in "
        "an executable CVA6 PMA window, and the DRAM controller's "
        "ar_ready is alive."
    )

    # Continue to let CVA6 receive at least one R beat (proves the memory
    # model wrote the read-data back into the converter, which in turn
    # forwards a beat back to CVA6).
    for _ in range(1024):
        await RisingEdge(dut.clk)
        if int(dut.cva6_slot0_r_xfers_o.value) >= 1:
            break

    assert int(dut.cva6_slot0_r_xfers_o.value) >= 1, (
        "CVA6 issued AR but e1_dram_ctrl never returned an R beat "
        "— check the fabric master[2] route and DRAM read-data path."
    )


@cocotb.test(skip=not _RUN_CVA6)
async def test_cva6_executes_store_load_in_soc(dut):
    """CVA6 retires the 8-instruction store/load program through the SoC.

    Same structural proof as the standalone `test_cva6_dram_store` +
    `test_cva6_dram_load` combo, lifted to the in-band SoC path.  Pass
    criteria mirror the standalone counts exactly:
      - ≥ 1 AW handshake reaches the 128-bit downstream side (the SD
        instruction emitted a write).
      - ≥ 1 W handshake follows (the write data beat).
      - ≥ 1 B handshake completes (e1_dram_ctrl acknowledged the
        store).
      - ≥ 2 AR handshakes (initial fetch line + the LD instruction's
        DRAM read).
      - ≥ 2 R beats (each AR returned at least one beat).

    The cycle budget is generous (≤ 12288 cycles) to match the standalone
    `test_cva6_dram_load`.  The in-band path adds the width converter,
    AXI4 fabric arbitration, and e1_dram_ctrl scheduler relative to the
    standalone TB, so the timing margin stays bounded but intentionally
    generous.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _assert_slot0_rom_preloaded(dut, PROGRAM)
    await _reset(dut)

    # Run long enough for the address-build/store/load chain to retire and the
    # store + load AXI traffic to land on the shared DRAM controller.
    for _ in range(12288):
        await RisingEdge(dut.clk)
        if int(dut.cva6_slot0_b_xfers_o.value) >= 1 and int(dut.cva6_slot0_ar_xfers_o.value) >= 2:
            break

    assert int(dut.cva6_slot0_aw_xfers_o.value) >= 1, (
        "CVA6 never issued an AW handshake on the fabric-facing slot-0 net "
        "— the SD instruction did not reach the shared fabric.  Either "
        "the program never executed past the lui/addi chain (PMA or "
        "fetch issue) or the width converter's AW path stalled."
    )
    assert int(dut.cva6_slot0_w_xfers_o.value) >= 1, (
        "CVA6 issued AW but no W beat reached the shared fabric — the "
        "write-data path through the width converter is stalled."
    )
    assert int(dut.cva6_slot0_b_xfers_o.value) >= 1, (
        "CVA6 issued AW + W but e1_dram_ctrl never returned a B response "
        "— check fabric master[2] routing and DRAM write-response handling."
    )
    assert int(dut.cva6_slot0_ar_xfers_o.value) >= 2, (
        f"Expected at least 2 AR handshakes on the downstream slot-0 net "
        f"(initial fetch line + LD), saw "
        f"{int(dut.cva6_slot0_ar_xfers_o.value)}.  CVA6 did not complete "
        f"the load instruction."
    )
    assert int(dut.cva6_slot0_r_xfers_o.value) >= 2, (
        f"Expected at least 2 R beats, saw {int(dut.cva6_slot0_r_xfers_o.value)}."
    )

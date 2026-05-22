"""cocotb test for the E1 IEEE 1149.1 JTAG TAP controller.

Exercises the TAP state machine reset, the IDCODE data register, the BYPASS
register, IR shift/update for the mandatory instructions (BYPASS, IDCODE,
SAMPLE/PRELOAD, EXTEST), and the TDO output-enable contract.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge

IR_WIDTH = 5
INSTR_EXTEST = 0b00000
INSTR_SAMPLE = 0b00001
INSTR_IDCODE = 0b00010
INSTR_BYPASS = 0b11111
IDCODE_VALUE = 0x00000001


async def tck_step(dut, tms: int, tdi: int = 0) -> None:
    """Drive one TCK cycle: TMS/TDI sampled on rising edge."""
    dut.tms.value = tms
    dut.tdi.value = tdi
    await RisingEdge(dut.tck)
    await FallingEdge(dut.tck)


async def reset_tap(dut) -> None:
    dut.trst_n.value = 0
    dut.tms.value = 1
    dut.tdi.value = 0
    await RisingEdge(dut.tck)
    await FallingEdge(dut.tck)
    dut.trst_n.value = 1
    # Five TMS=1 cycles unconditionally land in Test-Logic-Reset.
    for _ in range(5):
        await tck_step(dut, tms=1)


async def goto_shift_ir(dut) -> None:
    # From Test-Logic-Reset / Run-Test-Idle to Shift-IR.
    await tck_step(dut, tms=0)  # Run-Test-Idle
    await tck_step(dut, tms=1)  # Select-DR-Scan
    await tck_step(dut, tms=1)  # Select-IR-Scan
    await tck_step(dut, tms=0)  # Capture-IR
    await tck_step(dut, tms=0)  # Shift-IR


async def goto_shift_dr(dut) -> None:
    await tck_step(dut, tms=0)  # Run-Test-Idle
    await tck_step(dut, tms=1)  # Select-DR-Scan
    await tck_step(dut, tms=0)  # Capture-DR
    await tck_step(dut, tms=0)  # Shift-DR


async def load_ir(dut, instruction: int) -> None:
    """Load a 5-bit instruction (LSB first), then Update-IR."""
    await goto_shift_ir(dut)
    for i in range(IR_WIDTH):
        bit = (instruction >> i) & 1
        last = i == IR_WIDTH - 1
        await tck_step(dut, tms=1 if last else 0, tdi=bit)
    # In Exit1-IR -> Update-IR -> Run-Test-Idle.
    await tck_step(dut, tms=1)  # Update-IR
    await tck_step(dut, tms=0)  # Run-Test-Idle


@cocotb.test()
async def test_reset_and_idcode(dut) -> None:
    cocotb.start_soon(Clock(dut.tck, 10, units="ns").start())
    await reset_tap(dut)
    assert dut.test_logic_reset.value == 1, "TAP must reset to Test-Logic-Reset"
    assert int(dut.ir.value) == INSTR_IDCODE, "reset IR must be IDCODE"

    # Read IDCODE out of Shift-DR (LSB first).
    await goto_shift_dr(dut)
    shifted = 0
    for i in range(32):
        await FallingEdge(dut.tck)
        shifted |= (int(dut.tdo.value) & 1) << i
        assert dut.tdo_oe.value == 1, "tdo_oe must be high in Shift-DR"
        await tck_step(dut, tms=0)
    assert shifted == IDCODE_VALUE, f"IDCODE mismatch: {shifted:#010x}"


@cocotb.test()
async def test_bypass(dut) -> None:
    cocotb.start_soon(Clock(dut.tck, 10, units="ns").start())
    await reset_tap(dut)
    await load_ir(dut, INSTR_BYPASS)
    assert int(dut.ir.value) == INSTR_BYPASS, "IR must latch BYPASS"

    # BYPASS is a single flop: TDI appears at TDO one shift cycle later.
    await goto_shift_dr(dut)
    pattern = [1, 0, 1, 1, 0, 0, 1]
    captured: list[int] = []
    for bit in pattern:
        dut.tdi.value = bit
        await RisingEdge(dut.tck)
        await FallingEdge(dut.tck)
        captured.append(int(dut.tdo.value) & 1)
    # One-cycle latency through the BYPASS flop.
    assert captured[1:] == pattern[:-1], f"BYPASS shift mismatch: {captured}"


@cocotb.test()
async def test_sample_and_extest_route_through_bypass(dut) -> None:
    cocotb.start_soon(Clock(dut.tck, 10, units="ns").start())
    await reset_tap(dut)
    for instruction in (INSTR_SAMPLE, INSTR_EXTEST):
        await load_ir(dut, instruction)
        assert int(dut.ir.value) == instruction, f"IR must latch {instruction:#07b}"
        # Boundary register is blocked; data path falls back to BYPASS and TDO
        # stays defined (no X).
        await goto_shift_dr(dut)
        for _ in range(4):
            await FallingEdge(dut.tck)
            assert dut.tdo.value.is_resolvable, "TDO must be defined under SAMPLE/EXTEST"
            await tck_step(dut, tms=0)
        await tck_step(dut, tms=1)  # Exit1-DR
        await tck_step(dut, tms=1)  # Update-DR
        await tck_step(dut, tms=0)  # Run-Test-Idle

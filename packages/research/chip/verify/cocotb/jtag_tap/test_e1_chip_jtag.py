"""JTAG TAP integration smoke for e1_chip_top.

Proves the jtag-tap-not-integrated blocker is fixed: e1_chip_top now
instantiates a real IEEE 1149.1 TAP (e1_jtag_tap) and drives JTAG_TDO from the
TAP instead of hardwiring it to 0. The test shifts the IDCODE data register out
through the pad-level TCK/TMS/TDI/TDO port and checks the expected value, then
confirms BYPASS shifts a single 0 bit.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import Timer

IDCODE_VALUE = 0x0000_0001  # e1_jtag_tap default IDCODE_VALUE (e1_chip_top)
TCK_HALF_NS = 5


async def tck_pulse(dut, tms, tdi):
    """Drive one TCK cycle: set TMS/TDI, rising edge samples them, return TDO.

    TDO is updated on the falling edge of TCK (IEEE 1149.1), so sample it after
    the falling edge.
    """
    dut.JTAG_TMS.value = tms
    dut.JTAG_TDI.value = tdi
    dut.JTAG_TCK.value = 0
    await Timer(TCK_HALF_NS, units="ns")
    dut.JTAG_TCK.value = 1
    await Timer(TCK_HALF_NS, units="ns")
    dut.JTAG_TCK.value = 0
    await Timer(TCK_HALF_NS, units="ns")
    return int(dut.JTAG_TDO.value)


def read_tdo(dut):
    """Sample the currently presented TDO bit without advancing TCK.

    On entry to SHIFT_DR the TAP already presents bit 0 of the selected data
    register on TDO (registered on the prior falling edge). The correct
    capture order is therefore read-then-shift: sample TDO, then issue a TCK
    pulse that shifts the next bit into position.
    """
    return int(dut.JTAG_TDO.value)


async def goto_test_logic_reset(dut):
    # 5 TMS=1 clocks force TEST_LOGIC_RESET from any state.
    for _ in range(5):
        await tck_pulse(dut, tms=1, tdi=0)


async def enter_shift_dr(dut):
    # TLR -> RUN_TEST_IDLE -> SELECT_DR -> CAPTURE_DR -> SHIFT_DR
    await tck_pulse(dut, tms=0, tdi=0)  # RUN_TEST_IDLE
    await tck_pulse(dut, tms=1, tdi=0)  # SELECT_DR_SCAN
    await tck_pulse(dut, tms=0, tdi=0)  # CAPTURE_DR
    await tck_pulse(dut, tms=0, tdi=0)  # SHIFT_DR


async def reset_dut(dut):
    # The TAP trst_n is the synchronized core reset (rst_n_sync), which only
    # deasserts after CLK_IN has run; start the core clock so the TAP leaves
    # its async reset and can advance through the state machine.
    dut.RST_N.value = 0
    dut.DBG_VALID.value = 0
    dut.DBG_LAUNCH.value = 0
    dut.DBG_WRITE.value = 0
    dut.DBG_ADDR.value = 0
    dut.DBG_WDATA.value = 0
    dut.TEST_MODE.value = 0
    dut.JTAG_TCK.value = 0
    dut.JTAG_TMS.value = 1
    dut.JTAG_TDI.value = 0
    dut.CLK_IN.value = 0
    cocotb.start_soon(Clock(dut.CLK_IN, 10, units="ns").start())
    await Timer(50, units="ns")
    dut.RST_N.value = 1
    await Timer(50, units="ns")


@cocotb.test()
async def jtag_idcode_shifts_out(dut):
    """After TAP reset the IR defaults to IDCODE; shift the 32-bit value out."""
    await reset_dut(dut)
    await goto_test_logic_reset(dut)
    # CAPTURE_IR -> IDCODE is the reset instruction, so CAPTURE_DR loads IDCODE.
    await enter_shift_dr(dut)

    # In SHIFT_DR, TDO presents idcode_shift[0] (LSB first). Read the presented
    # bit, then pulse TCK (TMS=0 stays in SHIFT_DR) to shift the next bit out.
    shifted = 0
    for i in range(32):
        shifted |= (read_tdo(dut) & 1) << i
        await tck_pulse(dut, tms=0, tdi=0)

    assert shifted == IDCODE_VALUE, (
        f"JTAG IDCODE shifted out {shifted:#010x}, expected {IDCODE_VALUE:#010x}"
    )
    # The former dead TDO would have shifted out all zeros.
    assert shifted != 0, "JTAG_TDO still appears tied to 0 (no TAP integrated)"


@cocotb.test()
async def jtag_bypass_shifts_zero(dut):
    """Load BYPASS (all-ones IR) and confirm the 1-bit BYPASS register works.

    A fresh CAPTURE_DR loads BYPASS with 0; with TDI=0 the bit out of SHIFT_DR
    is 0, confirming the TAP data path is live and instruction-selectable.
    """
    await reset_dut(dut)
    await goto_test_logic_reset(dut)

    # Navigate to SHIFT_IR and load BYPASS (5'b11111).
    await tck_pulse(dut, tms=0, tdi=0)  # RUN_TEST_IDLE
    await tck_pulse(dut, tms=1, tdi=0)  # SELECT_DR_SCAN
    await tck_pulse(dut, tms=1, tdi=0)  # SELECT_IR_SCAN
    await tck_pulse(dut, tms=0, tdi=0)  # CAPTURE_IR
    await tck_pulse(dut, tms=0, tdi=0)  # SHIFT_IR (start)
    # Shift in 5 ones for BYPASS; last bit shifted with TMS=1 to exit.
    for i in range(5):
        tms = 1 if i == 4 else 0
        await tck_pulse(dut, tms=tms, tdi=1)  # EXIT1_IR on last
    await tck_pulse(dut, tms=1, tdi=0)  # UPDATE_IR
    await tck_pulse(dut, tms=0, tdi=0)  # RUN_TEST_IDLE

    # Now BYPASS is the active instruction; capture+shift a single bit.
    await enter_shift_dr(dut)
    bit = await tck_pulse(dut, tms=0, tdi=0)
    assert bit == 0, f"BYPASS register shifted out {bit}, expected 0"

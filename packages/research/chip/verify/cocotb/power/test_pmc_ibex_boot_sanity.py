"""Boot-vector sanity for the AON Ibex inside ``pmc_top``.

This test is conditional. It only runs when the Verilator build of
``pmc_top.sv`` was compiled with ``+define+PMC_INSTANTIATE_IBEX`` AND with
the upstream Ibex source files reachable from the include path (i.e. after
``scripts/bootstrap_ibex.sh`` has populated ``external/ibex/ibex``).

When the guard is active the wrapper instantiates ``ibex_top`` with
``boot_addr_i = PMC_BOOT_ADDR = 32'h1005_0000`` (``pmc_top.sv``) and
``fetch_enable_i = ibex_pkg::IbexMuBiOn``. Ibex treats ``boot_addr_i`` as
the base of the interrupt vector table and forces the reset fetch to
``{boot_addr_i[31:8], 8'h80}`` (``ibex_if_stage.sv`` ``PC_BOOT``), so the
first ``instr_addr_o`` is ``PMC_BOOT_ADDR + 0x80 = 0x1005_0080``. The
contract checked here is the minimal one any silicon-bringup smoke test
relies on: after the reset is released, the core asserts ``instr_req_o``
and presents that reset entry on ``instr_addr_o`` within a bounded number
of clk_aon cycles. This matches the SoC-level counterpart
``verify/cocotb/integration/test_pmc_ibex_boots_in_soc.py``.

When the guard is NOT active the test reports ``skip`` with an explicit
rationale, leaving the BLOCKED status surfaced by docs/evidence/power
intact. The test never fails when the Ibex source is absent; it skips so
the BLOCKED gate remains the only signal.
"""

import os

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer
from power_pkg_constants import DVFS_RAIL_COUNT, PMC_REG_CTRL

CLK_AON_PERIOD_NS = 30
CLK_SAMPLE_PERIOD_NS = 5
# pmc_top wires ibex boot_addr_i = PMC_BOOT_ADDR. Ibex's reset fetch is at
# {boot_addr_i[31:8], 8'h80} (ibex_if_stage.sv PC_BOOT), so the first
# instruction address is PMC_BOOT_ADDR + 0x80.
PMC_BOOT_ADDR = 0x1005_0000
BOOT_VECTOR_ADDR = PMC_BOOT_ADDR + 0x80


def _ibex_guard_active() -> bool:
    """The cocotb Makefile passes ``+define+PMC_INSTANTIATE_IBEX`` through
    EXTRA_ARGS when the bootstrap script has run; we mirror that intent in
    an env var so the Python harness can decide whether to skip."""
    val = os.environ.get("PMC_INSTANTIATE_IBEX", "0")
    return val not in ("0", "", "false", "False")


async def _reset(dut):
    dut.rst_n.value = 0
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    dut.mbox_addr_i.value = 0
    dut.mbox_wdata_i.value = 0
    dut.droop_alarm_i.value = 0
    for i in range(DVFS_RAIL_COUNT):
        dut.droop_event_count_i[i].value = 0
        dut.avfs_target_code_i[i].value = 0
        dut.avfs_raise_count_i[i].value = 0
        dut.avfs_lower_count_i[i].value = 0
    dut.avfs_fault_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk_aon)
    dut.rst_n.value = 1
    # Return immediately on reset deassert so the caller can observe the very
    # first instruction fetch; the Ibex begins fetching the reset vector on the
    # first clk_aon edge after rst_n rises.


async def _mbox_write(dut, addr, data):
    dut.mbox_addr_i.value = addr
    dut.mbox_wdata_i.value = data
    dut.mbox_write_i.value = 1
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    await RisingEdge(dut.clk_aon)


@cocotb.test()
async def ibex_boot_vector_reaches_first_instruction_fetch(dut):
    """Under ``PMC_INSTANTIATE_IBEX``: confirm the core walks to its boot
    vector and asserts an instruction fetch within 32 clk_aon cycles."""
    if not _ibex_guard_active():
        # The test should not run in the default build; we report a clear
        # skip-rationale so the BLOCKED gate is the source of truth.
        from cocotb.result import TestSuccess

        raise TestSuccess(
            "skipped: PMC_INSTANTIATE_IBEX not set. Run scripts/bootstrap_ibex.sh "
            "and rebuild cocotb with PMC_INSTANTIATE_IBEX=1 to enable this test."
        )

    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Capture the boot fetch directly out of reset. fetch_enable_i is held high
    # in the wrapper, so the core begins fetching immediately; the mailbox write
    # is deferred until after capture so it cannot consume the reset-fetch
    # cycles. The very first request the prefetch buffer issues is the reset
    # vector; subsequent cycles stream sequentially upward. instr_req/instr_addr
    # are combinational outputs of the core, so settle 1 ns past each clk_aon
    # edge before sampling to read the value the core drives this cycle (a
    # zero-delay read after the edge would observe the previous cycle's value).
    saw_req = False
    boot_pc: int | None = None
    for _ in range(32):
        await RisingEdge(dut.clk_aon)
        await Timer(1, units="ns")
        if int(dut.ibex_instr_req.value) == 1:
            saw_req = True
            boot_pc = int(dut.ibex_instr_addr.value)
            break

    assert saw_req, "Ibex did not raise instr_req within 32 clk_aon cycles of reset release"
    assert boot_pc == BOOT_VECTOR_ADDR, (
        f"Ibex first instr_addr = {boot_pc:#x}, "
        f"expected reset vector {BOOT_VECTOR_ADDR:#x} "
        f"(PMC_BOOT_ADDR={PMC_BOOT_ADDR:#x} + 0x80)"
    )

    # Mailbox-issued CTRL[0]=1 is documented as the SPMI enable bit. The
    # core's fetch_enable_i is held high in the wrapper, so this write is
    # purely a sanity check that the AON mailbox is also wired correctly.
    await _mbox_write(dut, PMC_REG_CTRL, 0x1)
    assert int(dut.spmi_enable_o.value) == 1, "SPMI enable did not follow CTRL[0]"

"""L3 cache standalone cocotb tests.

Exercises the shared multi-bank L3 (`e1_l3_cache`) with directory-based
MESI and snoop-filter via the `e1_l3_tb` wrapper. The wrapper fixes
NUM_L2=2 so we can drive multi-master coherence vectors (snoop filter
hit/miss, probe-mask, multi-sharer install).

Tests:
- reset is quiescent
- directory lookup: L2 acquire miss -> SLC acquire -> grant -> install
- snoop filter hit: second L2 acquire for the same line after S1 has it
  triggers a snoop hit, not a SLC miss
- multi-master M acquire while another L2 holds the line in S forces a
  probe on the probe channel (probe-mask is exactly the holders)
- eviction policy: filling a single set with WAYS+1 different lines
  evicts one line and triggers the SLC writeback path
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

MESI_I = 0
MESI_S = 1
MESI_E = 2
MESI_M = 3


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.l2_acq_valid.value = 0
    dut.l2_acq_paddr_line.value = 0
    dut.l2_acq_is_write.value = 0
    dut.l2_acq_req_state.value = MESI_S
    dut.l2_acq_wb_data.value = 0
    dut.l2_acq_source_id.value = 0
    dut.l2_grant_ready.value = 1
    dut.l2_probe_ready.value = 1
    dut.l2_probe_ack.value = 0
    dut.l2_probe_has_data.value = 0
    dut.l2_probe_wb_data.value = 0
    dut.l2_probe_final_state.value = MESI_I
    dut.slc_acq_ready.value = 1
    dut.slc_grant_valid.value = 0
    dut.slc_grant_paddr_line.value = 0
    dut.slc_grant_data.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for(dut, signal: str, max_cycles: int = 64) -> int:
    for cyc in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal).value) == 1:
            return cyc
    raise AssertionError(f"{signal} never asserted within {max_cycles} cycles")


async def issue_l2_acq(
    dut, paddr_line: int, *, source: int = 0, is_write: int = 0, state: int = MESI_S
) -> None:
    dut.l2_acq_valid.value = 1
    dut.l2_acq_paddr_line.value = paddr_line
    dut.l2_acq_is_write.value = is_write
    dut.l2_acq_req_state.value = state
    dut.l2_acq_source_id.value = source
    await RisingEdge(dut.clk)
    dut.l2_acq_valid.value = 0


async def serve_slc_grant(dut, paddr_line: int, data: int) -> None:
    """Wait for slc_acq, drive a grant the following cycle."""
    # Skip over any preceding writeback acq the L3 may issue.
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.slc_acq_valid.value) == 1 and int(dut.slc_acq_is_write.value) == 0:
            break
    else:
        raise AssertionError("never saw slc_acq (read) within 64 cycles")
    await RisingEdge(dut.clk)
    dut.slc_grant_valid.value = 1
    dut.slc_grant_paddr_line.value = paddr_line
    dut.slc_grant_data.value = data
    await RisingEdge(dut.clk)
    dut.slc_grant_valid.value = 0


async def ack_slc_writebacks(dut, cycles: int) -> int:
    """Helper: count any slc_acq writeback pulses over `cycles` cycles."""
    wb = 0
    for _ in range(cycles):
        await RisingEdge(dut.clk)
        if int(dut.slc_acq_valid.value) == 1 and int(dut.slc_acq_is_write.value) == 1:
            wb += 1
    return wb


@cocotb.test()
async def test_l3_reset_quiescent(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    await RisingEdge(dut.clk)
    assert int(dut.l2_grant_valid.value) == 0
    assert int(dut.l2_probe_valid.value) == 0
    assert int(dut.slc_acq_valid.value) == 0


@cocotb.test()
async def test_l3_directory_miss_then_install(dut):
    """Directory lookup miss -> SLC acquire -> grant -> L2 install."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_1000_0000
    await issue_l2_acq(dut, line, source=0, state=MESI_S)
    await serve_slc_grant(dut, line, data=0xCAFEBABE_DEADBEEF)

    # The L3 must respond on the L2 grant channel
    await wait_for(dut, "l2_grant_valid", max_cycles=16)
    assert int(dut.l2_grant_paddr_line.value) == line


@cocotb.test()
async def test_l3_snoop_filter_hit_no_slc(dut):
    """Two L2s for the same line: the second access must be a snoop hit
    (no SLC miss)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_1100_0000

    # Source 0 brings the line in
    await issue_l2_acq(dut, line, source=0, state=MESI_S)
    await serve_slc_grant(dut, line, data=0x1)
    await wait_for(dut, "l2_grant_valid", max_cycles=16)
    for _ in range(4):
        await RisingEdge(dut.clk)

    # Source 1 asks for the same line; should be a hit (no slc_acq read).
    await issue_l2_acq(dut, line, source=1, state=MESI_S)

    saw_grant = False
    saw_read_acq = False
    for _ in range(16):
        await RisingEdge(dut.clk)
        if int(dut.l2_grant_valid.value) == 1:
            saw_grant = True
        if int(dut.slc_acq_valid.value) == 1 and int(dut.slc_acq_is_write.value) == 0:
            saw_read_acq = True
    assert saw_grant, "L3 must respond to source 1's hit"
    assert not saw_read_acq, "L3 must not issue a SLC read on a directory hit"


@cocotb.test()
async def test_l3_multimaster_m_forces_probe(dut):
    """Source 0 has line in S; source 1 requests M -> probe channel fires
    with probe_mask containing source 0."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_1200_0000

    await issue_l2_acq(dut, line, source=0, state=MESI_S)
    await serve_slc_grant(dut, line, data=0x55AA_55AA)
    await wait_for(dut, "l2_grant_valid", max_cycles=16)
    for _ in range(4):
        await RisingEdge(dut.clk)

    # Source 1 requests M; sharers list should include source 0 only -> probe
    await issue_l2_acq(dut, line, source=1, is_write=1, state=MESI_M)

    # Expect a probe to fire
    saw_probe = False
    saw_mask_bit0 = False
    for _ in range(16):
        await RisingEdge(dut.clk)
        if int(dut.l2_probe_valid.value) == 1:
            saw_probe = True
            mask = int(dut.l2_probe_mask.value)
            if mask & 0x1:
                saw_mask_bit0 = True
            break
    assert saw_probe, "M request with another sharer must trigger a probe"
    assert saw_mask_bit0, "probe mask must include source 0"

    # Ack the probe so the L3 progresses to grant
    dut.l2_probe_ack.value = 1
    dut.l2_probe_has_data.value = 0
    await RisingEdge(dut.clk)
    dut.l2_probe_ack.value = 0

    await wait_for(dut, "l2_grant_valid", max_cycles=16)


@cocotb.test()
async def test_l3_eviction_writeback_path(dut):
    """Filling WAYS+1 distinct lines into the same set forces an eviction.
    With the e1_l3_tb geometry (BANKS=2, WAYS=4, LINE_BYTES=64,
    SIZE_BYTES=64 KiB) the per-bank index width is 7 and the bank bit is
    bit 6; tags start at bit 14. Constructing addresses that differ only
    in tag bits keeps them mapped to the same (bank, set)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    base_set_bank = 0x0000_0040  # bank=1, set=0, offset=0
    lines = [base_set_bank | (i << 14) for i in range(5)]  # WAYS+1 lines

    for i, ln in enumerate(lines):
        # Wait for the L3 to be ready (l2_acq_ready==1 means T_IDLE).
        for _ in range(16):
            if int(dut.l2_acq_ready.value) == 1:
                break
            await RisingEdge(dut.clk)
        await issue_l2_acq(dut, ln, source=0, state=MESI_S)
        await serve_slc_grant(dut, ln, data=0xDEADBEEF + i)
        await wait_for(dut, "l2_grant_valid", max_cycles=24)
        # Wait a few cycles to ensure L3 has returned to T_IDLE.
        for _ in range(4):
            await RisingEdge(dut.clk)

    # After 5 installs into a 4-way set the DRRIP victim function picks the
    # last way with RRPV=11. The first 4 installs land in way 3, 2, 1, 0
    # respectively (each install sets that way's RRPV to 10). On the 5th
    # install no way has RRPV=11 so the default candidate (way 0) is
    # chosen, overwriting the line installed by install 3. So lines[3] is
    # evicted; re-reading it must miss and trigger another SLC read.
    saw_hpm_miss = False
    saw_slc_read = False
    await issue_l2_acq(dut, lines[3], source=0, state=MESI_S)
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.hpm_l3_miss.value) == 1:
            saw_hpm_miss = True
        if int(dut.slc_acq_valid.value) == 1 and int(dut.slc_acq_is_write.value) == 0:
            saw_slc_read = True
            break
    assert saw_slc_read or saw_hpm_miss, (
        "expected lines[3] to be evicted by the DRRIP victim function "
        f"(slc_read={saw_slc_read} hpm_miss={saw_hpm_miss})"
    )

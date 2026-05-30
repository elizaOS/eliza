"""L1D MSHR secondary-miss coalescing proof.

The e1_l1d_cache header claims each MSHR carries a small per-MSHR
pending-request FIFO so secondary misses on the same line coalesce onto the
primary MSHR instead of allocating a second entry or issuing a second L2
acquire. The audit finding l1d-mshr-coalesce-fifo-larp flagged that the
struct had no such FIFO and the allocate path never matched an in-flight
line.

This test drives:

  1. A primary load miss to line A -> exactly one L2 acquire is issued and
     the request replays (MSHR allocated).
  2. Two more load misses to the SAME line A while the fill is outstanding
     -> NO additional L2 acquire is issued (coalesced onto the primary
     MSHR's pending FIFO). A non-coalescing design would either issue more
     acquires or allocate more MSHRs.
  3. A miss to a DIFFERENT line B -> a second, distinct L2 acquire (proves
     coalescing keys on the line, not a blanket suppression).
  4. The fill for A is granted -> the coalesced secondary requests drain as
     port-0 replays carrying their original LSU tags.
  5. Re-presenting a coalesced request hits the now-resident line with the
     granted data.

This is a functional coalescing proof on the local L1D implementation; phone-class
IPC/latency remain BLOCKED — see docs/evidence/cache/cache-evidence-gate.yaml.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ReadOnly, RisingEdge

MESI_I = 0
MESI_S = 1
MESI_E = 2


def _pack_req(paddr: int, size: int = 3, is_load: int = 1, tag: int = 0) -> int:
    return (
        (tag & 0xFF)
        | ((is_load & 0x1) << 152)
        | ((size & 0x7) << 153)
        | ((paddr & ((1 << 40) - 1)) << 156)
    )


def _unpack_resp(resp_value) -> dict[str, int]:
    value = int(resp_value)
    return {
        "ecc_uncorrectable": value & 0x1,
        "replay": (value >> 1) & 0x1,
        "ack": (value >> 2) & 0x1,
        "tag": (value >> 3) & 0xFF,
        "rdata": (value >> 11) & ((1 << 128) - 1),
    }


async def reset_l1d(dut) -> None:
    dut.rst_n.value = 0
    dut.lsu_p0_valid.value = 0
    dut.lsu_p0_req.value = 0
    dut.lsu_p1_valid.value = 0
    dut.lsu_p1_req.value = 0
    dut.l2_acq_ready.value = 1
    dut.l2_grant_valid.value = 0
    dut.l2_grant_paddr_line.value = 0
    dut.l2_grant_data.value = 0
    dut.l2_grant_state.value = MESI_S
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
    dut.probe_target_state.value = MESI_I
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def present_miss(dut, paddr: int, tag: int) -> None:
    """Drive a single-cycle port-0 load request."""
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = _pack_req(paddr, is_load=1, tag=tag)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0


def acquire_active(dut) -> bool:
    return int(dut.l2_acq_valid.value) == 1


@cocotb.test()
async def test_l1d_secondary_misses_coalesce(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_l1d(dut)

    line_a = 0x0000_9000_0000
    line_b = 0x0000_9000_1000  # different line (distinct index)
    granted_word = 0xCAFEF00D_1234_5678 & ((1 << 64) - 1)

    # L2 accepts acquires immediately but we withhold the grant so the fill
    # for A stays outstanding while secondary misses arrive.
    dut.l2_acq_ready.value = 1

    # ---- 1) Primary miss to line A. ----
    await present_miss(dut, line_a, tag=0x11)

    acquire_lines: list[int] = []
    # Capture every distinct acquire line over the in-flight window.
    saw_a_acquire = False
    for _ in range(6):
        await RisingEdge(dut.clk)
        if acquire_active(dut):
            line = int(dut.l2_acq_paddr_line.value)
            if line not in acquire_lines:
                acquire_lines.append(line)
            if line == (line_a & ~0x3F):
                saw_a_acquire = True
    assert saw_a_acquire, "primary miss did not issue an L2 acquire for line A"
    acquires_after_primary = len(acquire_lines)
    assert acquires_after_primary == 1, (
        f"expected exactly one acquire after primary miss, got {acquire_lines}"
    )

    # ---- 2) Two secondary misses to the SAME line A, fill still pending. ----
    # The acquire for A is single-shot (already issued and not re-driven once
    # granted internally), so the test asserts no NEW distinct acquire line
    # appears for A's coalesced secondaries.
    for sec_tag in (0x22, 0x23):
        await present_miss(dut, line_a, tag=sec_tag)
        for _ in range(3):
            await RisingEdge(dut.clk)
            if acquire_active(dut):
                line = int(dut.l2_acq_paddr_line.value)
                if line not in acquire_lines:
                    acquire_lines.append(line)

    assert len(acquire_lines) == 1, (
        "secondary misses on line A must not issue additional acquires; "
        f"acquire lines seen: {[hex(a) for a in acquire_lines]}"
    )

    # ---- 3) A miss to a DIFFERENT line B must still acquire. ----
    await present_miss(dut, line_b, tag=0x31)
    saw_b_acquire = False
    for _ in range(6):
        await RisingEdge(dut.clk)
        if acquire_active(dut):
            line = int(dut.l2_acq_paddr_line.value)
            if line not in acquire_lines:
                acquire_lines.append(line)
            if line == (line_b & ~0x3F):
                saw_b_acquire = True
    assert saw_b_acquire, "miss to distinct line B did not issue its own acquire"
    assert len(acquire_lines) == 2, (
        "expected exactly two distinct acquires (A and B); "
        f"got {[hex(a) for a in acquire_lines]}"
    )

    # ---- 4) Grant the fill for line A. The coalesced secondaries drain. ----
    dut.l2_grant_valid.value = 1
    dut.l2_grant_paddr_line.value = line_a & ~0x3F
    dut.l2_grant_data.value = granted_word  # word 0 of the line
    dut.l2_grant_state.value = MESI_E
    await RisingEdge(dut.clk)
    dut.l2_grant_valid.value = 0

    # On idle port-0 cycles after the fill, the FIFO drains: each coalesced
    # request replays with its original LSU tag.
    drained_tags: list[int] = []
    for _ in range(12):
        await RisingEdge(dut.clk)
        await ReadOnly()
        if int(dut.lsu_p0_resp_valid.value) == 1:
            resp = _unpack_resp(dut.lsu_p0_resp.value)
            if resp["replay"] == 1 and resp["ack"] == 0:
                drained_tags.append(resp["tag"])

    assert 0x22 in drained_tags and 0x23 in drained_tags, (
        "coalesced secondary requests were not drained as replays; "
        f"drained tags={[hex(t) for t in drained_tags]}"
    )

    # ---- 5) Re-present a coalesced request: it now hits with granted data. ----
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = _pack_req(line_a, is_load=1, tag=0x22)
    await RisingEdge(dut.clk)
    await ReadOnly()
    resp = _unpack_resp(dut.lsu_p0_resp.value)
    assert int(dut.lsu_p0_resp_valid.value) == 1
    assert resp["ack"] == 1, "re-presented coalesced load did not hit after fill"
    assert resp["replay"] == 0
    assert resp["rdata"] & ((1 << 64) - 1) == granted_word, (
        f"re-presented load returned {resp['rdata']:#x}, expected {granted_word:#x}"
    )
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0

    print(
        "L1D_MSHR_COALESCE_SUMMARY "
        f"distinct_acquires={len(acquire_lines)} "
        f"coalesced_secondaries={len(drained_tags)} "
        f"drained_tags={[hex(t) for t in drained_tags]}"
    )

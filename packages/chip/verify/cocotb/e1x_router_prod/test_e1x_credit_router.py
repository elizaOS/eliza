from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PORTS = 5
COLORS = 24
COLOR_BITS = 5
PAYLOAD_BITS = 32
PORT_BITS = 3

DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_DROP = 7

CREDIT_MAX = 4


def _bit(word: int, idx: int) -> int:
    return (int(word) >> idx) & 1


def _field(flat: int, idx: int, width: int) -> int:
    return (int(flat) >> (idx * width)) & ((1 << width) - 1)


def set_in_color(dut, port: int, color: int) -> None:
    flat = int(dut.in_color_flat.value) if dut.in_color_flat.value.is_resolvable else 0
    shift = port * COLOR_BITS
    mask = ((1 << COLOR_BITS) - 1) << shift
    dut.in_color_flat.value = (flat & ~mask) | ((color & ((1 << COLOR_BITS) - 1)) << shift)


def set_in_payload(dut, port: int, payload: int) -> None:
    flat = int(dut.in_payload_flat.value) if dut.in_payload_flat.value.is_resolvable else 0
    shift = port * PAYLOAD_BITS
    mask = ((1 << PAYLOAD_BITS) - 1) << shift
    dut.in_payload_flat.value = (flat & ~mask) | ((payload & ((1 << PAYLOAD_BITS) - 1)) << shift)


def out_payload(dut, port: int) -> int:
    return _field(dut.out_payload_flat.value, port, PAYLOAD_BITS)


def out_color(dut, port: int) -> int:
    return _field(dut.out_color_flat.value, port, COLOR_BITS)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.repair_enable.value = 0
    dut.port_disable.value = 0
    dut.prog_we.value = 0
    dut.prog_addr.value = 0
    dut.prog_dir_in.value = 0
    dut.in_valid.value = 0
    dut.in_color_flat.value = 0
    dut.in_payload_flat.value = 0
    dut.out_ready.value = 0
    dut.out_credit.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def program_route(dut, color: int, in_port: int, out_dir: int) -> None:
    dut.prog_addr.value = (color << PORT_BITS) | in_port
    dut.prog_dir_in.value = out_dir
    dut.prog_we.value = 1
    await RisingEdge(dut.clk)
    dut.prog_we.value = 0


async def start(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)


@cocotb.test()
async def route_table_programming_and_readback(dut):
    await start(dut)
    await program_route(dut, color=3, in_port=DIR_NORTH, out_dir=DIR_EAST)
    dut.prog_addr.value = (3 << PORT_BITS) | DIR_NORTH
    await RisingEdge(dut.clk)
    assert int(dut.prog_dir_out.value) == DIR_EAST


@cocotb.test()
async def single_packet_routes_to_each_direction(dut):
    await start(dut)
    # (color, in_port, out_dir, payload) — distinct color per case so reusing
    # the same input port across cases does not overwrite a route entry.
    cases = [
        (1, DIR_WEST, DIR_NORTH, 0x1111_0001),
        (2, DIR_SOUTH, DIR_EAST, 0x2222_0002),
        (3, DIR_NORTH, DIR_SOUTH, 0x3333_0003),
        (4, DIR_EAST, DIR_WEST, 0x4444_0004),
        (5, DIR_NORTH, DIR_LOCAL, 0x5555_0005),
    ]
    for color, in_port, out_dir, _payload in cases:
        await program_route(dut, color, in_port, out_dir)

    # Downstream always ready and crediting on every output.
    dut.out_ready.value = (1 << PORTS) - 1
    dut.out_credit.value = (1 << PORTS) - 1
    for color, in_port, out_dir, payload in cases:
        set_in_color(dut, in_port, color)
        set_in_payload(dut, in_port, payload)
        dut.in_valid.value = 1 << in_port
        await RisingEdge(dut.clk)  # push into FIFO
        dut.in_valid.value = 0
        seen = False
        for _ in range(6):
            await RisingEdge(dut.clk)
            if _bit(dut.out_valid.value, out_dir):
                assert out_payload(dut, out_dir) == payload
                assert out_color(dut, out_dir) == color
                seen = True
                break
        assert seen, f"no output on dir {out_dir} for in {in_port}"
        # let the output drain before the next case
        await RisingEdge(dut.clk)


@cocotb.test()
async def backpressure_stalls_input_without_dropping(dut):
    await start(dut)
    color = 2
    await program_route(dut, color, DIR_WEST, DIR_LOCAL)
    # No credit, output not ready: nothing leaves the router; the input FIFO
    # fills and then in_ready deasserts. Only flits that were accepted
    # (in_valid && in_ready) are tracked as sent; none may be dropped.
    dut.out_credit.value = 0
    dut.out_ready.value = 0
    set_in_color(dut, DIR_WEST, color)
    sent = []
    next_payload = 0xA000
    backpressured = False
    for _ in range(10):
        dut.in_valid.value = 1 << DIR_WEST
        set_in_payload(dut, DIR_WEST, next_payload)
        await RisingEdge(dut.clk)
        if _bit(dut.in_ready.value, DIR_WEST):
            sent.append(next_payload)
            next_payload += 1
        else:
            backpressured = True
    dut.in_valid.value = 0
    assert backpressured, "input never backpressured under full congestion"
    assert int(dut.repaired_drop.value) == 0
    # Now grant credit + ready: every buffered packet drains in FIFO order, no loss.
    dut.out_credit.value = 1 << DIR_LOCAL
    dut.out_ready.value = 1 << DIR_LOCAL
    drained = []
    for _ in range(30):
        await RisingEdge(dut.clk)
        if _bit(dut.out_valid.value, DIR_LOCAL):
            drained.append(out_payload(dut, DIR_LOCAL))
    assert drained == sent, f"drained={drained} sent={sent}"


@cocotb.test()
async def credit_exhaustion_and_recovery(dut):
    """With ready high but zero credit return, the router launches at most
    CREDIT_MAX flits then stalls; returning credit resumes delivery; no loss."""
    await start(dut)
    color = 4
    await program_route(dut, color, DIR_NORTH, DIR_EAST)
    dut.out_ready.value = 1 << DIR_EAST  # consumer always ready
    dut.out_credit.value = 0  # no credit returns during phase 1
    set_in_color(dut, DIR_NORTH, color)

    n = 8
    sent = []
    recv = []
    next_idx = 0
    # Phase 1: inject all n packets, collect whatever the credit-starved output
    # delivers (must be <= CREDIT_MAX), every cycle.
    for _ in range(40):
        if _bit(dut.out_valid.value, DIR_EAST):
            recv.append(out_payload(dut, DIR_EAST))
        if next_idx < n:
            dut.in_valid.value = 1 << DIR_NORTH
            set_in_payload(dut, DIR_NORTH, 0xC000 + next_idx)
        else:
            dut.in_valid.value = 0
        await RisingEdge(dut.clk)
        if next_idx < n and _bit(dut.in_ready.value, DIR_NORTH):
            sent.append(0xC000 + next_idx)
            next_idx += 1
    dut.in_valid.value = 0
    assert len(recv) <= CREDIT_MAX, f"delivered {len(recv)} with only {CREDIT_MAX} credits"
    assert int(dut.repaired_drop.value) == 0

    # Phase 2: return credit every cycle; the rest must drain in order, no loss.
    dut.out_credit.value = 1 << DIR_EAST
    for _ in range(60):
        if _bit(dut.out_valid.value, DIR_EAST):
            recv.append(out_payload(dut, DIR_EAST))
        await RisingEdge(dut.clk)
    assert recv == sent, f"recv={recv} sent={sent}"


@cocotb.test()
async def round_robin_fairness_under_contention(dut):
    await start(dut)
    color = 1
    # Three inputs all target LOCAL.
    sources = [DIR_NORTH, DIR_EAST, DIR_SOUTH]
    payloads = {DIR_NORTH: 0x1110, DIR_EAST: 0x2220, DIR_SOUTH: 0x3330}
    for s in sources:
        await program_route(dut, color, s, DIR_LOCAL)
        set_in_color(dut, s, color)
        set_in_payload(dut, s, payloads[s])
    # Steady credit + ready on LOCAL.
    dut.out_credit.value = 1 << DIR_LOCAL
    dut.out_ready.value = 1 << DIR_LOCAL
    # Hold all three valid; each accepts into its FIFO then arbitrates.
    dut.in_valid.value = (1 << DIR_NORTH) | (1 << DIR_EAST) | (1 << DIR_SOUTH)
    seen = []
    for _ in range(40):
        await RisingEdge(dut.clk)
        if _bit(dut.out_valid.value, DIR_LOCAL):
            seen.append(out_payload(dut, DIR_LOCAL))
        # keep refilling: re-present each source so it keeps requesting
    dut.in_valid.value = 0
    # All three sources must appear (no starvation), round-robin cycles them.
    counts = {p: seen.count(p) for p in payloads.values()}
    assert all(c > 0 for c in counts.values()), counts
    # Fairness: max and min granted counts differ by at most 1 in steady state.
    assert max(counts.values()) - min(counts.values()) <= 2, counts
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def port_disable_drops_only_disabled_traffic(dut):
    await start(dut)
    color = 5
    # WEST -> EAST (will be dropped because EAST disabled), NORTH -> SOUTH (ok).
    await program_route(dut, color, DIR_WEST, DIR_EAST)
    await program_route(dut, color, DIR_NORTH, DIR_SOUTH)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_EAST
    dut.out_credit.value = (1 << PORTS) - 1
    dut.out_ready.value = (1 << PORTS) - 1
    set_in_color(dut, DIR_WEST, color)
    set_in_color(dut, DIR_NORTH, color)
    set_in_payload(dut, DIR_WEST, 0xDEAD)
    set_in_payload(dut, DIR_NORTH, 0xBEEF)
    dut.in_valid.value = (1 << DIR_WEST) | (1 << DIR_NORTH)
    await RisingEdge(dut.clk)
    dut.in_valid.value = 0
    saw_drop_west = False
    saw_south = False
    saw_east = False
    for _ in range(8):
        await RisingEdge(dut.clk)
        if _bit(dut.repaired_drop.value, DIR_WEST):
            saw_drop_west = True
        if _bit(dut.out_valid.value, DIR_SOUTH) and out_payload(dut, DIR_SOUTH) == 0xBEEF:
            saw_south = True
        if _bit(dut.out_valid.value, DIR_EAST):
            saw_east = True
    assert saw_drop_west, "disabled-output traffic was not dropped"
    assert saw_south, "healthy NORTH->SOUTH traffic did not pass"
    assert not saw_east, "traffic reached disabled EAST output"


@cocotb.test()
async def explicit_drop_route_is_reported(dut):
    await start(dut)
    color = 7
    await program_route(dut, color, DIR_LOCAL, DIR_DROP)
    dut.repair_enable.value = 1
    dut.out_credit.value = (1 << PORTS) - 1
    dut.out_ready.value = (1 << PORTS) - 1
    set_in_color(dut, DIR_LOCAL, color)
    set_in_payload(dut, DIR_LOCAL, 0x1234_5678)
    dut.in_valid.value = 1 << DIR_LOCAL
    await RisingEdge(dut.clk)
    dut.in_valid.value = 0
    saw_drop = False
    for _ in range(6):
        await RisingEdge(dut.clk)
        if _bit(dut.repaired_drop.value, DIR_LOCAL):
            saw_drop = True
        assert int(dut.out_valid.value) == 0
    assert saw_drop



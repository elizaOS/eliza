from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

ROWS = 4
COLS = 4
PORTS = 5
PORT_BITS = 3
PAYLOAD_BITS = 32

DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_DROP = 7

# opposite[d] = the port a flit leaving on d arrives on at the neighbour.
OPPOSITE = {
    DIR_NORTH: DIR_SOUTH,
    DIR_SOUTH: DIR_NORTH,
    DIR_EAST: DIR_WEST,
    DIR_WEST: DIR_EAST,
}


def node(row: int, col: int) -> int:
    return row * COLS + col


def xy_out_dir(row: int, col: int, dest_row: int, dest_col: int) -> int:
    """Strict XY dimension-order routing: resolve column (X) first, then row."""
    if col < dest_col:
        return DIR_EAST
    if col > dest_col:
        return DIR_WEST
    if row < dest_row:
        return DIR_SOUTH
    if row > dest_row:
        return DIR_NORTH
    return DIR_LOCAL


def xy_path_nodes(src_row, src_col, dst_row, dst_col):
    """List of (row, col, in_port, out_dir) router visits for an XY path."""
    visits = []
    row, col = src_row, src_col
    in_port = DIR_LOCAL  # injected at the source Local port
    while True:
        out_dir = xy_out_dir(row, col, dst_row, dst_col)
        visits.append((row, col, in_port, out_dir))
        if out_dir == DIR_LOCAL:
            break
        if out_dir == DIR_EAST:
            col += 1
        elif out_dir == DIR_WEST:
            col -= 1
        elif out_dir == DIR_SOUTH:
            row += 1
        elif out_dir == DIR_NORTH:
            row -= 1
        in_port = OPPOSITE[out_dir]
    return visits


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.prog_we.value = 0
    dut.prog_node_row.value = 0
    dut.prog_node_col.value = 0
    dut.prog_addr.value = 0
    dut.prog_dir.value = 0
    dut.inj_node.value = 0
    dut.inj_valid.value = 0
    dut.inj_color.value = 0
    dut.inj_payload.value = 0
    dut.eject_ready_flat.value = 0
    dut.core_enable_flat.value = 0
    dut.core_boot_en_flat.value = 0
    dut.core_instr_valid_flat.value = 0
    dut.core_instr.value = 0
    dut.core_boot_pc.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def program_route(dut, row, col, color, in_port, out_dir) -> None:
    dut.prog_node_row.value = row
    dut.prog_node_col.value = col
    dut.prog_addr.value = (color << PORT_BITS) | in_port
    dut.prog_dir.value = out_dir
    dut.prog_we.value = 1
    await RisingEdge(dut.clk)
    dut.prog_we.value = 0


def eject_valid(dut, n: int) -> int:
    return (int(dut.eject_valid_flat.value) >> n) & 1


def eject_payload(dut, n: int) -> int:
    flat = int(dut.eject_payload_flat.value)
    return (flat >> (n * PAYLOAD_BITS)) & ((1 << PAYLOAD_BITS) - 1)


def set_eject_ready(dut, n: int, ready: bool) -> None:
    val = int(dut.eject_ready_flat.value)
    if ready:
        val |= 1 << n
    else:
        val &= ~(1 << n)
    dut.eject_ready_flat.value = val


async def run_delivery(dut, src, dst, color, n_packets, base_payload):
    """Program an XY path from src to dst, inject a burst at src Local, and
    collect everything ejected at dst Local. Returns (sent, recv)."""
    src_row, src_col = src
    dst_row, dst_col = dst
    dst_n = node(dst_row, dst_col)

    visits = xy_path_nodes(src_row, src_col, dst_row, dst_col)
    for (row, col, in_port, out_dir) in visits:
        await program_route(dut, row, col, color, in_port, out_dir)

    set_eject_ready(dut, dst_n, True)
    dut.inj_node.value = node(src_row, src_col)
    dut.inj_color.value = color

    sent: list[int] = []
    recv: list[int] = []
    send_i = 0
    # Generous cap: credited multi-hop links throttle injection, so keep
    # offering until every packet is accepted (or the safety cap trips).
    safety_cap = 200 + n_packets * 40
    for _ in range(safety_cap):
        if eject_valid(dut, dst_n) and ((int(dut.eject_ready_flat.value) >> dst_n) & 1):
            recv.append(eject_payload(dut, dst_n))
        if send_i < n_packets:
            dut.inj_payload.value = base_payload + send_i
            dut.inj_valid.value = 1
        else:
            dut.inj_valid.value = 0
        await RisingEdge(dut.clk)
        if send_i < n_packets and int(dut.inj_ready.value):
            sent.append(base_payload + send_i)
            send_i += 1
        if send_i >= n_packets and len(recv) >= n_packets:
            break

    dut.inj_valid.value = 0
    for _ in range(120):
        if eject_valid(dut, dst_n) and ((int(dut.eject_ready_flat.value) >> dst_n) & 1):
            recv.append(eject_payload(dut, dst_n))
        await RisingEdge(dut.clk)
        if len(recv) >= n_packets:
            break

    set_eject_ready(dut, dst_n, False)
    return sent, recv


SRAM_BYTES = 48 * 1024
WAVELET_TX_DATA = SRAM_BYTES + 0x10

OPIMM, OP, STORE, LUI = 0x13, 0x33, 0x23, 0x37
ECALL = 0x0000_0073


def _addi(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | OPIMM


def _lui(rd, imm20):
    return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | LUI


def _sw(rs2, rs1, imm):
    imm &= 0xFFF
    return ((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (0x2 << 12) | ((imm & 0x1F) << 7) | STORE


async def boot_one_core(dut, src_n, program, boot_pc=0):
    """Stream a program into node src_n's PE local SRAM, then start it. The
    instruction word is broadcast; only the target node's boot_en/instr_valid
    are asserted so only it loads + runs."""
    dut.core_boot_pc.value = boot_pc
    dut.core_boot_en_flat.value = 1 << src_n
    for word in program:
        dut.core_instr.value = word & 0xFFFFFFFF
        dut.core_instr_valid_flat.value = 1 << src_n
        await RisingEdge(dut.clk)
    dut.core_instr_valid_flat.value = 0
    await RisingEdge(dut.clk)
    dut.core_boot_en_flat.value = 0
    dut.core_enable_flat.value = 1 << src_n
    await RisingEdge(dut.clk)


@cocotb.test()
async def real_pe_core_emits_wavelet_routed_across_mesh(dut):
    """A real RV64IM PE core at node (1,1) boots a program that launches a
    wavelet onto the fabric via its TX MMIO. The mesh routes that wavelet XY to
    node (1,3) where it is ejected. Proves the integrated PE core + credit-router
    mesh exchange real wavelets, not just TB-injected flits."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.core_enable_flat.value = 0
    dut.core_boot_en_flat.value = 0
    dut.core_instr_valid_flat.value = 0
    dut.core_instr.value = 0
    dut.core_boot_pc.value = 0

    src = (1, 1)
    dst = (1, 3)
    # PE-core egress wavelets carry routing color 0 (the core emits a payload
    # only; the tile drives the Local input color to 0), so the whole XY path is
    # programmed on color 0.
    color = 0
    src_n = node(*src)
    dst_n = node(*dst)

    # XY path from the source Local egress: at (1,1) the wavelet enters on Local
    # and must head East twice to reach column 3, then Local at (1,3).
    for (row, col, in_port, out_dir) in xy_path_nodes(src[0], src[1], dst[0], dst[1]):
        await program_route(dut, row, col, color, in_port, out_dir)

    set_eject_ready(dut, dst_n, True)

    payload = 0x33
    prog = [
        _lui(1, SRAM_BYTES >> 12),  # x1 = MMIO base
        _addi(2, 0, payload),       # x2 = payload
        _sw(2, 1, 0x10),            # WAVELET_TX_DATA = x2  -> launch wavelet
        ECALL,
    ]
    await boot_one_core(dut, src_n, prog, boot_pc=0)

    recv = []
    for _ in range(400):
        if eject_valid(dut, dst_n) and ((int(dut.eject_ready_flat.value) >> dst_n) & 1):
            recv.append(eject_payload(dut, dst_n))
        await RisingEdge(dut.clk)
        if recv:
            break

    set_eject_ready(dut, dst_n, False)
    assert recv == [payload], f"PE-core wavelet not delivered across mesh: recv={recv}"


@cocotb.test()
async def multi_hop_corner_to_corner_lossless(dut):
    """Inject a burst at node (0,0), route XY across the full 4x4 mesh to node
    (3,3) — six router hops — and confirm every packet is delivered in order
    with zero loss through the production credit routers."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    n = 12
    sent, recv = await run_delivery(dut, (0, 0), (3, 3), color=2, n_packets=n, base_payload=0xA000)
    assert sent == [0xA000 + i for i in range(n)], sent
    assert recv == sent, f"recv={recv} sent={sent}"


@cocotb.test()
async def multi_hop_row_then_column_path(dut):
    """A path that turns: (1,0) -> (1,3) east, then -> (3,3) south. Exercises an
    X-then-Y turn (the only turn class XY routing allows) across five hops."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    n = 8
    sent, recv = await run_delivery(dut, (1, 0), (3, 3), color=5, n_packets=n, base_payload=0xB100)
    assert sent == [0xB100 + i for i in range(n)], sent
    assert recv == sent, f"recv={recv} sent={sent}"


@cocotb.test()
async def two_independent_colors_share_mesh(dut):
    """Two disjoint XY flows on different colors deliver independently: a
    west-bound flow (0,3)->(0,0) on color 1 and a south-bound flow (0,1)->(3,1)
    on color 7. Each arrives complete and in order."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    n_a = 6
    sent_a, recv_a = await run_delivery(dut, (0, 3), (0, 0), color=1, n_packets=n_a, base_payload=0xC200)
    assert sent_a == [0xC200 + i for i in range(n_a)], sent_a
    assert recv_a == sent_a, f"recv_a={recv_a} sent_a={sent_a}"

    n_b = 6
    sent_b, recv_b = await run_delivery(dut, (0, 1), (3, 1), color=7, n_packets=n_b, base_payload=0xD300)
    assert sent_b == [0xD300 + i for i in range(n_b)], sent_b
    assert recv_b == sent_b, f"recv_b={recv_b} sent_b={sent_b}"

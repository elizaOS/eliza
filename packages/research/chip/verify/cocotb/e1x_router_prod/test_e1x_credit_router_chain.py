from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PORT_BITS = 3
DIR_EAST = 1
DIR_LOCAL = 4
DIR_WEST = 3


@cocotb.test()
async def two_router_chain_burst_no_loss(dut):
    """Route W->E on router A and W->Local on router B, push a 12-packet burst
    across the credited A-East -> B-West link, and confirm every packet arrives
    in order with no loss."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    dut.rst_n.value = 0
    dut.prog_we.value = 0
    dut.prog_addr.value = 0
    dut.prog_dir_in.value = 0
    dut.prog_sel_b.value = 0
    dut.a_in_valid.value = 0
    dut.a_in_color.value = 0
    dut.a_in_payload.value = 0
    dut.b_out_ready.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)

    color = 1

    async def prog(sel_b: int, in_port: int, out_dir: int) -> None:
        dut.prog_sel_b.value = sel_b
        dut.prog_addr.value = (color << PORT_BITS) | in_port
        dut.prog_dir_in.value = out_dir
        dut.prog_we.value = 1
        await RisingEdge(dut.clk)
        dut.prog_we.value = 0
        dut.prog_sel_b.value = 0

    await prog(0, DIR_WEST, DIR_EAST)  # router A: West in -> East out
    await prog(1, DIR_WEST, DIR_LOCAL)  # router B: West in -> Local out

    dut.b_out_ready.value = 1
    dut.a_in_color.value = color

    n = 12
    sent: list[int] = []
    recv: list[int] = []
    send_i = 0
    for _ in range(160):
        if int(dut.b_out_valid.value) and int(dut.b_out_ready.value):
            recv.append(int(dut.b_out_payload.value))
        if send_i < n:
            dut.a_in_payload.value = 0x7000 + send_i
            dut.a_in_valid.value = 1
        else:
            dut.a_in_valid.value = 0
        await RisingEdge(dut.clk)
        if send_i < n and int(dut.a_in_ready.value):
            sent.append(0x7000 + send_i)
            send_i += 1

    dut.a_in_valid.value = 0
    for _ in range(60):
        if int(dut.b_out_valid.value) and int(dut.b_out_ready.value):
            recv.append(int(dut.b_out_payload.value))
        await RisingEdge(dut.clk)

    assert sent == [0x7000 + i for i in range(n)], sent
    assert recv == sent, f"recv={recv} sent={sent}"

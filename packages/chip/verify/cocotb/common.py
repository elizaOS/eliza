"""Shared cocotb helpers for the simple register-port DUT family.

The e1 NPU, DMA, and display blocks expose the same lightweight register
interface — a single ``valid``/``write``/``addr``/``wdata``/``rdata`` port
clocked by ``clk`` and reset by ``rst_n``. Their cocotb suites previously
each redefined identical ``reset`` / ``write_reg`` / ``read_reg`` helpers and
the pure ``word_read`` / ``word_write`` byte-memory functions (dossier item
§3.4 H26). The canonical versions live here.

These helpers are deliberately scoped to the simple register interface.
DUTs with different port shapes (the chip-level JTAG/debug bus, the SoC MMIO
port, the full AXI-Lite CPU port) keep their own access helpers because the
handshake differs — consolidating them would hide real protocol differences.
"""

from __future__ import annotations

from cocotb.triggers import RisingEdge, Timer

# Optional AXI-Lite master sideband present on the NPU/DMA register DUTs. When
# the DUT exposes these ports, reset drives them to a safe idle.
_AXIL_IDLE = (
    ("m_axil_awready", 0),
    ("m_axil_wready", 0),
    ("m_axil_bvalid", 0),
    ("m_axil_bresp", 0),
    ("m_axil_arready", 0),
    ("m_axil_rvalid", 0),
    ("m_axil_rdata", 0),
    ("m_axil_rresp", 0),
)


async def reset(dut, *, cycles: int = 4, axil_ready: int = 0):
    """Assert ``rst_n`` for ``cycles`` clocks, then release.

    Drives the register port to idle. If the DUT exposes an AXI-Lite master
    sideband (``m_axil_*``), those inputs are tied to a safe idle; pass
    ``axil_ready=1`` to hold the downstream ``*ready`` lines high (used by the
    DMA long-transfer model that always accepts).
    """
    dut.rst_n.value = 0
    dut.valid.value = 0
    dut.write.value = 0
    dut.addr.value = 0
    dut.wdata.value = 0
    if hasattr(dut, "m_axil_arready"):
        for name, value in _AXIL_IDLE:
            getattr(dut, name).value = value
        if axil_ready:
            dut.m_axil_awready.value = 1
            dut.m_axil_wready.value = 1
            dut.m_axil_arready.value = 1
    await Timer(1, units="ns")
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def write_reg(dut, addr, data):
    """Single-cycle register write over the ``valid``/``write`` port."""
    dut.addr.value = addr
    dut.wdata.value = data
    dut.write.value = 1
    dut.valid.value = 1
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    dut.write.value = 0
    await Timer(1, units="ns")


async def read_reg(dut, addr):
    """Combinational-read register access; returns the latched ``rdata``."""
    dut.addr.value = addr
    dut.write.value = 0
    dut.valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.rdata.value)
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    await Timer(1, units="ns")
    return value


def word_read(mem: dict[int, int], addr: int) -> int:
    """Read a little-endian 32-bit word from a byte-addressed dict memory."""
    base = addr & ~0x3
    value = 0
    for byte in range(4):
        value |= mem.get(base + byte, 0) << (8 * byte)
    return value


def word_write(mem: dict[int, int], addr: int, data: int, strobe: int) -> None:
    """Write a little-endian 32-bit word into a byte-addressed dict memory,
    honoring the 4-bit byte ``strobe``."""
    base = addr & ~0x3
    for byte in range(4):
        if strobe & (1 << byte):
            mem[base + byte] = (data >> (8 * byte)) & 0xFF

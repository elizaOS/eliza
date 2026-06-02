"""CPU -> peripheral AXI-Lite/MMIO path test.

Proves the regression fixed by the cpu-axil-master-tied-off-in-tapeout-top
blocker: the CVA6 AXI-Lite master is no longer hard tied off to 0xDEAD_BEEF /
SLVERR. A CPU-side AXI4 read/write (through e1_cpu_axi_bridge -> e1_axil_to_mmio
-> e1_mmio_arb2 -> the real peripheral fabric) reaches real peripherals and
returns a real OKAY response with real data.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# v0 MMIO map (matches e1_mmio_decode).
BOOTROM_ID_ADDR = 0x0000_0000  # ROM identity header word 0 ("OSO\0")
PERIPH_ID_ADDR = 0x1000_0000  # peripheral ID register -> 0x1000_0001
PERIPH_GPIO_ADDR = 0x1000_0008  # GPIO out (addr word 0x02)
NPU_ID_ADDR = 0x1002_0000  # NPU CSR base

AXI_RESP_OKAY = 0b00
AXI_RESP_SLVERR = 0b10


async def reset(dut):
    dut.rst_n.value = 0
    dut.cpu_ar_id.value = 0
    dut.cpu_ar_addr.value = 0
    dut.cpu_ar_valid.value = 0
    dut.cpu_r_ready.value = 0
    dut.cpu_aw_id.value = 0
    dut.cpu_aw_addr.value = 0
    dut.cpu_aw_valid.value = 0
    dut.cpu_w_data.value = 0
    dut.cpu_w_strb.value = 0
    dut.cpu_w_valid.value = 0
    dut.cpu_b_ready.value = 0
    dut.dbg_valid.value = 0
    dut.dbg_write.value = 0
    dut.dbg_addr.value = 0
    dut.dbg_wdata.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def cpu_read64(dut, addr, timeout=256):
    """Issue a 64-bit AXI4 read as the CVA6 would; return (data, resp)."""
    dut.cpu_ar_id.value = 0
    dut.cpu_ar_addr.value = addr & ~0x7  # bridge reads the 8-byte-aligned dword
    dut.cpu_ar_valid.value = 1
    dut.cpu_r_ready.value = 1
    # Wait for AR handshake.
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        if dut.cpu_ar_ready.value == 1:
            break
    else:
        raise TimeoutError("AR handshake never completed")
    dut.cpu_ar_valid.value = 0
    # Wait for R response.
    for _ in range(timeout):
        if dut.cpu_r_valid.value == 1 and dut.cpu_r_ready.value == 1:
            data = int(dut.cpu_r_data.value)
            resp = int(dut.cpu_r_resp.value)
            await RisingEdge(dut.clk)
            dut.cpu_r_ready.value = 0
            return data, resp
        await RisingEdge(dut.clk)
    raise TimeoutError("R response never arrived")


async def cpu_read32(dut, addr):
    """Read the addressed 32-bit word out of the 64-bit AXI4 beat."""
    data64, resp = await cpu_read64(dut, addr)
    word = (data64 >> 32) if (addr & 0x4) else (data64 & 0xFFFF_FFFF)
    return word & 0xFFFF_FFFF, resp


async def cpu_write32(dut, addr, value, timeout=256):
    """Issue a 64-bit AXI4 write placing `value` in the addressed word."""
    aligned = addr & ~0x7
    if addr & 0x4:
        wdata = (value & 0xFFFF_FFFF) << 32
        wstrb = 0xF0
    else:
        wdata = value & 0xFFFF_FFFF
        wstrb = 0x0F
    dut.cpu_aw_id.value = 0
    dut.cpu_aw_addr.value = aligned
    dut.cpu_aw_valid.value = 1
    dut.cpu_w_data.value = wdata
    dut.cpu_w_strb.value = wstrb
    dut.cpu_w_valid.value = 1
    dut.cpu_b_ready.value = 1
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        if dut.cpu_aw_ready.value == 1 and dut.cpu_w_ready.value == 1:
            break
    else:
        raise TimeoutError("AW/W handshake never completed")
    dut.cpu_aw_valid.value = 0
    dut.cpu_w_valid.value = 0
    for _ in range(timeout):
        if dut.cpu_b_valid.value == 1 and dut.cpu_b_ready.value == 1:
            resp = int(dut.cpu_b_resp.value)
            await RisingEdge(dut.clk)
            dut.cpu_b_ready.value = 0
            return resp
        await RisingEdge(dut.clk)
    raise TimeoutError("B response never arrived")


async def dbg_read32(dut, addr, timeout=64):
    """Drive the external debug MMIO master (arbiter port 0)."""
    dut.dbg_addr.value = addr
    dut.dbg_write.value = 0
    dut.dbg_valid.value = 1
    for _ in range(timeout):
        await Timer(1, units="ns")
        if dut.dbg_ready.value == 1:
            value = int(dut.dbg_rdata.value)
            await RisingEdge(dut.clk)
            dut.dbg_valid.value = 0
            return value
        await RisingEdge(dut.clk)
    raise TimeoutError("debug MMIO read never completed")


@cocotb.test()
async def cpu_reads_real_peripherals(dut):
    """CPU AXI-Lite reads return real data + OKAY, never 0xDEAD_BEEF/SLVERR."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Peripheral ID register: e1_peripherals returns 0x1000_0001 at word 0.
    val, resp = await cpu_read32(dut, PERIPH_ID_ADDR)
    assert resp == AXI_RESP_OKAY, f"peripheral read RRESP={resp:#b}, expected OKAY"
    assert val == 0x1000_0001, f"peripheral ID read {val:#010x}, expected 0x10000001"
    assert val != 0xDEAD_BEEF, "CPU read returned the unmapped 0xDEAD_BEEF sentinel"

    # Bootrom identity header word 0 is the ROM magic, not 0xDEAD_BEEF.
    rom0, resp = await cpu_read32(dut, BOOTROM_ID_ADDR)
    assert resp == AXI_RESP_OKAY, f"bootrom read RRESP={resp:#b}, expected OKAY"
    assert rom0 != 0xDEAD_BEEF, "CPU bootrom read returned the unmapped sentinel value"


@cocotb.test()
async def cpu_writes_then_reads_gpio(dut):
    """CPU write reaches a real peripheral register and reads back."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    resp = await cpu_write32(dut, PERIPH_GPIO_ADDR, 0xA5)
    assert resp == AXI_RESP_OKAY, f"GPIO write BRESP={resp:#b}, expected OKAY"
    # Allow the registered GPIO write to settle.
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert int(dut.gpio_out.value) == 0xA5, (
        f"gpio_out={int(dut.gpio_out.value):#x} after CPU write, expected 0xA5"
    )
    rb, resp = await cpu_read32(dut, PERIPH_GPIO_ADDR)
    assert resp == AXI_RESP_OKAY
    assert rb == 0xA5, f"GPIO readback {rb:#x}, expected 0xA5"


@cocotb.test()
async def cpu_npu_csr_read_is_real(dut):
    """CPU read of the NPU CSR base returns a real mapped value."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    val, resp = await cpu_read32(dut, NPU_ID_ADDR)
    assert resp == AXI_RESP_OKAY, f"NPU read RRESP={resp:#b}, expected OKAY"
    assert val != 0xDEAD_BEEF, "CPU NPU CSR read returned the unmapped sentinel value"


@cocotb.test()
async def both_masters_share_fabric(dut):
    """External debug master + CPU master both reach the fabric via the arbiter."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Debug master (priority) reads the peripheral ID register.
    dbg_val = await dbg_read32(dut, PERIPH_ID_ADDR)
    assert dbg_val == 0x1000_0001, f"debug master read {dbg_val:#010x}, expected 0x10000001"

    # CPU master (lower priority) reads the same register through arbitration.
    cpu_val, resp = await cpu_read32(dut, PERIPH_ID_ADDR)
    assert resp == AXI_RESP_OKAY
    assert cpu_val == 0x1000_0001, f"CPU master read {cpu_val:#010x}, expected 0x10000001"
